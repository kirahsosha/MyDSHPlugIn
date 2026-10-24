import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import spawn from "cross-spawn";
import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * The official Copilot CLI is an agent, not a chat-completion endpoint.
 * Each call therefore starts a fresh Copilot session; the caller must put
 * everything Copilot needs into `prompt`.
 */
export const name = "copilot-bridge";
export const inject = ["tools"];

const DEFAULTS = {
  command: "copilot",
  // CLI model id for the display name "MAI-Code-1.1-Flash".
  // An empty string means "do not pass --model".
  defaultModel: "mai-code-1.1-flash",
  reasoningEffort: "medium",
  defaultAgent: "",
  timeoutMs: 300_000,
  promptMaxBytes: 16_000,
  maxOutputBytes: 65_536,
  trustFolder: false
};

const ACCESS = new Set(["read", "write", "shell"]);
const MODES = new Set(["ask", "agent", "plan"]);
const EFFORTS = new Set(["low", "medium", "high"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MODEL_UNAVAILABLE = /Model\s+"[^"]+"\s+from\s+--model\s+flag\s+is\s+not\s+available/iu;

function finiteNumber(value, fallback, min, max) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, number));
}

function configuredString(input, key, fallback) {
  if (!Object.hasOwn(input, key)) return fallback;
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeConfig(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const effort = typeof input.reasoningEffort === "string"
    ? input.reasoningEffort.trim().toLowerCase()
    : "";
  const configuredDefault = Object.hasOwn(input, "defaultModel")
    ? input.defaultModel
    : Object.hasOwn(input, "model")
      ? input.model
      : DEFAULTS.defaultModel;
  const defaultModel = configuredDefault === undefined || configuredDefault === null
    ? ""
    : String(configuredDefault).trim();

  return {
    command: typeof input.command === "string" && input.command.trim() !== ""
      ? input.command.trim()
      : DEFAULTS.command,
    defaultModel,
    reasoningEffort: EFFORTS.has(effort) ? effort : DEFAULTS.reasoningEffort,
    defaultAgent: configuredString(input, "defaultAgent", DEFAULTS.defaultAgent),
    timeoutMs: finiteNumber(input.timeoutMs, DEFAULTS.timeoutMs, 10_000, 900_000),
    promptMaxBytes: finiteNumber(input.promptMaxBytes, DEFAULTS.promptMaxBytes, 1_000, 24_000),
    maxOutputBytes: finiteNumber(input.maxOutputBytes, DEFAULTS.maxOutputBytes, 1_000, 262_144),
    trustFolder: input.trustFolder === true
  };
}

function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

function approvalService(ctx) {
  try {
    return ctx.get("approval");
  } catch {
    return undefined;
  }
}

function denied({ access, mode, model, agent, message }) {
  return {
    ok: false,
    access,
    mode,
    model,
    agent,
    exitCode: -1,
    text: message,
    stderr: "",
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    truncated: false,
    modelFallback: false
  };
}

async function requestElevation(ctx, exec, access) {
  if (access === "read") return { allowed: true };

  const approval = approvalService(ctx);
  if (!approval || typeof approval.request !== "function") {
    return {
      allowed: false,
      message: "高权限调用需要 DSH 审批服务，但当前组合没有挂载 approval。已拒绝本次 write/shell 请求；可以改用 access=read，或安装并启用审批服务后重试。"
    };
  }

  const reason = access === "write"
    ? "允许 GitHub Copilot CLI 修改当前工作区文件（一次性授权）。"
    : "允许 GitHub Copilot CLI 在当前工作区执行 shell 命令，并可能修改文件（一次性授权）。";

  let outcome;
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: "copilot_ask",
      ...(exec.callId === undefined ? {} : { callId: exec.callId }),
      reason,
      signal: exec.signal
    });
  } catch (error) {
    return {
      allowed: false,
      message: `审批请求失败，已拒绝本次高权限调用：${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (outcome === "allowed-once") return { allowed: true };

  const detail = outcome === "rejected"
    ? "用户拒绝了这次授权。"
    : outcome === "cancelled"
      ? "审批已取消。"
      : "审批通道不可用，已按失败关闭处理。";
  return {
    allowed: false,
    message: `${detail}本次没有启动 Copilot CLI。可以改用 access=read，或重新请求并说明为什么需要该权限。`
  };
}

function appendCapped(state, key, chunk, maxBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
  const used = state[`${key}Bytes`];
  if (used >= maxBytes) {
    state.truncated = true;
    return;
  }
  const remaining = maxBytes - used;
  const slice = buffer.subarray(0, remaining);
  state[key] += slice.toString("utf8");
  state[`${key}Bytes`] = used + slice.length;
  if (buffer.length > remaining) state.truncated = true;
}

function runCopilot(command, argv, options) {
  return new Promise((resolveResult) => {
    const startedAt = Date.now();
    const state = {
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      timedOut: false,
      cancelled: false,
      error: "",
      settled: false
    };

    let child;
    try {
      child = spawn(command, argv, {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env
      });
    } catch (error) {
      resolveResult({
        ok: false,
        exitCode: -1,
        text: "",
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        timedOut: false,
        cancelled: false,
        truncated: false
      });
      return;
    }

    let killTimer;
    let hardKillTimer;
    let timeoutTimer;

    const terminate = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may already have exited.
      }
      hardKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may already have exited.
        }
      }, 2_000);
      hardKillTimer.unref?.();
    };

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(hardKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (exitCode) => {
      if (state.settled) return;
      state.settled = true;
      cleanup();
      const stderr = [state.stderr.trim(), state.error].filter(Boolean).join("\n");
      resolveResult({
        ok: exitCode === 0 && !state.timedOut && !state.cancelled && state.error === "",
        exitCode: typeof exitCode === "number" ? exitCode : -1,
        text: state.stdout.trim(),
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut: state.timedOut,
        cancelled: state.cancelled,
        truncated: state.truncated
      });
    };

    const onAbort = () => {
      if (state.settled || state.cancelled) return;
      state.cancelled = true;
      terminate();
      killTimer = setTimeout(() => finish(-1), 3_000);
      killTimer.unref?.();
    };

    child.stdout?.on("data", (chunk) => appendCapped(state, "stdout", chunk, options.maxOutputBytes));
    child.stderr?.on("data", (chunk) => appendCapped(state, "stderr", chunk, options.maxOutputBytes));

    child.on("error", (error) => {
      state.error = error instanceof Error ? error.message : String(error);
      finish(-1);
    });
    child.on("close", (exitCode) => finish(exitCode ?? -1));

    timeoutTimer = setTimeout(() => {
      if (state.settled) return;
      state.timedOut = true;
      terminate();
      killTimer = setTimeout(() => finish(-1), 3_000);
      killTimer.unref?.();
    }, options.timeoutMs);
    timeoutTimer.unref?.();

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function modelIsUnavailable(result) {
  if (result.exitCode === 0 || result.timedOut || result.cancelled) return false;
  return MODEL_UNAVAILABLE.test(`${result.stderr}\n${result.text}`);
}

function modelAttempts(userModel, defaultModel) {
  const attempts = [];
  if (userModel !== "") attempts.push(userModel);
  if (defaultModel !== "" && defaultModel !== userModel) attempts.push(defaultModel);
  attempts.push("");
  return attempts;
}

function buildArgv(prompt, access, model, reasoningEffort, mode, agent, trustFolder) {
  const allow = access === "read"
    ? "read"
    : access === "write"
      ? "read,write"
      : "read,write,shell";

  const argv = [
    "-p", prompt,
    "-s",
    "--no-ask-user",
    `--allow-tool=${allow}`,
    "--reasoning-effort", reasoningEffort
  ];
  if (model !== "") argv.push("--model", model);
  if (mode === "plan") argv.push("--plan");
  if (mode === "agent") argv.push("--agent", agent);
  if (trustFolder) argv.push("--trust-folder");
  return argv;
}

async function runWithModelFallback({ command, prompt, access, effort, mode, agent, trustFolder, cwd, timeoutMs, maxOutputBytes, signal, attempts, initialFallback = false }) {
  let result;
  let fallback = initialFallback;

  for (const model of attempts) {
    result = await runCopilot(command, buildArgv(prompt, access, model, effort, mode, agent, trustFolder), {
      cwd,
      timeoutMs,
      maxOutputBytes,
      signal
    });
    if (result.ok || !modelIsUnavailable(result)) {
      return {
        ...result,
        access,
        mode,
        model,
        agent,
        modelFallback: fallback
      };
    }
    fallback = true;
    if (signal?.aborted) break;
  }

  return {
    ...result,
    access,
    mode,
    model: "",
    agent,
    modelFallback: true
  };
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);

  const tool = defineTool({
    name: "copilot_ask",
    description: "Delegate a self-contained task to the official GitHub Copilot CLI (`copilot -p`). Modes: ask (one-shot answer), agent (run a named custom agent via --agent), plan (produce a plan via --plan). Copilot runs as a separate agent in the current workspace and does NOT see this DSH conversation, so put every needed file path, diff, and constraint into `prompt`. Model selection: a tool `model` wins; if it is unavailable it falls back to the configured defaultModel, then to no model restriction. An empty defaultModel also means no model restriction. `access: read` runs automatically; `write` and `shell` each ask the user for a one-shot approval before the CLI starts. Prefer read for review and analysis.",
    parameters: {
      prompt: {
        type: "string",
        required: true,
        description: "A self-contained task for Copilot. Include relevant context, file paths, and acceptance criteria; Copilot does not inherit the DSH transcript."
      },
      mode: {
        type: "string",
        enum: ["ask", "agent", "plan"],
        description: "Copilot CLI mode. ask = one-shot answer; agent = --agent <name>; plan = --plan. Default: ask."
      },
      agent: {
        type: "string",
        description: "Custom agent name for mode=agent. If omitted, the plugin's defaultAgent setting is used; agent mode fails when both are empty."
      },
      access: {
        type: "string",
        enum: ["read", "write", "shell"],
        description: "Requested Copilot permission. read is automatic; write allows file changes; shell allows commands and implies write. write and shell each require a one-shot user approval. Default: read."
      },
      model: {
        type: "string",
        description: "Optional Copilot model id. If unavailable, falls back to the configured defaultModel, then to no model restriction."
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Optional reasoning level: Low, Medium, or High. Defaults to the plugin's configured reasoningEffort (Medium)."
      },
      timeout_seconds: {
        type: "number",
        description: "Optional timeout in seconds. Capped by the plugin's timeoutMs setting (default 300 seconds)."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          access: { type: "string", enum: ["read", "write", "shell"], required: true },
          mode: { type: "string", enum: ["ask", "agent", "plan"], required: true },
          model: { type: "string", required: true },
          agent: { type: "string", required: true },
          exitCode: { type: "number", required: true },
          text: { type: "string", required: true },
          stderr: { type: "string", required: true },
          durationMs: { type: "number", required: true },
          timedOut: { type: "boolean", required: true },
          cancelled: { type: "boolean", required: true },
          truncated: { type: "boolean", required: true },
          modelFallback: { type: "boolean", required: true }
        }
      },
      render: (_args, value) => {
        const body = value.text || (value.ok ? "(Copilot CLI returned no text.)" : "Copilot CLI did not return a response.");
        const details = value.stderr ? `\n\nstderr:\n${value.stderr}` : "";
        return [{ type: "text", text: `${body}${details}` }];
      }
    },
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error("copilot_ask was cancelled before it started.");

      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (prompt === "") throw new Error("copilot_ask requires a non-empty prompt.");

      const mode = typeof args.mode === "string" && MODES.has(args.mode) ? args.mode : "ask";
      const access = typeof args.access === "string" && ACCESS.has(args.access) ? args.access : "read";
      const requestedModel = typeof args.model === "string" ? args.model.trim() : "";
      const userModel = IDENTIFIER.test(requestedModel) ? requestedModel : "";
      const defaultModel = IDENTIFIER.test(config.defaultModel) ? config.defaultModel : "";
      const modelForReport = userModel || defaultModel;
      let agent = typeof args.agent === "string" ? args.agent.trim() : "";

      if (mode === "agent") {
        agent = agent || config.defaultAgent;
        if (agent === "") {
          return denied({
            access,
            mode,
            model: modelForReport,
            agent: "",
            message: "agent 模式需要指定 agent 名称（工具参数 agent，或在插件配置中设置 defaultAgent）。可用的自定义 agent 通常来自 .github/agents 或 ~/.copilot/agents。"
          });
        }
        if (!IDENTIFIER.test(agent)) {
          return denied({
            access,
            mode,
            model: modelForReport,
            agent,
            message: "agent 名称包含非法字符。请使用 Copilot 自定义 agent 的名称，例如 code-simplifier。"
          });
        }
      } else {
        agent = "";
      }

      const promptBytes = byteLength(prompt);
      if (promptBytes > config.promptMaxBytes) {
        return denied({
          access,
          mode,
          model: modelForReport,
          agent,
          message: `prompt 太大（${promptBytes} 字节，上限 ${config.promptMaxBytes} 字节）。请缩小范围或先让 DSH 生成一段摘要，再交给 Copilot。`
        });
      }

      const cwd = exec.agent?.session?.header?.cwd;
      if (typeof cwd !== "string" || cwd === "") {
        return denied({
          access,
          mode,
          model: modelForReport,
          agent,
          message: "无法确定当前 DSH 会话的工作区。copilot_ask 需要在有工作区的会话中运行。"
        });
      }
      if (!isAbsolute(cwd)) {
        return denied({
          access,
          mode,
          model: modelForReport,
          agent,
          message: `当前会话工作区不是绝对路径：${cwd}`
        });
      }
      try {
        if (!statSync(cwd).isDirectory()) {
          return denied({
            access,
            mode,
            model: modelForReport,
            agent,
            message: `当前会话工作区不是目录：${cwd}`
          });
        }
      } catch (error) {
        return denied({
          access,
          mode,
          model: modelForReport,
          agent,
          message: `无法访问当前会话工作区：${error instanceof Error ? error.message : String(error)}`
        });
      }

      if (access !== "read") {
        const elevation = await requestElevation(ctx, exec, access);
        if (!elevation.allowed) {
          return denied({
            access,
            mode,
            model: modelForReport,
            agent,
            message: elevation.message ?? "高权限请求被拒绝。"
          });
        }
      }

      const requestedTimeout = typeof args.timeout_seconds === "number" && Number.isFinite(args.timeout_seconds)
        ? args.timeout_seconds * 1_000
        : config.timeoutMs;
      const timeoutMs = Math.max(10_000, Math.min(config.timeoutMs, requestedTimeout));

      const attempts = modelAttempts(userModel, defaultModel);
      const result = await runWithModelFallback({
        command: config.command,
        prompt,
        access,
        effort: EFFORTS.has(typeof args.effort === "string" ? args.effort.toLowerCase() : "")
          ? args.effort.toLowerCase()
          : config.reasoningEffort,
        mode,
        agent,
        trustFolder: config.trustFolder,
        cwd: resolve(cwd),
        timeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        signal: exec.signal,
        attempts,
        initialFallback: requestedModel !== "" && userModel !== requestedModel
      });
      return result;
    }
  });

  ctx.effect(() => ctx.tools.register(tool), "copilot-bridge: copilot_ask");
}
