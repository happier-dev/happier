import {
  buildMemoryRecallGuidanceBlockV1,
  HAPPIER_BASE_SYSTEM_PROMPT_ATTACHMENTS_V1,
  HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1,
  HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1,
  HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1,
  HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_ONGOING_V1,
} from '@happier-dev/protocol';

import {
  PI_BRIDGE_MEMORY_MACHINE_ID_FLAG,
  PI_BRIDGE_PROMPT_OPTIONS_FLAG,
  PI_BRIDGE_SESSION_ID_FLAG,
  PI_BRIDGE_SESSION_RENAME_FLAG,
  PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE,
} from './piBridgeExtensionEnv';

/**
 * Version of the Happier Pi tools-bridge extension. The generated file name stays
 * stable; bumping this version changes the emitted source so the write-if-changed
 * asset refresh replaces stale local copies.
 */
export const PI_BRIDGE_EXTENSION_VERSION = '3';

export type PiBridgeExtensionSourceParams = Readonly<{
  /** Executable file path for launching the Happier CLI (from the subprocess launch spec). */
  launchFilePath: string;
  /** Launch argv prefix, ending just before the `tools` subcommand. */
  launchArgPrefix: readonly string[];
  /** Extra env (e.g. dev-mode tsx flags) to merge for CLI invocations. */
  launchEnv: Readonly<Record<string, string>>;
}>;

function jsString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Build the self-contained Pi tools-bridge extension source.
 *
 * The returned string is written into `<PI_CODING_AGENT_DIR>/extensions/` and passed to
 * Pi via `--extension` by the Happier Pi launcher. It imports NOTHING from Happier and
 * uses only the Pi extension API (`pi.*`), `typebox`, and Node globals. The asset is
 * config-independent (only the CLI launch spec is baked in); every session behavior
 * rides launch flags. It:
 *   - registers the `happy-session-id` / `happy-session-rename` / `happy-prompt-options`
 *     / `happy-memory-machine-id` flags so Pi accepts them on its command line;
 *   - stays fully inert when `happy-session-id` is absent (loaded any other way, e.g. a
 *     stale global install, it registers nothing);
 *   - on `session_start` registers exactly the tools the launch config enables:
 *     `change_title` (when the rename mode is `initial`/`ongoing`) and
 *     `memory_search` / `memory_get_window` (when a memory machine id is bound);
 *   - on `before_agent_start` appends the Happier system-prompt addition — built from
 *     the SAME protocol-owned prompt blocks the daemon uses for other providers — to
 *     Pi's base system prompt, so the spawn argv carries no rendered prompt;
 *   - bridges each tool call to `happier tools call --session-id <flag> --directory <cwd>
 *     --source happier --tool <name> --args-json <json> --json` using the baked-in
 *     Happier CLI launch spec (child_process.spawn with the launch env merged), and
 *     maps the JSON envelope to a tool result.
 */
export function buildPiBridgeExtensionSource(params: PiBridgeExtensionSourceParams): string {
  return `// Happier Pi tools-bridge extension (generated). Version: ${PI_BRIDGE_EXTENSION_VERSION}.
// Self-contained: loaded by Pi's jiti runtime. No Happier imports, no npm deps beyond typebox.
import { spawn } from "node:child_process";
import { Type } from "typebox";

const SESSION_ID_FLAG = ${jsString(PI_BRIDGE_SESSION_ID_FLAG)};
const SESSION_RENAME_FLAG = ${jsString(PI_BRIDGE_SESSION_RENAME_FLAG)};
const PROMPT_OPTIONS_FLAG = ${jsString(PI_BRIDGE_PROMPT_OPTIONS_FLAG)};
const MEMORY_MACHINE_ID_FLAG = ${jsString(PI_BRIDGE_MEMORY_MACHINE_ID_FLAG)};
const TOKEN_COUNT_MARKER_TYPE = ${jsString(PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE)};
const TOOL_CALL_TIMEOUT_MS = 120000;

const HAPPIER_CLI_FILE_PATH = ${jsString(params.launchFilePath)};
const HAPPIER_CLI_ARG_PREFIX = ${JSON.stringify(params.launchArgPrefix)};
const HAPPIER_CLI_ENV = ${JSON.stringify(params.launchEnv)};

// Happier prompt blocks, inlined at generation time from @happier-dev/protocol
// (single text owner — the daemon refreshes this asset on upgrade via write-if-changed).
const SESSION_TITLE_INITIAL_BLOCK = ${JSON.stringify(HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1)};
const SESSION_TITLE_ONGOING_BLOCK = ${JSON.stringify(HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_ONGOING_V1)};
const RESPONSE_OPTIONS_BLOCK = ${JSON.stringify(HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1)};
const ATTACHMENTS_BLOCK = ${JSON.stringify(HAPPIER_BASE_SYSTEM_PROMPT_ATTACHMENTS_V1)};
const LINKED_WORKSPACE_FILES_BLOCK = ${JSON.stringify(HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1)};
const MEMORY_RECALL_BLOCK = ${JSON.stringify(buildMemoryRecallGuidanceBlockV1('generic'))};

function readFlagString(pi, name) {
  try {
    const value = typeof pi.getFlag === "function" ? pi.getFlag(name) : undefined;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

function readFlagBool(pi, name) {
  try {
    return typeof pi.getFlag === "function" && pi.getFlag(name) === true;
  } catch {
    return false;
  }
}

// Session title updates mode: absent or "disabled" is the disabled state; only the
// protocol enum values initial/ongoing enable title updates.
function readSessionRenameMode(pi) {
  const raw = readFlagString(pi, SESSION_RENAME_FLAG);
  return raw === "initial" || raw === "ongoing" ? raw : "disabled";
}

function readMemoryMachineId(pi) {
  return readFlagString(pi, MEMORY_MACHINE_ID_FLAG);
}

// The Happier system-prompt addition for this session, assembled from the launch
// config: session title guidance (rename mode), response options, the always-on
// attachments/linked-workspace blocks, and memory-recall guidance (memory machine id).
function buildHappierPromptAddition(renameMode, promptOptions, memoryMachineId) {
  const blocks = [];
  if (renameMode === "initial") blocks.push(SESSION_TITLE_INITIAL_BLOCK);
  else if (renameMode === "ongoing") blocks.push(SESSION_TITLE_ONGOING_BLOCK);
  if (promptOptions) blocks.push(RESPONSE_OPTIONS_BLOCK);
  blocks.push(ATTACHMENTS_BLOCK, LINKED_WORKSPACE_FILES_BLOCK);
  if (memoryMachineId) blocks.push(MEMORY_RECALL_BLOCK);
  return blocks.join("\\n\\n").trim();
}

// Parse the JSON envelope printed by the Happier CLI (--json). The CLI may print
// non-JSON diagnostics on the same stream; scan lines from the end for the envelope.
function parseEnvelope(stdout) {
  const trimmed = typeof stdout === "string" ? stdout.trim() : "";
  if (!trimmed) {
    return { ok: false, error: { code: "bridge_no_output", message: "Happier tools bridge returned no output" } };
  }
  const lines = trimmed.split("\\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") return parsed;
    } catch {
      // Not the envelope line; keep scanning.
    }
  }
  return { ok: false, error: { code: "bridge_invalid_output", message: trimmed.slice(0, 500) } };
}

function envelopeToToolText(envelope) {
  if (envelope.ok) {
    const output = envelope.data && typeof envelope.data === "object" && "output" in envelope.data
      ? envelope.data.output
      : (envelope.data ?? null);
    return { isError: false, text: JSON.stringify(output) };
  }
  const error = (envelope.error && typeof envelope.error === "object") ? envelope.error : {};
  const parts = ["code=" + (typeof error.code === "string" && error.code ? error.code : "unknown")];
  if (typeof error.message === "string" && error.message) parts.push(error.message);
  if (Array.isArray(error.candidates) && error.candidates.length > 0) {
    parts.push("candidates: " + error.candidates.join(", "));
  }
  return { isError: true, text: parts.join(" — ") };
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
      const message = error && typeof error.message === "string" ? error.message : String(error);
      resolve({ stdout: "", stderr: message, code: null, killed: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let killed = false;
    const killChild = () => {
      if (killed || child.exitCode !== null || child.signalCode !== null) return;
      killed = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 5000).unref?.();
    };
    if (options.signal) {
      if (options.signal.aborted) killChild();
      else options.signal.addEventListener("abort", killChild, { once: true });
    }
    let timeoutId = null;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutId = setTimeout(killChild, options.timeoutMs);
      timeoutId.unref?.();
    }
    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ stdout, stderr: stderr + String(error?.message ?? error), code: null, killed });
    });
    child.on("close", (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ stdout, stderr, code, killed });
    });
  });
}

async function callHappierTool(pi, ctx, toolName, args) {
  const sessionId = readFlagString(pi, SESSION_ID_FLAG);
  if (!sessionId) {
    return { ok: false, error: { code: "bridge_not_bound", message: "This Pi process is not bound to a Happier session (--happy-session-id missing)" } };
  }
  const argv = [
    ...HAPPIER_CLI_ARG_PREFIX,
    "tools",
    "call",
    "--session-id",
    sessionId,
    "--directory",
    typeof ctx?.cwd === "string" && ctx.cwd.trim() ? ctx.cwd : process.cwd(),
    "--source",
    "happier",
    "--tool",
    toolName,
    "--args-json",
    JSON.stringify(args ?? {}),
    "--json",
  ];
  let result;
  try {
    result = await runChild(HAPPIER_CLI_FILE_PATH, argv, {
      cwd: typeof ctx?.cwd === "string" && ctx.cwd.trim() ? ctx.cwd : undefined,
      env: { ...process.env, ...HAPPIER_CLI_ENV },
      timeoutMs: TOOL_CALL_TIMEOUT_MS,
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });
  } catch (error) {
    const message = error && typeof error.message === "string" ? error.message : String(error);
    return { ok: false, error: { code: "bridge_exec_failed", message } };
  }
  if (result && result.killed) {
    return { ok: false, error: { code: "bridge_timeout", message: "Happier tools bridge call timed out or was aborted" } };
  }
  return parseEnvelope(result ? result.stdout : "");
}

function toolResult(envelope) {
  const mapped = envelopeToToolText(envelope);
  const result = {
    content: [{ type: "text", text: mapped.text }],
    details: { envelope },
  };
  return mapped.isError ? { ...result, isError: true } : result;
}

// The memory machine id bound at launch is the default for memory tool calls; an
// explicit per-call machineId parameter overrides it.
function boundMemoryMachineId(pi, explicit) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  return readMemoryMachineId(pi);
}

// Live context telemetry: after each assistant message, publish pi's context usage as a
// single-line JSON marker on stderr. The Happier Pi RPC backend parses these markers and
// merges them into its per-turn token_count agent message (context_used_tokens /
// context_window_tokens), giving Pi sessions a live context-size badge like Claude and
// OpenCode. Stderr is a machine-readable side channel that does not touch the LLM context.
function emitContextTelemetryMarker(ctx) {
  let usage = null;
  try {
    usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : null;
  } catch {
    usage = null;
  }
  if (!usage || typeof usage !== "object") return;
  const used = typeof usage.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= 0
    ? Math.trunc(usage.tokens)
    : null;
  const size = typeof usage.contextWindow === "number" && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
    ? Math.trunc(usage.contextWindow)
    : null;
  if (used === null || used <= 0 || size === null) return;
  try {
    process.stderr.write(JSON.stringify({ type: TOKEN_COUNT_MARKER_TYPE, used, size }) + "\\n");
  } catch {
    // Best-effort telemetry; never fail the turn over it.
  }
}

// Pi extension factory: registers the bridge flags up front, then registers the bridge
// tools and the prompt-addition hook on session_start only when the session binding flag
// is present. Happier passes this generated file through Pi's --extension argument
// together with the --happy-* config flags.
export default function HappierPiToolsBridgeExtension(pi) {
  pi.registerFlag(SESSION_ID_FLAG, {
    description: "Happier session id this Pi process is bound to",
    type: "string",
  });
  pi.registerFlag(SESSION_RENAME_FLAG, {
    description: "Happier session title updates mode (initial or ongoing; absent disables title updates)",
    type: "string",
  });
  pi.registerFlag(PROMPT_OPTIONS_FLAG, {
    description: "Enable the Happier response options (<options>) guidance",
    type: "boolean",
    default: false,
  });
  pi.registerFlag(MEMORY_MACHINE_ID_FLAG, {
    description: "Happier daemon machine id binding the memory bridge tools",
    type: "string",
  });

  let registered = false;
  pi.on("session_start", (_event, _ctx) => {
    if (registered) return;
    if (!readFlagString(pi, SESSION_ID_FLAG)) return; // Not launched by Happier: stay inert.
    registered = true;

    const renameMode = readSessionRenameMode(pi);
    const memoryMachineId = readMemoryMachineId(pi);

    // Context telemetry rides the session binding (never the per-tool config flags): the
    // live context badge is core session UX, not an advertised tool.
    pi.on("message_end", (event, ctx) => {
      const message = event && typeof event === "object" ? event.message : null;
      if (!message || typeof message !== "object" || message.role !== "assistant") return;
      emitContextTelemetryMarker(ctx);
    });

    // The Happier system-prompt addition is appended to pi's own base system prompt on
    // every agent run, before the first LLM call. It is built from the same launch
    // config that gates the tools below, so prompt and tool inventory never drift.
    pi.on("before_agent_start", async (event) => {
      const addition = buildHappierPromptAddition(
        readSessionRenameMode(pi),
        readFlagBool(pi, PROMPT_OPTIONS_FLAG),
        readMemoryMachineId(pi),
      );
      if (!addition) return undefined;
      const base = event && typeof event.systemPrompt === "string" ? event.systemPrompt.trim() : "";
      return { systemPrompt: base ? base + "\\n\\n" + addition : addition };
    });

    if (renameMode !== "disabled") {
      pi.registerTool({
        name: "change_title",
        label: "Change Chat Title",
        description: "Change the title of the current Happier chat session",
        parameters: Type.Object({
          title: Type.String({ minLength: 1, description: "New short descriptive session title" }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const title = typeof params.title === "string" ? params.title.trim() : "";
          if (!title) {
            return toolResult({ ok: false, error: { code: "invalid_arguments", message: "title must be a non-empty string" } });
          }
          return toolResult(await callHappierTool(pi, ctx, "change_title", { title }));
        },
      });
    }

    if (memoryMachineId) {
      pi.registerTool({
        name: "memory_search",
        label: "Search Memory",
        description: "Search across past Happier sessions using the daemon-local memory index",
        parameters: Type.Object({
          query: Type.String({ minLength: 1, description: "What to search for" }),
          mode: Type.Optional(Type.String({ description: "Search mode: auto or hints (default auto)" })),
          scopeType: Type.Optional(Type.String({ description: "Memory scope: global or machine (default global)" })),
          machineId: Type.Optional(Type.String({ description: "Machine running the daemon memory index (defaults to the bound machine)" })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const machineId = boundMemoryMachineId(pi, params.machineId);
          if (!machineId) {
            return toolResult({ ok: false, error: { code: "invalid_arguments", message: "machineId is required (no bound machine id provided at launch)" } });
          }
          const scopeType = typeof params.scopeType === "string" && params.scopeType.trim() ? params.scopeType.trim() : "global";
          const mode = typeof params.mode === "string" && params.mode.trim() ? params.mode.trim() : "auto";
          const args = {
            machineId,
            query: { v: 1, query: params.query, scope: { type: scopeType }, mode },
          };
          return toolResult(await callHappierTool(pi, ctx, "memory_search", args));
        },
      });

      pi.registerTool({
        name: "memory_get_window",
        label: "Get Memory Window",
        description: "Fetch a transcript window to verify or quote a memory_search hit",
        parameters: Type.Object({
          sessionId: Type.String({ minLength: 1, description: "Session id from a memory_search hit (NOT the current session)" }),
          seqFrom: Type.Integer({ minimum: 0, description: "First sequence number (inclusive)" }),
          seqTo: Type.Integer({ minimum: 0, description: "Last sequence number (inclusive)" }),
          machineId: Type.Optional(Type.String({ description: "Machine running the daemon memory index (defaults to the bound machine)" })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const machineId = boundMemoryMachineId(pi, params.machineId);
          if (!machineId) {
            return toolResult({ ok: false, error: { code: "invalid_arguments", message: "machineId is required (no bound machine id provided at launch)" } });
          }
          const args = {
            machineId,
            sessionId: params.sessionId,
            seqFrom: params.seqFrom,
            seqTo: params.seqTo,
          };
          return toolResult(await callHappierTool(pi, ctx, "memory_get_window", args));
        },
      });
    }
  });
}
`;
}
