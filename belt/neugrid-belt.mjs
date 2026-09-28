#!/usr/bin/env node
/**
 * NeuGrid BELT — the MCP server an agent's body loads (Autonomous NeuGrid).
 *
 * A dumb, dependency-free stdio proxy: it fetches the tool list from the platform
 * (GET /api/agent-gateway/belt) and forwards every call (POST) with the agent's
 * per-wake gateway key. All logic lives server-side on NeuGrid, so
 * a new door on the platform is a new tool here with no code change.
 *
 *   Env:  NEUGRID_BASE       the platform origin, e.g. https://staging.neugrid.io (default http://localhost:3000 for a local NeuGrid)
 *         NEUGRID_AGENT_KEY  the agent's gateway key for this wake
 *   Protocol: JSON-RPC 2.0 over stdio, newline-delimited (MCP 2024-11-05). stdout = protocol only.
 */

const BASE = (process.env.NEUGRID_BASE || "http://localhost:3000").replace(/\/$/, "");
const KEY = process.env.NEUGRID_AGENT_KEY || "";
const DOOR = `${BASE}/api/agent-gateway/belt`;
const log = (...a) => process.stderr.write(`[neugrid-belt] ${a.join(" ")}\n`);

let toolsCache = null;
async function tools() {
  if (toolsCache) return toolsCache;
  const r = await fetch(DOOR);
  const j = await r.json().catch(() => ({}));
  toolsCache = Array.isArray(j.tools) ? j.tools : [];
  return toolsCache;
}
async function callTool(name, args) {
  const r = await fetch(DOOR, { method: "POST", headers: { "content-type": "application/json", "x-ng-agent-key": KEY }, body: JSON.stringify({ tool: name, args: args ?? {} }) });
  const j = await r.json().catch(() => ({ error: `bad_response_${r.status}` }));
  return { isError: !r.ok, text: JSON.stringify(r.ok ? j.result : { error: j.error ?? `http_${r.status}` }, null, 1) };
}

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return reply(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "neugrid-belt", version: "0.1.0" } });
    case "notifications/initialized":
      return;
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: await tools() });
    case "tools/call": {
      const { name, arguments: args } = params ?? {};
      try {
        const out = await callTool(name, args);
        return reply(id, { content: [{ type: "text", text: out.text }], isError: out.isError });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? "call_failed" }) }], isError: true });
      }
    }
    case "resources/list": return reply(id, { resources: [] });
    case "prompts/list": return reply(id, { prompts: [] });
    default:
      if (id !== undefined) return fail(id, -32601, `method not found: ${method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log("bad json line"); continue; }
    handle(msg).catch((e) => log("handler error", e?.message ?? e));
  }
});
process.stdin.on("end", () => process.exit(0));
