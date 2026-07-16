# @gitgmbh/pi-trinity-mcp

> Pi extension that delegates prompts to agents on any self-hosted [Trinity](https://github.com/abilityai/trinity) MCP platform. No CLI, no MCP server wiring — pure MCP-over-HTTP+SSE.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## What this is

[Trinity](https://github.com/abilityai/trinity) is an open-source platform for deploying, orchestrating, and governing fleets of autonomous AI agents on your own hardware. It exposes a **MCP (Model Context Protocol)** endpoint at `https://<your-trinity-host>/sse` that lists dozens of tools for agent CRUD, scheduled loops, fleet health, event subscriptions, file sharing, voice calling, and more.

This extension wraps a **curated subset** of those tools as native pi tools, so the model can spin up a delegation conversation without injecting every MCP schema into its context.

## Tools surfaced

| Tool | Underlying MCP tool |
|---|---|
| `trinity_chat` | `chat_with_agent` — send a prompt to any agent |
| `trinity_agents_list` | `list_agents` — list all deployed agents |
| `trinity_get_agent` | `get_agent` — detailed info on one agent |
| `trinity_fleet_health` | `get_fleet_health` — fleet-wide health rollup |
| `trinity_get_agent_health` | `get_agent_health` — deep health for one agent |
| `trinity_get_agent_logs` | `get_agent_logs` — tail container logs |

The full MCP surface remains reachable via raw `tools/call` calls — see "Advanced: raw MCP" below.

## Install

```bash
pi install npm:@gitgmbh/pi-trinity-mcp
```

For other installation sources (private registry, git mirror), see [the pi packages docs](https://pi.dev/docs/latest/packages).

## Auth

Two env vars — that's all it takes:

```bash
export TRINITY_URL="<your-trinity-host>"            # e.g. https://trinity.example.com
export TRINITY_API_KEY="<your-mcp-key>"             # Settings → API Keys in the dashboard
```

Optionally store them in `~/.pi/agent/settings.json`:

```json
{ "trinity": { "url": "<your-trinity-host>", "token": "<your-mcp-key>" } }
```

Get a key at `<your-trinity-host>` → Settings → API Keys → Create.

## Usage

Once installed, the model can call any of the six tools. A typical delegation:

> "Delegate to `<your-orchestrator-agent>` a plan to migrate stack X"

Or directly:

> "Use `trinity_chat` with `agent='<your-ops-agent>'` and a message asking for help with Ansible"

A sensible convention is to give your agents role-coded names (e.g. `orchestrator`, `devops`, `docs`, `reviewer`) — that lets the model pick the right agent without remembering a roster. Discover your current roster with `trinity_agents_list`.

### Pattern: orchestrator + specialists

A common pattern is one **orchestrator agent** that triages incoming tasks and dispatches to specialists (Ansible, Odoo, GitLab, debugging, etc.). To use it:

1. Delegate to the orchestrator first when a task is non-trivial — let it decompose the work.
2. Talk to a specialist directly when you already know which agent owns the topic.

### When NOT to use Trinity

- Trivial local edits, single-file fixes — local tools are faster and free.
- Anything needing deep context about your open files / session — Trinity has none of that. Include all needed context in `message`.
- Anything that must complete in <5s — delegated runs are network round-trips plus agent runtime.

## Advanced: raw MCP

If you need any of the other tools (schedules, event subscriptions, file sharing, voice, etc.), call MCP directly from a pi shell. The transport is Streamable HTTP:

```bash
# 1. initialize → capture mcp-session-id
SID=$(curl -sS -i -X POST "$TRINITY_URL/sse" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TRINITY_API_KEY" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}},"id":1}' \
  | grep -i "^mcp-session-id" | awk '{print $2}' | tr -d '\r\n')

# 2. acknowledge
curl -sS -o /dev/null -X POST "$TRINITY_URL/sse" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TRINITY_API_KEY" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. call any tool
curl -sS -X POST "$TRINITY_URL/sse" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TRINITY_API_KEY" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"<tool-name>","arguments":{...}},"id":99}'
```

Or list everything that's available:

```bash
curl -sS -X POST "$TRINITY_URL/sse" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TRINITY_API_KEY" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"tools/list",","id":3}'
```

## Why no CLI

Pi intentionally has no built-in MCP support. This extension is a ~200-line Streamable-HTTP MCP client: it does the `initialize` handshake, captures `mcp-session-id`, and dispatches `tools/call`. Zero prompt overhead for tools you don't use, no extra schema injection, no separate daemon.

## How it talks to Trinity

```
pi (this extension)
  └─ POST {TRINITY_URL}/sse
       ├─ initialize             → captures mcp-session-id
       ├─ notifications/initialized
       └─ tools/call             → SSE-formatted JSON-RPC 2.0 reply
```

All requests use `Authorization: Bearer <TRINITY_API_KEY>`.

## Development

The extension is a single `index.ts` file. To iterate locally:

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-trinity-mcp
```

Pi auto-discovers from `~/.pi/agent/extensions/` during development.

## Publish

Maintainers only:

```bash
npm version patch     # or minor / major
npm publish --access public --provenance
```

(`--access public` is required for scoped packages to be indexable by the [pi marketplace](https://pi.dev/packages).)

## License

MIT
