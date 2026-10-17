export const PI_HAPPIER_TOOLS_CONFIG_FLAG = 'happier-tools-config';
export const PI_MCP_APPROVAL_CALL_PREFIX = 'happier:mcp-approval:';
export const PI_MCP_CAPABILITY_NOTICE_RECORD_TYPE = 'happier-pi-mcp-capability-notice';
export const PI_USER_INPUT_NOTIFICATION_TYPE = 'happy-pi-user-input';

export function buildPiHappierToolsExtensionSource(): string {
  return `// Happier Pi native tools extension. Generated; tool policy is host-owned.
import { spawn } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const CONFIG_FLAG = ${JSON.stringify(PI_HAPPIER_TOOLS_CONFIG_FLAG)};
const MCP_APPROVAL_CALL_PREFIX = ${JSON.stringify(PI_MCP_APPROVAL_CALL_PREFIX)};
const MCP_CAPABILITY_NOTICE_RECORD_TYPE = ${JSON.stringify(PI_MCP_CAPABILITY_NOTICE_RECORD_TYPE)};
const USER_INPUT_NOTIFICATION_TYPE = ${JSON.stringify(PI_USER_INPUT_NOTIFICATION_TYPE)};
const BRIDGE_OUTPUT_MAX_BYTES = 1024 * 1024;
const BRIDGE_OUTPUT_MAX_LINES = 4000;
const TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
const TOOL_OUTPUT_MAX_LINES = 2000;
const TOOL_OUTPUT_NOTICE_RESERVE_BYTES = 256;

function isToolDecision(value) {
  return value === "off" || value === "deny" || value === "ask" || value === "allow";
}

function isStringRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "string");
}

function isConfig(value) {
  return Boolean(
    value && value.v === 1
    && typeof value.directory === "string" && value.directory.trim()
    && typeof value.systemPrompt === "string"
    && Array.isArray(value.tools)
    && (value.mcpServersStrictMode === undefined || typeof value.mcpServersStrictMode === "boolean")
    && value.tools.every((tool) => (
      tool && typeof tool === "object"
      && typeof tool.name === "string" && tool.name.trim()
      && typeof tool.title === "string"
      && typeof tool.description === "string"
      && tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
    ))
    && ((value.launch === undefined && value.tools.length === 0) || (value.launch && typeof value.launch === "object"
    && typeof value.launch.executablePath === "string" && value.launch.executablePath.trim()
    && Array.isArray(value.launch.argsPrefix)
    && value.launch.argsPrefix.every((entry) => typeof entry === "string")
    && (value.launch.env === undefined || isStringRecord(value.launch.env))))
    && (value.mcpToolPolicy === undefined || (value.mcpToolPolicy && typeof value.mcpToolPolicy === "object"
      && !Array.isArray(value.mcpToolPolicy) && Object.values(value.mcpToolPolicy).every((policy) => (
        policy && (policy.unlisted === "allow" || policy.unlisted === "ask" || policy.unlisted === "deny")
        && policy.tools && typeof policy.tools === "object" && !Array.isArray(policy.tools)
        && Object.values(policy.tools).every(isToolDecision)
      ))))
    && (value.mcpServers === undefined || (value.mcpServers && typeof value.mcpServers === "object"
      && !Array.isArray(value.mcpServers) && Object.values(value.mcpServers).every((server) => (
        server && typeof server.command === "string" && server.command.trim()
        && (server.args === undefined || (Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string")))
        && (server.env === undefined || isStringRecord(server.env))
        && (server.enabledTools === undefined || (Array.isArray(server.enabledTools) && server.enabledTools.every((name) => typeof name === "string")))
      ))))
  );
}

function readConfig(pi) {
  try {
    const path = pi.getFlag(CONFIG_FLAG);
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!isConfig(value)) return null;
    return value;
  } catch { return null; }
}

function parseEnvelope(stdout) {
  for (const line of String(stdout || "").trim().split("\\n").reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value.ok === "boolean") return value;
    } catch {}
  }
  return { ok: false, error: { code: "bridge_invalid_output", message: "Happier tools bridge returned invalid output" } };
}

function truncateToolOutput(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const totalBytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\\n");
  const totalLines = lines.length;
  let content = lines.slice(0, TOOL_OUTPUT_MAX_LINES).join("\\n");
  const contentByteLimit = TOOL_OUTPUT_MAX_BYTES - TOOL_OUTPUT_NOTICE_RESERVE_BYTES;
  if (Buffer.byteLength(content, "utf8") > contentByteLimit) {
    const bytes = Buffer.from(content, "utf8");
    let end = contentByteLimit;
    while (end > 0) {
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
        break;
      } catch {
        end -= 1;
      }
    }
  }
  const truncated = totalLines > TOOL_OUTPUT_MAX_LINES || totalBytes > Buffer.byteLength(content, "utf8");
  if (!truncated) return { content, truncated: false };
  const notice = "\\n\\n[Happier tool output truncated: showing the first "
    + Buffer.byteLength(content, "utf8") + " of " + totalBytes
    + " bytes and at most " + TOOL_OUTPUT_MAX_LINES + " lines]";
  return { content: content + notice, truncated: true, totalBytes, totalLines };
}

function toResult(envelope) {
  if (envelope.ok) {
    const output = envelope.data && typeof envelope.data === "object" && "output" in envelope.data
      ? envelope.data.output : (envelope.data ?? null);
    const projected = truncateToolOutput(JSON.stringify(output) ?? "null");
    return { content: [{ type: "text", text: projected.content }], details: { truncation: projected } };
  }
  const error = envelope.error && typeof envelope.error === "object" ? envelope.error : {};
  const parts = ["code=" + (typeof error.code === "string" && error.code ? error.code : "unknown")];
  if (typeof error.message === "string" && error.message) parts.push(error.message);
  if (Array.isArray(error.candidates) && error.candidates.length > 0) {
    parts.push("candidates: " + error.candidates.join(", "));
  }
  const projected = truncateToolOutput(parts.join(" — "));
  throw new Error(projected.content);
}

function invoke(config, toolName, args, callId, signal, cwd) {
  return new Promise((resolve) => {
    const child = spawn(config.launch.executablePath, [
      ...config.launch.argsPrefix,
      "--tool", toolName,
      "--args-json", JSON.stringify(args ?? {}),
      ...(typeof callId === "string" && callId.trim() ? ["--tool-call-id", callId.trim()] : []),
      "--json",
    ], {
      cwd,
      env: { ...process.env, ...(config.launch.env || {}) },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const createOutputCollector = () => {
      const chunks = [];
      let bytes = 0;
      let lines = 1;
      let limited = false;
      return {
        append(data) {
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8");
          lines += (chunk.toString("utf8").match(/\\n/g) ?? []).length;
          const remaining = Math.max(0, BRIDGE_OUTPUT_MAX_BYTES - bytes);
          if (remaining > 0) {
            const accepted = chunk.subarray(0, remaining);
            chunks.push(accepted);
            bytes += accepted.length;
          }
          if (chunk.length > remaining || lines > BRIDGE_OUTPUT_MAX_LINES) limited = true;
        },
        text() { return Buffer.concat(chunks, bytes).toString("utf8"); },
        get limited() { return limited; },
      };
    };
    const stdout = createOutputCollector();
    const stderr = createOutputCollector();
    let settled = false;
    let killed = false;
    let forceKillTimer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener?.("abort", abort);
      resolve(value);
    };
    const abort = () => {
      if (killed || child.exitCode !== null || child.signalCode !== null) return;
      killed = true;
      try { child.kill("SIGTERM"); } catch {}
      forceKillTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
      forceKillTimer.unref?.();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener?.("abort", abort, { once: true });
    child.stdout?.on("data", (chunk) => {
      stdout.append(chunk);
      if (stdout.limited) abort();
    });
    child.stderr?.on("data", (chunk) => {
      stderr.append(chunk);
      if (stderr.limited) abort();
    });
    child.once("error", (error) => finish({ ok: false, error: { code: "bridge_spawn_failed", message: String(error?.message || error) } }));
    child.once("close", (code) => {
      if (stdout.limited || stderr.limited) {
        finish({ ok: false, error: { code: "bridge_output_limit", message: "Happier tools bridge output exceeded its bounded transport limit" } });
        return;
      }
      if (killed) {
        finish({ ok: false, error: { code: "bridge_cancelled", message: "Happier tool call was cancelled" } });
        return;
      }
      if (!stdout.text().trim() && code !== 0) {
        const diagnostic = stderr.text().trim().slice(0, 500);
        const exit = code === null ? "unavailable" : String(code);
        finish({
          ok: false,
          error: {
            code: "bridge_process_failed",
            message: "Happier tools bridge exited with code " + exit + (diagnostic ? ": " + diagnostic : ""),
          },
        });
        return;
      }
      finish(parseEnvelope(stdout.text()));
    });
  });
}

function openMcpServer(server, cwd) {
  const child = spawn(server.command, server.args || [], {
    cwd, env: { ...process.env, ...(server.env || {}) }, shell: false,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map();
  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  let nextId = 0;
  let failure = null;
  const closed = new Promise((resolve) => child.once("close", resolve));
  const fail = (error) => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.once("error", fail);
  child.once("close", () => fail(new Error("MCP server closed")));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch { fail(new Error("MCP server returned invalid JSON")); return; }
    if (message.method) {
      if (message.id !== undefined) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
        ...(message.method === "ping" ? { result: {} }
          : { error: { code: -32601, message: "Method not supported" } }) }) + "\\n");
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(String(message.error.message || "MCP request failed")));
    else request.resolve(message.result);
  });
  child.stdin.on("error", fail);
  const notify = (method, params) => {
    if (!failure) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");
  };
  const request = (method, params, signal) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    if (signal?.aborted) { reject(new Error("MCP tool call cancelled")); return; }
    const id = ++nextId;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      pending.delete(id);
      notify("notifications/cancelled", { requestId: id, reason: "Tool call cancelled" });
      cleanup();
      reject(new Error("MCP tool call cancelled"));
    };
    pending.set(id, {
      resolve(value) { cleanup(); resolve(value); },
      reject(error) { cleanup(); reject(error); },
    });
    signal?.addEventListener("abort", abort, { once: true });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n", (error) => {
      if (error) fail(error);
    });
  });
  return {
    spawned, request, notify,
    async close() {
      fail(new Error("MCP session closed"));
      lines.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
    },
  };
}

export default function happierPiToolsExtension(pi) {
  pi.registerFlag(CONFIG_FLAG, { description: "Happier session tool configuration", type: "string" });
  let registered = false;
  const connections = [];
  const closeConnections = async () => {
    await Promise.all(connections.splice(0).map((connection) => connection.close()));
  };
  pi.on("session_shutdown", closeConnections);
  pi.on("session_start", async () => {
    if (registered) return;
    const config = readConfig(pi);
    if (!config) return;
    registered = true;
    // Explicit CLI extensions load before discovered user extensions. Observe submission
    // before another input handler can transform or handle it; RPC input is already host-owned.
    pi.on("input", (event, ctx) => {
      if (event.source === "extension" && typeof event.text === "string" && event.text.length > 0) {
        ctx.ui.notify(JSON.stringify({ type: USER_INPUT_NOTIFICATION_TYPE, text: event.text }));
      }
    });
    pi.on("before_agent_start", (event) => {
      const addition = String(config.systemPrompt || "").trim();
      if (!addition) return undefined;
      const base = typeof event?.systemPrompt === "string" ? event.systemPrompt.trim() : "";
      return { systemPrompt: base ? base + "\\n\\n" + addition : addition };
    });
    for (const tool of config.tools) {
      pi.registerTool({
        name: tool.name,
        label: tool.title,
        description: tool.description,
        parameters: tool.inputSchema,
        async execute(callId, args, signal, _onUpdate, ctx) {
          const cwd = typeof ctx?.cwd === "string" && ctx.cwd.trim() ? ctx.cwd : config.directory;
          return toResult(await invoke(config, tool.name, args, callId, signal, cwd));
        },
      });
    }
    const failures = [];
    const publishFailures = () => {
      // Pi 0.82.1 redirects extension stdout writes to stderr in RPC mode.
      // Emit this protocol record on the original stdout descriptor instead.
      if (failures.length) fs.writeSync(1, JSON.stringify({ type: MCP_CAPABILITY_NOTICE_RECORD_TYPE,
        notice: { v: 1, items: failures } }) + "\\n");
    };
    try {
      const names = [];
      for (const [serverName, server] of Object.entries(config.mcpServers || {})) {
        let connection;
        let stage = "spawn";
        try {
          connection = openMcpServer(server, config.directory);
          connections.push(connection);
          await connection.spawned;
          stage = "initialize";
          const initialized = await connection.request("initialize", { protocolVersion: "2024-11-05",
            capabilities: {}, clientInfo: { name: "happier-pi", version: "1" } });
          if (initialized.protocolVersion !== "2024-11-05") throw new Error("MCP server negotiated an unsupported protocol version");
          connection.notify("notifications/initialized", {});
          stage = "list";
          const tools = [];
          let cursor;
          do {
            const catalog = await connection.request("tools/list", cursor ? { cursor } : {});
            tools.push(...catalog.tools);
            cursor = catalog.nextCursor;
          } while (cursor);
          // A failed later page must not leave tools bound to a closed server.
          for (const tool of tools) {
            if (server.enabledTools && !server.enabledTools.includes(tool.name)) continue;
            const policy = config.mcpToolPolicy && Object.hasOwn(config.mcpToolPolicy, serverName)
              ? config.mcpToolPolicy[serverName] : undefined;
            const decision = policy && Object.hasOwn(policy.tools, tool.name) ? policy.tools[tool.name] : policy?.unlisted;
            if (decision === "off" || decision === "deny") continue;
            const name = "mcp__" + serverName + "__" + tool.name;
            names.push(name);
            pi.registerTool({ name, label: tool.title || tool.name,
              description: tool.description || "", parameters: tool.inputSchema,
              async execute(callId, args, signal, _onUpdate, ctx) {
                if (signal?.aborted) throw new Error("MCP tool call cancelled");
                if (typeof callId !== "string" || !callId) throw new Error("MCP tool call has no native identity");
                const approved = await ctx?.ui?.confirm(MCP_APPROVAL_CALL_PREFIX + callId, "", { signal });
                if (!approved) throw new Error("MCP tool call denied");
                const result = await connection.request("tools/call", { name: tool.name, arguments: args ?? {} }, signal);
                if (result.isError) throw new Error((result.content || []).map((item) => item.text || "").join("\\n") || "MCP tool call failed");
                return { content: (result.content || []).map((item) => (
                  item.type === "text" || item.type === "image" ? item
                    : { type: "text", text: JSON.stringify(item) }
                )), details: { structuredContent: result.structuredContent } };
              },
            });
          }
        } catch (error) {
          if (connection) {
            connections.splice(connections.indexOf(connection), 1);
            await connection.close();
          }
          // Raw peer/process errors can contain resolved secrets. Publish only
          // the observed stage and server identity through the host notice seam.
          failures.push({ kind: "mcp_server", name: serverName, code: "mcp_" + stage + "_failed" });
          if (config.mcpServersStrictMode === true) throw new Error("MCP server " + serverName + " could not start (" + stage + ")");
        }
      }
      if (names.length) pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
      publishFailures();
    } catch (error) {
      await closeConnections();
      publishFailures();
      throw error;
    }
  });
}
`;
}
