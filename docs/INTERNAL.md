# Internal deployment notes (gitgmbh only)

> **NOT published to npm.** This file is excluded from the package tarball via `.npmignore`.
> It exists for the gitgmbh team that operates the self-hosted Trinity and uses this extension internally.

## Self-hosted Trinity

- **URL:** `https://trinity.sifi.git.gmbh`
- **MCP endpoint:** `https://trinity.sifi.git.gmbh/mcp`
- **Dashboard / API keys:** Settings → API Keys → Create
- **Token format:** `trinity_mcp_<40chars>`

The extension auto-discovers everything from `TRINITY_URL` — never hardcode the host in code.

## Agent roster (use as routing map)

The following agents are deployed. They are **codenames** — do not share the roster outside the team without scrubbing it from any other surface (PR descriptions, commit messages, screenshots, etc.).

| Agent | Role |
|---|---|
| `cornelius` | Orchestrator (triages + decomposes + dispatches) |
| `orchestratilus` | Alternative orchestrator |
| `ansiblius` | Ansible / DevOps |
| `odoolius` | Odoo backend |
| `odoofrontius` | Odoo frontend |
| `gitlabius` | GitLab |
| `debuggius` | Debugging / root cause |
| `exploratorius` | Codebase exploration |
| `censorius` | Content moderation |
| `conciergius` | Concierge / user-facing routing |
| `trinity-system` | System orchestrator (do **not** address directly) |

**Always start with `cornelius`** for non-trivial work; he decomposes and dispatches.

## Routing cheat sheet

| Task type | First stop |
|---|---|
| Multi-step implementation, migration plans | `cornelius` |
| Ansible playbook, role, molecule | `ansiblius` |
| Odoo module, view, ORM, QWeb | `odoolius` (backend) / `odoofrontius` (frontend) |
| GitLab CI, group config, runner | `gitlabius` |
| Debug a flaky / failing playbook | `debuggius` |
| Explore an unfamiliar codebase | `exploratorius` |
| Draft/edit/check user-facing copy | `conciergius` |

## Internal install paths

The team has two install paths — `pi install` works either way, so choose based on context.

### From npm (recommended for most teammates)

```bash
pi install npm:@gitgmbh/pi-trinity-mcp
```

Then set credentials:

```bash
export TRINITY_URL="https://trinity.sifi.git.gmbh"
export TRINITY_API_KEY="trinity_mcp_…"
```

Persist in `~/.zshrc` / `~/.bashrc`.

### From internal GitLab (only if you can't reach npm)

```bash
pi install git:gitlab.git.gmbh:devops/pi-trinity-mcp
```

Same env-vars as above. Use this when behind a firewall that blocks npm but allows our GitLab.

### From a local clone (during development)

```bash
cd ~/Desktop/gitlab-repos/pi-trinity-mcp
ln -sfn "$(pwd)" ~/.pi/agent/extensions/pi-trinity-mcp
```

Now edits in this directory are immediately live for pi. Don't forget to update via `pi update npm:@gitgmbh/pi-trinity-mcp` when you're done iterating, or the next person will pull the local state.

## Credential storage

There are three places credentials may live — pick one and stick to it per machine:

1. **Env vars** (`TRINITY_URL` / `TRINITY_API_KEY` in `~/.zshrc`) — simplest.
2. **`~/.pi/agent/settings.json`** — useful for headless / CI machines.
3. **Never** in dotenv files inside repos, in commit messages, or screenshots. Trinity tokens grant admin-subscription agent runs; treat them like AWS credentials.

To rotate: dashboard → Settings → API Keys → Revoke old key, create new one, update env vars, restart pi.

## Companion skill

This package pairs with the `trinity` skill in `the-agentics` (`gitlab.git.gmbh/devops/the-agentics` → `skills/trinity/SKILL.md`). The skill describes the same routing patterns in pi-natural-language form and points the model at the right tool. The library distribution auto-discovers it.

## What to publish vs what stays here

| File | Status | Notes |
|---|---|---|
| `README.md` | **published** | Generic. No internal hosts, agent codenames, or org URLs. |
| `index.ts` | **published** | Code path only references env-vars; no internal host hardcoded. |
| `package.json` | **published** | `author.name` is `gitgmbh` (org owner of npm scope). All `*.url` fields removed to keep the public tarball neutral. |
| `LICENSE` | **published** | MIT. |
| `docs/INTERNAL.md` | **internal only** | You are here. Lists codenames, internal hosts, install paths. Excluded via `.npmignore`. |
| `.git*` | **internal only** | Excluded via `.npmignore`. |

## Pre-publish checklist

Before `npm publish`:

```bash
# 1. Sanity-check what's in the public tarball
npm pack --dry-run

# Confirm the only files are:
#   .npmignore  index.ts  LICENSE  package.json  README.md

# 2. Confirm INTERNAL.md is excluded
#    (it should NOT appear in the list above)

# 3. Confirm no internal strings leaked into published files
tar -tzf "$(npm pack)" | xargs -I{} sh -c 'echo "=== {} ==="; tar -xOf "$(npm pack)" "{}" | grep -lE "trinity.sifi|gitlab.git.gmbh|cornelius|ansiblius|odoolius|odoofrontius|orchestratilus|gitlabius|debuggius|exploratorius|censorius|conciergius" 2>/dev/null && echo LEAK || echo ok'
```

If the script flags any LEAK, **stop** and rewrite that file before publishing.
