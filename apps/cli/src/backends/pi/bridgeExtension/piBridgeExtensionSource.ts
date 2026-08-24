import { PI_BRIDGE_CONFIG_PATH_FLAG, PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE } from './piBridgeExtensionEnv';

export const PI_BRIDGE_EXTENSION_VERSION = '4';

function jsString(value: string): string {
  return JSON.stringify(value);
}

export function buildPiBridgeExtensionSource(): string {
  return `// Happier Pi tools-bridge extension (generated). Version: ${PI_BRIDGE_EXTENSION_VERSION}.
// Generic adapter: the host-owned protected session manifest owns tool policy and prompt guidance.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const CONFIG_PATH_FLAG = ${jsString(PI_BRIDGE_CONFIG_PATH_FLAG)};
const TOKEN_COUNT_MARKER_TYPE = ${jsString(PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE)};
const TOOL_CALL_TIMEOUT_MS = 120000;
const TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
const TOOL_OUTPUT_MAX_LINES = 2000;
const TOOL_OUTPUT_NOTICE_RESERVE_BYTES = 256;

function readFlagString(pi, name) {
  try {
    const value = typeof pi.getFlag === "function" ? pi.getFlag(name) : undefined;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

function readSessionConfig(pi) {
  const path = readFlagString(pi, CONFIG_PATH_FLAG);
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || parsed.v !== 1 || typeof parsed.sessionId !== "string" || !parsed.sessionId.trim()) return null;
    if (!Array.isArray(parsed.directTools) || typeof parsed.promptAddition !== "string") return null;
    if (!parsed.launch || typeof parsed.launch !== "object") return null;
    if (typeof parsed.launch.filePath !== "string" || !parsed.launch.filePath.trim()) return null;
    if (!Array.isArray(parsed.launch.argPrefix) || !parsed.launch.argPrefix.every((value) => typeof value === "string")) return null;
    if (!parsed.launch.env || typeof parsed.launch.env !== "object" || Array.isArray(parsed.launch.env)) return null;
    if (!Object.values(parsed.launch.env).every((value) => typeof value === "string")) return null;
    const directTools = [];
    for (const tool of parsed.directTools) {
      if (!tool || typeof tool !== "object") return null;
      if (typeof tool.name !== "string" || !tool.name.trim()) return null;
      if (typeof tool.title !== "string" || !tool.title.trim()) return null;
      if (typeof tool.description !== "string" || !tool.description.trim()) return null;
      if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) return null;
      if (!tool.call || typeof tool.call !== "object" || typeof tool.call.toolName !== "string" || !tool.call.toolName.trim()) return null;
      if (tool.call.actionId !== null && (typeof tool.call.actionId !== "string" || !tool.call.actionId.trim())) return null;
      directTools.push(tool);
    }
    return { ...parsed, sessionId: parsed.sessionId.trim(), directTools };
  } catch {
    return null;
  }
}

function parseEnvelope(stdout) {
  const trimmed = typeof stdout === "string" ? stdout.trim() : "";
  if (!trimmed) return { ok: false, error: { code: "bridge_no_output", message: "Happier tools bridge returned no output" } };
  const lines = trimmed.split("\\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") return parsed;
    } catch {}
  }
  return { ok: false, error: { code: "bridge_invalid_output", message: trimmed.slice(0, 500) } };
}

function truncateToolOutput(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const totalBytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\\n");
  const totalLines = lines.length;
  let content = lines.slice(0, TOOL_OUTPUT_MAX_LINES).join("\\n");
  const contentByteLimit = TOOL_OUTPUT_MAX_BYTES - TOOL_OUTPUT_NOTICE_RESERVE_BYTES;
  if (Buffer.byteLength(content, "utf8") > contentByteLimit) {
    content = Buffer.from(content, "utf8").subarray(0, contentByteLimit).toString("utf8");
  }
  const truncated = totalLines > TOOL_OUTPUT_MAX_LINES || totalBytes > Buffer.byteLength(content, "utf8");
  if (!truncated) return { content, truncated: false };
  const notice = "\\n\\n[Output truncated: showing the first " + Buffer.byteLength(content, "utf8")
    + " of " + totalBytes + " bytes and at most " + TOOL_OUTPUT_MAX_LINES + " lines]";
  return { content: content + notice, truncated: true, totalBytes, totalLines };
}

function envelopeToToolResult(envelope) {
  if (envelope.ok) {
    const output = envelope.data && typeof envelope.data === "object" && "output" in envelope.data
      ? envelope.data.output
      : (envelope.data ?? null);
    const projected = truncateToolOutput(JSON.stringify(output) ?? "null");
    return { content: [{ type: "text", text: projected.content }], details: { truncation: projected } };
  }
  const error = envelope.error && typeof envelope.error === "object" ? envelope.error : {};
  const parts = ["code=" + (typeof error.code === "string" && error.code ? error.code : "unknown")];
  if (typeof error.message === "string" && error.message) parts.push(error.message);
  if (Array.isArray(error.candidates) && error.candidates.length > 0) parts.push("candidates: " + error.candidates.join(", "));
  const projected = truncateToolOutput(parts.join(" — "));
  return {
    content: [{ type: "text", text: projected.content }],
    details: { truncation: projected },
    isError: true,
  };
}

function runChild(filePath, argv, options) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(filePath, argv, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ stdout: "", stderr: String(error?.message ?? error), code: null, killed: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let timeoutId = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      options.signal?.removeEventListener?.("abort", killChild);
      resolve(result);
    };
    const killChild = () => {
      if (killed || child.exitCode !== null || child.signalCode !== null) return;
      killed = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000).unref?.();
    };
    if (options.signal) {
      if (options.signal.aborted) killChild();
      else options.signal.addEventListener("abort", killChild, { once: true });
    }
    timeoutId = setTimeout(killChild, options.timeoutMs);
    timeoutId.unref?.();
    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });
    child.once("error", (error) => finish({ stdout, stderr: stderr + String(error?.message ?? error), code: null, killed }));
    child.once("close", (code) => finish({ stdout, stderr, code, killed }));
  });
}

async function callHappierTool(config, toolName, args, signal, cwd) {
  const argv = [
    ...config.launch.argPrefix,
    "tools", "call",
    "--session-id", config.sessionId,
    "--directory", cwd,
    "--source", "happier",
    "--tool", toolName,
    "--args-json", JSON.stringify(args ?? {}),
    "--session-agent-bridge",
    "--json",
  ];
  const result = await runChild(config.launch.filePath, argv, {
    cwd,
    env: { ...process.env, ...config.launch.env },
    timeoutMs: TOOL_CALL_TIMEOUT_MS,
    signal,
  });
  if (result.killed) return { ok: false, error: { code: "bridge_cancelled", message: "Happier tool call was cancelled or timed out" } };
  return parseEnvelope(result.stdout);
}

function emitContextTelemetryMarker(ctx) {
  let usage = null;
  try { usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : null; } catch {}
  if (!usage || typeof usage !== "object") return;
  const used = typeof usage.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= 0 ? Math.trunc(usage.tokens) : null;
  const size = typeof usage.contextWindow === "number" && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0 ? Math.trunc(usage.contextWindow) : null;
  if (used === null || used <= 0 || size === null) return;
  try { process.stderr.write(JSON.stringify({ type: TOKEN_COUNT_MARKER_TYPE, used, size }) + "\\n"); } catch {}
}

export default function HappierPiToolsBridgeExtension(pi) {
  pi.registerFlag(CONFIG_PATH_FLAG, {
    description: "Protected Happier session tools-bridge configuration path",
    type: "string",
  });
  pi.registerFlag(SESSION_TOOLS_FLAG, {
    description: "Enable the full Happier session-agent tool surface (session_list, session_message_send, session_spawn_new, ...)",
    type: "boolean",
    default: false,
  });
  pi.registerFlag(DISABLED_ACTION_IDS_FLAG, {
    description: "JSON array of action ids disabled by the daemon for the session_agent surface",
    type: "string",
  });

  let registered = false;
  pi.on("session_start", () => {
    if (registered) return;
    const config = readSessionConfig(pi);
    if (!config) return;
    registered = true;

    pi.on("message_end", (event, ctx) => {
      const message = event && typeof event === "object" ? event.message : null;
      if (message && typeof message === "object" && message.role === "assistant") emitContextTelemetryMarker(ctx);
    });

    pi.on("before_agent_start", async (event) => {
      const addition = config.promptAddition.trim();
      if (!addition) return undefined;
      const base = event && typeof event.systemPrompt === "string" ? event.systemPrompt.trim() : "";
      return { systemPrompt: base ? base + "\\n\\n" + addition : addition };
    });

    for (const tool of config.directTools) {
      pi.registerTool({
        name: tool.name,
        label: tool.title,
        description: tool.description,
        parameters: tool.inputSchema,
        async execute(_toolCallId, args, signal, _onUpdate, ctx) {
          const cwd = typeof ctx?.cwd === "string" && ctx.cwd.trim() ? ctx.cwd : process.cwd();
          const callArgs = tool.call.actionId === null
            ? args
            : { actionId: tool.call.actionId, input: args };
          return envelopeToToolResult(await callHappierTool(config, tool.call.toolName, callArgs, signal, cwd));
        },
      });
    }

    // Full session-agent tool surface: opt-in via the SESSION_TOOLS_FLAG launch flag.
    // Every row bridges 1:1 through the same 'happier tools call' path as the curated
    // tools above; the only difference is that parameters are converted from the
    // inlined JSON Schema (serialized from the protocol action specs at generation
    // time) instead of being hand-written typebox objects.
    if (actionPolicyValid && readFlagBool(pi, SESSION_TOOLS_FLAG)) {
      for (const def of SESSION_AGENT_TOOL_DEFS) {
        if (def.actionId && disabledActionIds.has(def.actionId)) continue;
        pi.registerTool({
          name: def.name,
          label: def.title,
          description: def.description,
          parameters: jsonSchemaToTypebox(def.inputSchema),
          async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            if (def.name === "action_execute") {
              const requestedActionId = typeof params?.actionId === "string" ? params.actionId.trim() : "";
              if (requestedActionId && disabledActionIds.has(requestedActionId)) {
                return toolResult({
                  ok: false,
                  error: {
                    code: "action_disabled",
                    message: "This action is disabled for the session agent surface: " + requestedActionId,
                  },
                });
              }
            }
            return toolResult(await callHappierTool(pi, ctx, def.name, params));
          },
        });
      }
    }
  });
}
`;
}
