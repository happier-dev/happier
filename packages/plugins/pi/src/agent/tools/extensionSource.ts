export const PI_HAPPIER_TOOLS_CONFIG_FLAG = 'happier-tools-config';

export function buildPiHappierToolsExtensionSource(): string {
  return `// Happier Pi native tools extension. Generated; tool policy is host-owned.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const CONFIG_FLAG = ${JSON.stringify(PI_HAPPIER_TOOLS_CONFIG_FLAG)};
const BRIDGE_OUTPUT_MAX_BYTES = 1024 * 1024;
const BRIDGE_OUTPUT_MAX_LINES = 4000;
const TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
const TOOL_OUTPUT_MAX_LINES = 2000;
const TOOL_OUTPUT_NOTICE_RESERVE_BYTES = 256;

function isStringRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "string");
}

function isConfig(value) {
  return Boolean(
    value && value.v === 1
    && typeof value.sessionId === "string" && value.sessionId.trim()
    && typeof value.directory === "string" && value.directory.trim()
    && typeof value.systemPrompt === "string"
    && Array.isArray(value.tools)
    && value.tools.every((tool) => (
      tool && typeof tool === "object"
      && typeof tool.name === "string" && tool.name.trim()
      && typeof tool.title === "string"
      && typeof tool.description === "string"
      && tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
    ))
    && value.launch && typeof value.launch === "object"
    && typeof value.launch.executablePath === "string" && value.launch.executablePath.trim()
    && Array.isArray(value.launch.argsPrefix)
    && value.launch.argsPrefix.every((entry) => typeof entry === "string")
    && (value.launch.env === undefined || isStringRecord(value.launch.env))
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
    child.stdout?.on("data", (chunk) => stdout.append(chunk));
    child.stderr?.on("data", (chunk) => stderr.append(chunk));
    child.once("error", (error) => finish({ ok: false, error: { code: "bridge_spawn_failed", message: String(error?.message || error) } }));
    child.once("close", (code) => {
      if (killed) {
        finish({ ok: false, error: { code: "bridge_cancelled", message: "Happier tool call was cancelled" } });
        return;
      }
      if (stdout.limited || stderr.limited) {
        finish({ ok: false, error: { code: "bridge_output_limit", message: "Happier tools bridge output exceeded its bounded transport limit" } });
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

export default function happierPiToolsExtension(pi) {
  pi.registerFlag(CONFIG_FLAG, { description: "Happier session tool configuration", type: "string" });
  let registered = false;
  pi.on("session_start", () => {
    if (registered) return;
    const config = readConfig(pi);
    if (!config) return;
    registered = true;
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
  });
}
`;
}
