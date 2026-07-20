/**
 * Trinity Pi Extension (full MCP)
 *
 * Speaks the Model Context Protocol (MCP) over HTTP+SSE against
 * the self-hosted Trinity MCP endpoint at `${TRINITY_URL}/mcp`.
 *
 * Protocol summary (Streamable HTTP transport):
 *   1. POST {TRINITY_URL}/mcp with `initialize` → server returns
 *      `mcp-session-id` header. Capture it; reuse for all subsequent calls.
 *   2. POST `notifications/initialized` (no response expected).
 *   3. POST `tools/call` with {name, arguments} → response is SSE stream with
 *      one `data:` line containing the JSON-RPC 2.0 reply.
 *
 * Auth: `Authorization: Bearer <token>` on every request. Token comes from
 * `TRINITY_API_KEY` (env) or the `trinity` block in ~/.pi/agent/settings.json.
 *
 * This extension surfaces a curated subset of the 84 MCP tools Trinity
 * exposes. We don't proxy everything because prompt-overhead cost would
 * dwarf the value. We expose the high-leverage delegation primitives.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Extension version, read once from the package.json shipped alongside this
// module (npm always includes it). Reported to Trinity in `initialize`.
const EXTENSION_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

interface TrinityConfig {
  baseUrl: string;      // e.g. https://<your-trinity-host>
  token?: string;
}

function resolveConfig(): TrinityConfig {
  const envUrl = process.env.TRINITY_URL;
  const envToken = process.env.TRINITY_API_KEY;
  if (envUrl) return { baseUrl: envUrl.replace(/\/+$/, ""), token: envToken };

  try {
    const home = process.env.HOME || "";
    const settingsPath = join(home, ".pi", "agent", "settings.json");
    if (existsSync(settingsPath)) {
      const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
      const t = raw?.trinity;
      if (t?.url) {
        return { baseUrl: String(t.url).replace(/\/+$/, ""), token: t.token };
      }
    }
  } catch {
    /* fall through */
  }

  throw new Error(
    "Trinity is not configured. Set TRINITY_URL and TRINITY_API_KEY, " +
      "or add a `trinity` block to ~/.pi/agent/settings.json.",
  );
}

// -----------------------------------------------------------------------------
// Low-level MCP client (Streamable HTTP transport)
// -----------------------------------------------------------------------------

interface MCPClient {
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): void;
}

class TrinityAPIError extends Error {
  constructor(public statusCode: number, public detail: string) {
    super(`Trinity API HTTP ${statusCode}: ${detail}`);
  }
}

function parseSSEResponse(text: string): unknown {
  // An SSE stream may carry several "data:" events (e.g. progress
  // notifications before the reply). The JSON-RPC result is the last complete
  // JSON object, so scan all events and keep the last one that parses.
  let lastPayload: string | undefined;
  let lastJson: unknown;
  let sawJson = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    lastPayload = line.slice(5).trim();
    try {
      lastJson = JSON.parse(lastPayload);
      sawJson = true;
    } catch {
      /* not JSON — keep scanning for a later event */
    }
  }
  if (sawJson) return lastJson;
  if (lastPayload !== undefined) return lastPayload;
  // Fall back to plain JSON
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

class StreamableMCPClient implements MCPClient {
  private sessionId?: string;
  private sessionInit?: Promise<void>;
  private nextId = 1;

  constructor(private cfg: TrinityConfig) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...extra,
    };
    if (this.cfg.token) h["Authorization"] = `Bearer ${this.cfg.token}`;
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  private async ensureSession(signal?: AbortSignal): Promise<void> {
    if (this.sessionId) return;
    // Guard against concurrent callers (e.g. parallel delegation) each firing
    // their own `initialize`: share a single in-flight init promise.
    if (!this.sessionInit) {
      this.sessionInit = this.initSession(signal).catch((err) => {
        this.sessionInit = undefined; // allow a fresh attempt next call
        throw err;
      });
    }
    return this.sessionInit;
  }

  private async initSession(signal?: AbortSignal): Promise<void> {
    const url = `${this.cfg.baseUrl}/mcp`;
    const resp = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "pi-trinity-extension", version: EXTENSION_VERSION },
        },
      }),
    });
    if (resp.status >= 400) {
      throw new TrinityAPIError(resp.status, await resp.text());
    }
    this.sessionId = resp.headers.get("mcp-session-id") ?? undefined;
    if (!this.sessionId) {
      throw new Error("Trinity /mcp returned no mcp-session-id header on initialize");
    }
    // Acknowledge the session per MCP spec
    await fetch(url, {
      method: "POST",
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.callToolOnce(name, args, signal, true);
  }

  private async callToolOnce(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    allowRetry: boolean,
  ): Promise<unknown> {
    await this.ensureSession(signal);
    const url = `${this.cfg.baseUrl}/mcp`;
    const resp = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const text = await resp.text();
    if (resp.status >= 400) {
      // 404 means the server no longer recognizes our session id (restart /
      // expiry). Per the MCP Streamable HTTP spec, re-initialize and retry once.
      if (allowRetry && resp.status === 404 && this.sessionId) {
        this.sessionId = undefined;
        this.sessionInit = undefined;
        return this.callToolOnce(name, args, signal, false);
      }
      throw new TrinityAPIError(resp.status, text.slice(0, 300));
    }
    const data = parseSSEResponse(text) as Record<string, unknown> | null;
    if (!data) throw new TrinityAPIError(resp.status, "empty response");

    if ("error" in data && data.error) {
      const err = data.error as { message?: string; code?: number };
      throw new TrinityAPIError(
        typeof err.code === "number" ? err.code : 0,
        err.message ?? "unknown MCP error",
      );
    }
    return data.result ?? data;
  }

  close(): void {
    // Sessions are server-side; nothing to free locally.
  }
}

function formatToolResult(result: unknown): string {
  // MCP tool results are {content: [{type: "text", text: "..."}, ...], isError?: bool}.
  if (!result || typeof result !== "object") return JSON.stringify(result, null, 2);
  const obj = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  if (!Array.isArray(obj.content)) return JSON.stringify(result, null, 2);
  const parts: string[] = [];
  for (const item of obj.content) {
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else parts.push(JSON.stringify(item));
  }
  return parts.join("\n\n");
}

// -----------------------------------------------------------------------------
// Pi extension registration — curated tools
// -----------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // We keep one client per pi session (sessions are sticky enough that a
  // shared client is fine; MCP session-id is stable for the pi process).
  let client: StreamableMCPClient | undefined;
  const getClient = (): StreamableMCPClient => {
    if (!client) client = new StreamableMCPClient(resolveConfig());
    return client;
  };

  // ---- trinity_chat ---------------------------------------------------------
  // Generic delegation: send a message to any agent and get the response back.
  pi.registerTool({
    name: "trinity_chat",
    label: "Trinity Chat (delegate)",
    description:
      "Delegate a message to a Trinity agent and return the agent's response. " +
      "Use list_agents / trinity_agents_list first if you don't know which agent to call.",
    promptSnippet: "Delegate a prompt to a Trinity agent (MCP chat_with_agent)",
    promptGuidelines: [
      "Use trinity_chat to delegate work to a Trinity agent on the admin subscription.",
      "Always set `agent` to the canonical agent name (use trinity_agents_list to discover).",
      "Set `parallel: true` for stateless, independent tasks (no conversation history).",
      "Set `async: true` to fire-and-forget; you'll get an execution_id to poll later.",
    ],
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name (see trinity_agents_list)." }),
      message: Type.String({ description: "Prompt to send." }),
      parallel: Type.Optional(
        Type.Boolean({
          description:
            "true = stateless parallel mode (no history); false (default) = conversational.",
          default: false,
        }),
      ),
      model: Type.Optional(
        Type.String({ description: "Model override (e.g. 'sonnet', 'opus', 'haiku')." }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({ description: "Per-call timeout in seconds. Defaults to agent's configured cap (max 900)." }),
      ),
    }),
    async execute(_id, params, signal, onUpdate) {
      try {
        const c = getClient();
        onUpdate?.({
          content: [{ type: "text", text: `Delegating to ${params.agent}…` }],
          details: { agent: params.agent, phase: "request" },
        });

        const args: Record<string, unknown> = {
          agent_name: params.agent,
          message: params.message,
        };
        if (params.parallel) args.parallel = params.parallel;
        if (params.model) args.model = params.model;
        if (params.timeout_seconds !== undefined) args.timeout_seconds = params.timeout_seconds;

        const result = await c.callTool("chat_with_agent", args, signal);
        const text = formatToolResult(result);
        return {
          content: [{ type: "text", text }],
          details: { agent: params.agent, raw: result },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Trinity delegation failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: String(err) },
        };
      }
    },
  });

  // ---- trinity_agents_list --------------------------------------------------
  pi.registerTool({
    name: "trinity_agents_list",
    label: "Trinity Agents List",
    description: "List all agents on the Trinity platform with status, type, port, resources.",
    promptSnippet: "List all Trinity agents currently deployed",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      try {
        const r = await getClient().callTool("list_agents", {}, signal);
        return { content: [{ type: "text", text: formatToolResult(r) }], details: { raw: r } };
      } catch (err) {
        return {
          content: [{ type: "text", text: `List failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: String(err) },
        };
      }
    },
  });

  // ---- trinity_get_agent ----------------------------------------------------
  pi.registerTool({
    name: "trinity_get_agent",
    label: "Trinity Get Agent",
    description: "Get full details (status, port, resources, container, owner) for one agent.",
    promptSnippet: "Get detailed info on a specific Trinity agent",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name." }),
    }),
    async execute(_id, params, signal) {
      try {
        const r = await getClient().callTool("get_agent", { name: params.agent }, signal);
        return { content: [{ type: "text", text: formatToolResult(r) }], details: { raw: r } };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Get agent failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: String(err) },
        };
      }
    },
  });

  // ---- trinity_fleet_health -------------------------------------------------
  pi.registerTool({
    name: "trinity_fleet_health",
    label: "Trinity Fleet Health",
    description:
      "Fleet-wide summary: counts of healthy / degraded / unhealthy / critical agents, plus per-agent status.",
    promptSnippet: "Check Trinity fleet health (all agents at once)",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      try {
        const r = await getClient().callTool("get_fleet_health", {}, signal);
        return { content: [{ type: "text", text: formatToolResult(r) }], details: { raw: r } };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Fleet health failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: String(err) },
        };
      }
    },
  });

  // ---- trinity_get_agent_health --------------------------------------------
  pi.registerTool({
    name: "trinity_get_agent_health",
    label: "Trinity Agent Health",
    description:
      "Deep health info for one agent: Docker status, network reachability, runtime, context, 24h uptime.",
    promptSnippet: "Detailed health check for a specific Trinity agent",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name." }),
    }),
    async execute(_id, params, signal) {
      try {
        const r = await getClient().callTool("get_agent_health", { agent_name: params.agent }, signal);
        return { content: [{ type: "text", text: formatToolResult(r) }], details: { raw: r } };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Agent health failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: String(err) },
        };
      }
    },
  });

  // ---- trinity_get_agent_logs ----------------------------------------------
  pi.registerTool({
    name: "trinity_get_agent_logs",
    label: "Trinity Agent Logs",
    description: "Tail container logs for one agent — useful for debugging recent runs.",
    promptSnippet: "Tail container logs from a Trinity agent",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name." }),
      tail: Type.Optional(Type.Number({ description: "Lines to fetch (default 50, max 1000).", default: 50 })),
    }),
    async execute(_id, params, signal) {
      try {
        const args: Record<string, unknown> = { agent_name: params.agent };
        if (params.tail !== undefined) args.tail = params.tail;
        const r = await getClient().callTool("get_agent_logs", args, signal);
        return { content: [{ type: "text", text: formatToolResult(r) }], details: { raw: r } };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Logs fetch failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: String(err) },
        };
      }
    },
  });

  // ---- startup status -------------------------------------------------------
  pi.on("session_start", () => {
    try {
      const cfg = resolveConfig();
      pi.sendMessage({
        customType: "trinity-status",
        content: `Trinity extension loaded — ${cfg.baseUrl}/mcp`,
        display: true,
        details: { url: cfg.baseUrl, hasToken: Boolean(cfg.token) },
      });
    } catch (err) {
      pi.sendMessage({
        customType: "trinity-status",
        content: `Trinity extension: not configured. ${err instanceof Error ? err.message : String(err)}`,
        display: true,
        details: { configured: false },
      });
    }
  });
}
