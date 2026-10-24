# dsh-copilot-bridge

A DSH plugin that exposes the official GitHub Copilot CLI as the
`copilot_ask` tool. It supports three Copilot CLI modes, configurable model
selection, and one-shot DSH approval for file writes and shell commands.

Project home: `C:\Users\PrinzEugen\OneDrive\Code\GitHub\MyDSHPlugIn`

## Modes

| `mode` | Copilot CLI invocation | Purpose |
|---|---|---|
| `ask` (default) | `copilot -p <prompt>` | One-shot answer or analysis |
| `agent` | adds `--agent <name>` | Run a named Copilot custom agent |
| `plan` | adds `--plan` | Produce a plan before implementation |

All modes also use:

```text
-s --no-ask-user --allow-tool=<scope> --reasoning-effort <low|medium|high>
```

`agent` mode needs a custom agent name. Names come from Copilot's agent
locations, usually `.github/agents` or `~/.copilot/agents`. If the tool call
omits `agent`, the plugin's `defaultAgent` setting is used; if both are empty,
agent mode returns an error instead of silently running ask mode.

## Model selection

The default model is **MAI-Code-1.1-Flash**. Its Copilot CLI id is lowercase:
`mai-code-1.1-flash`. The default reasoning level is **Medium**; `Low`,
`Medium`, and `High` map to `low`, `medium`, and `high`.

Selection follows this order:

| Situation | Result |
|---|---|
| `defaultModel` is non-empty and exists | use `defaultModel` |
| `defaultModel` is non-empty but unavailable | omit `--model` |
| `defaultModel` is empty | omit `--model` |
| The tool call supplies `model` and it exists | use the supplied model |
| The tool call supplies `model` but it is unavailable | fall back to `defaultModel` if configured and available; otherwise omit `--model` |

"Unavailable" is detected from Copilot CLI's
`Model "..." from --model flag is not available.` error. A syntactically
invalid user model is treated as unavailable and goes straight to the default
fallback. The tool result reports the model actually used and whether a
fallback happened.

## Permission model

| `access` | Copilot may | DSH approval |
|---|---|---|
| `read` (default) | read files | none |
| `write` | read and modify files | one-shot approval every call |
| `shell` | read, modify, and run shell commands | one-shot approval every call |

`write` and `shell` call `ctx.approval.request` before spawning the CLI.
A rejection, cancellation, or unavailable approval channel fails closed; the
CLI is not started. The grant applies only to that one call.

`--allow-all` / `--yolo` are never used.

## Requirements

- DSH with the `tools` service.
- The official CLI installed and logged in:

```powershell
npm install -g @github/copilot
copilot login
copilot -p "Reply with exactly: OK" -s
```

- A DSH approval answerer for `write`/`shell`. Without one, those modes fail
  closed; `read` still works.

## Install

From the project directory:

```powershell
cd C:\Users\PrinzEugen\OneDrive\Code\GitHub\MyDSHPlugIn
npm pack --ignore-scripts
dsh plugin --profile desktop add "C:/Users/PrinzEugen/OneDrive/Code/GitHub/MyDSHPlugIn/dsh-copilot-bridge-0.3.0.tgz"
```

Restart DSH after installing a new version.

## Usage

Ask mode:

> 用 `copilot_ask` 以只读方式让 Copilot 审查当前工作区的改动。

Agent mode:

> 用 `copilot_ask`，`mode=agent`，`agent=code-simplifier`，以只读方式分析这段代码。

Plan mode:

> 用 `copilot_ask`，`mode=plan`，先给出实现计划，不要修改文件。

Write / shell access:

> 用 `copilot_ask`、`access=write`，让 Copilot 修复这个测试失败。

> 用 `copilot_ask`、`access=shell`，让 Copilot 跑测试并修复。

Model and effort override:

> 用 `copilot_ask`，`model=mai-code-1.1-flash`，`effort=high`，分析这个并发问题。

## Configuration

Profile patch config:

```yaml
- id: copilot-bridge
  name: dsh-copilot-bridge
  config:
    defaultModel: mai-code-1.1-flash   # empty = no --model
    reasoningEffort: medium             # low | medium | high
    defaultAgent: ""                    # used by mode=agent when agent is omitted
    command: copilot
    timeoutMs: 300000
    promptMaxBytes: 16000
    maxOutputBytes: 65536
    trustFolder: false
```

- `defaultModel`: Copilot CLI model id. Default `mai-code-1.1-flash`
  (MAI-Code-1.1-Flash). Set to `""` to omit `--model` entirely.
- `reasoningEffort`: `low`, `medium`, or `high`. Default `medium`.
  The tool can override this per call with `effort`.
- `defaultAgent`: optional custom agent for `mode=agent`.
- `command`: CLI executable or absolute path.
- `timeoutMs`: hard cap per call (10s to 15min).
- `promptMaxBytes`: Windows command-line safety cap; keep well below 32 KB.
- `maxOutputBytes`: stdout/stderr capture cap.
- `trustFolder`: pass `--trust-folder` to Copilot. Only enable after reviewing
  the workspace's hooks, MCP, and plugin configuration.

The old `model` config key is still accepted as an alias for `defaultModel`.

## Limitations

- Each call is a separate Copilot CLI session. Copilot does not see the DSH
  transcript; the caller must supply a self-contained prompt.
- No streaming: the tool waits for the CLI to finish.
- Copilot's own tool approvals are pre-authorized by the `--allow-tool` scope;
  DSH's approval covers the whole call, not each Copilot tool action.
- The result is plain text from `-s`; rich Copilot tool cards are not projected
  into the DSH transcript.
- For a full agent/session integration, use Copilot CLI's ACP server
  (`copilot --acp --stdio`) with a DSH ACP client adapter instead.
