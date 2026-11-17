import { formatMcpToolWireNameV1 } from '@happier-dev/plugin-sdk/agents/runtime';
// Emitted inside the native extension alongside its schema validator and notice codec.
export function buildPiMcpExtensionSource(): string {
  return `const formatMcpToolWireNameV1 = ${formatMcpToolWireNameV1.toString()};
// Meta Muse/OpenAI-compatible function names have a 64-character boundary.
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
function providerMcpToolName(serverName, toolName) {
  const original = formatMcpToolWireNameV1(serverName, toolName);
  const aliasPrefix = "mcp__h__";
  if (original.length <= 64 && /^[A-Za-z0-9_-]+$/.test(original) && !original.startsWith(aliasPrefix)) return original;
  // Retain the full SHA-256 digest. Base64url leaves room for a readable prefix.
  // Reserve the alias namespace so an unchanged short name cannot shadow it.
  const hash = createHash("sha256").update(original).digest("base64url");
  const prefixLength = 64 - aliasPrefix.length - 1 - hash.length;
  return aliasPrefix + original.slice(5, 5 + prefixLength).replace(/[^A-Za-z0-9_-]/g, "_") + "_" + hash;
}

function openMcpServer(server, cwd) {
  const child = spawn(server.command, server.args || [], {
    cwd, env: { ...process.env, ...(server.env || {}) }, shell: false,
    windowsHide: true,
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

function createMcpServers(pi, config, onRegistered) {
  const connections = new Set();
  const failures = [];
  let stopped = false;
  let discovery = Promise.resolve();
  const strict = config.mcpServersStrictMode === true;
  const publishFailures = () => {
    // RPC mode redirects console output; retain the original protocol descriptor.
    if (!stopped && failures.length) fs.writeSync(1, JSON.stringify({ type: MCP_CAPABILITY_NOTICE_RECORD_TYPE,
      notice: { v: 1, items: failures } }) + "\\n");
  };
  const closeConnections = async () => {
    const closing = [...connections];
    connections.clear();
    await Promise.all(closing.map(connection => connection.close()));
  };
  const discover = async ([serverName, server]) => {
    if (stopped) return;
    let connection;
    let stage = "spawn";
    try {
      connection = openMcpServer(server, config.directory);
      connections.add(connection);
      await connection.spawned;
      if (stopped) return;
      stage = "initialize";
      const initialized = await connection.request("initialize", { protocolVersion: "2024-11-05",
        capabilities: {}, clientInfo: { name: "happier-pi", version: "1" } });
      if (initialized.protocolVersion !== "2024-11-05") throw new Error("MCP server negotiated an unsupported protocol version");
      if (stopped) return;
      connection.notify("notifications/initialized", {});
      stage = "list";
      const tools = [];
      let cursor;
      do {
        const catalog = await connection.request("tools/list", cursor ? { cursor } : {});
        if (stopped) return;
        tools.push(...catalog.tools);
        cursor = catalog.nextCursor;
      } while (cursor);
      // Check the complete selected catalog before registration: a failed
      // later page or schema must not bind tools to a closed connection.
      const selectedTools = tools.filter((tool) => {
        if (server.enabledTools && !server.enabledTools.includes(tool.name)) return false;
        const policy = config.mcpToolPolicy && Object.hasOwn(config.mcpToolPolicy, serverName)
          ? config.mcpToolPolicy[serverName] : undefined;
        const decision = policy && Object.hasOwn(policy.tools, tool.name) ? policy.tools[tool.name] : policy?.unlisted;
        return decision !== "off" && decision !== "deny";
      });
      for (const tool of selectedTools) assertToolParameters(tool.inputSchema);
      if (stopped) return;
      const names = [];
      const aliases = {};
      for (const tool of selectedTools) {
        const name = providerMcpToolName(serverName, tool.name);
        const originalName = formatMcpToolWireNameV1(serverName, tool.name);
        if (name !== originalName) aliases[name] = originalName;
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
      onRegistered(names, aliases);
    } catch (error) {
      if (connection) {
        connections.delete(connection);
        await connection.close();
      }
      if (stopped) return;
      // Peer errors can include secrets. Only the observed stage crosses RPC.
      failures.push({ kind: "mcp_server", name: serverName, code: "mcp_" + stage + "_failed" });
      if (strict) throw new Error("MCP server " + serverName + " could not start (" + stage + ")");
      publishFailures();
    }
  };
  return {
    async start() {
      const servers = Object.entries(config.mcpServers || {});
      if (strict) {
        // Explicit strict selection retains its existing joined startup contract.
        discovery = (async () => {
          try { for (const server of servers) await discover(server); }
          catch (error) { await closeConnections(); publishFailures(); throw error; }
        })();
        await discovery;
      } else {
        // Pi supports live registerTool refresh. Optional peers never hold the RPC
        // reader or each other; tools become available when their catalog arrives.
        discovery = Promise.all(servers.map(discover)).then(() => {});
        // Every peer failure is published above. Also retain the promise for shutdown.
        void discovery.catch(() => {});
      }
    },
    async close() {
      stopped = true;
      await closeConnections();
      await discovery.catch(() => {});
    },
  };
}
`;
}
