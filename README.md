# @gitgmbh/pi-trinity-mcp

> Pi extension that delegates prompts to agents on the [self-hosted Trinity MCP platform](https://trinity.sifi.git.gmbh). No CLI, no MCP server wiring — pure MCP-over-HTTP+SSE.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## What this is

Trinity is an open-source, sovereign infrastructure platform for deploying, orchestrating, and governing fleets of autonomous AI agents on your own hardware. It exposes a **MCP (Model Context Protocol)** endpoint at `https://<your-trinity>/mcp` that lists **84 tools** for agent CRUD, scheduled loops, fleet health, event subscriptions, file sharing, voice calling, and more.

This extension wraps the **6 most useful delegation primitives** as native pi tools, so the model can spin up a delegation conversation without injecting 84 schemas into its context.

## Tools surfaced

| Tool | Underlying MCP tool |
|---|---|
| `trinity_chat` | `chat_with_agent` — send a prompt to any agent |
| `trinity_agents_list` | `list_agents` — list all deployed agents |
| `trinity_get_agent` | `get_agent` — detailed info on one agent |
| `trinity_fleet_health` | `get_fleet_health` — fleet-wide health rollup |
| `trinity_get_agent_health` | `get_agent_health` — deep health for one agent |
| `trinity_get_agent_logs` | `get_agent_logs` — tail container logs |

The full 84-tool MCP surface remains reachable via raw `tools/call` calls — see [the docs in this repo](docs/raw-mcp.md) (or ask the model to delegate to `cornelius`, who has full MCP access from inside his container).

## Install

```bash
pi install npm:@gitgmbh/pi-trinity-mcp
```

For team-internal use (without going through npm):

```bash
pi install git:gitlab.git.gmbh:devops/pi-trinity-mcp
```

## Auth

Two env vars — that's it:

```bash
export TRINITY_URL="https://trinity.sifi.git.gmbh"   # or your self-hosted host
export TRINITY_API_KEY="trinity_mcp_…"               # Settings → API Keys in the dashboard
```

Optionally store in `~/.pi/agent/settings.json`:

```json
{ "trinity": { "url": "https://...", "token": "trinity_mcp_..." } }
```

Get your key at `<your-trinity>` → Settings → API Keys → Create.

## Usage

Once installed, just ask pi:

> "Delegate to cornelius a plan to migrate stack X"

Or directly call the tool:

> "Use `trinity_chat` with `agent='ansiblius'` and message asking for Ansible playbook help"

See the [`the-agentics/skills/trinity`](https://gitlab.git.gmbh/devops/the-agentics) skill (if your team uses the library distribution) for routing patterns — cornelius for orchestration, ansiblius for Ansible, odoolius/odoofrontius for Odoo, etc.

## Why no CLI

Pi intentionally has no built-in MCP support. This extension is a ~200-line Streamable-HTTP MCP client: it does the `initialize` handshake, captures `mcp-session-id`, and dispatches `tools/call`. Zero prompt overhead for tools you don't use, no extra schema injection, no separate daemon.

## How it talks to Trinity

```
pi (this extension)
  └─ POST {TRINITY_URL}/mcp
       ├─ initialize     → captures mcp-session-id
       ├─ notifications/initialized
       └─ tools/call     → SSE-formatted JSON-RPC 2.0 reply
```

All requests use `Authorization: Bearer <TRINITY_API_KEY>`.

## Development

The extension is a single `index.ts` file that exports a default pi extension factory. Edit it, then test locally:

```bash
cp index.ts ~/.pi/agent/extensions/trinity/
```

(pi auto-discovers from `~/.pi/agent/extensions/` during dev.)

## Publish (maintainers only)

```bash
# Bump version
npm version patch

# Push to npm — the published package will auto-show on https://pi.dev/packages
npm publish --access public
```

## License

MIT © 2026 gitgmbh
