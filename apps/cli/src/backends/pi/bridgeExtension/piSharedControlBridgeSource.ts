import {
  PI_SHARED_CONTROL_ADMISSION_FRAME,
  PI_SHARED_CONTROL_BRIDGE_UNAVAILABLE_ERROR,
  PI_SHARED_CONTROL_BUSY_ERROR,
  PI_SHARED_CONTROL_INDETERMINATE_OUTCOME,
  PI_SHARED_CONTROL_PROTOCOL_VERSION,
  PI_SHARED_CONTROL_PROMPT_HANDED_OFF,
  PI_SHARED_CONTROL_SIDE_CHANNEL_EVENT,
  PI_SHARED_CONTROL_SUPPORTED_COMMANDS,
  PI_SHARED_CONTROL_UNSUPPORTED_COMMAND_ERROR,
} from '../sharedControl/piSharedControlProtocol';
import { PI_BRIDGE_USER_INPUT_MARKER_TYPE } from './piBridgeExtensionEnv';

function jsValue(value: unknown): string {
  return JSON.stringify(value);
}

/** Module imports the shared-control fragment needs; the bridge composes them at its top. */
export const PI_SHARED_CONTROL_BRIDGE_IMPORTS = 'import { connect } from "node:net";';

/**
 * Shared-control half of the generated Pi bridge (`piSharedControlProtocol.ts` owns the wire
 * contract). Runs only inside an interactive (TUI) Pi whose protected config carries
 * `sharedControl`. It dials the runner, then emits Pi-RPC-shaped records so the runner's existing
 * `PiRpcBackend` and event mapping consume them unchanged, and it executes the supported subset of
 * Pi RPC commands through the public extension API.
 *
 * The bridge confirms its call to Pi's sendUserMessage. Pi owns command and input preparation,
 * execution, and transcript turns, which the bridge forwards as they occur.
 *
 * The bridge never touches the terminal: no stdout/stderr writes and no TUI notifications. On a
 * deliberate shutdown it says `bye`; after a close or socket error every handler is inert so the
 * TUI keeps working on its own.
 */
export function buildPiSharedControlBridgeSource(): string {
  return `
const SHARED_CONTROL_PROTOCOL_VERSION = ${jsValue(PI_SHARED_CONTROL_PROTOCOL_VERSION)};
const SHARED_CONTROL_PROMPT_HANDED_OFF = ${jsValue(PI_SHARED_CONTROL_PROMPT_HANDED_OFF)};
const SHARED_CONTROL_ADMISSION_FRAME = ${jsValue(PI_SHARED_CONTROL_ADMISSION_FRAME)};
const SHARED_CONTROL_BRIDGE_UNAVAILABLE_ERROR = ${jsValue(PI_SHARED_CONTROL_BRIDGE_UNAVAILABLE_ERROR)};
const SHARED_CONTROL_SIDE_CHANNEL_EVENT = ${jsValue(PI_SHARED_CONTROL_SIDE_CHANNEL_EVENT)};
const SHARED_CONTROL_SUPPORTED_COMMANDS = ${jsValue(PI_SHARED_CONTROL_SUPPORTED_COMMANDS)};
const SHARED_CONTROL_BUSY_ERROR = ${jsValue(PI_SHARED_CONTROL_BUSY_ERROR)};
const SHARED_CONTROL_UNSUPPORTED_COMMAND_ERROR = ${jsValue(PI_SHARED_CONTROL_UNSUPPORTED_COMMAND_ERROR)};
const SHARED_CONTROL_INDETERMINATE_OUTCOME = ${jsValue(PI_SHARED_CONTROL_INDETERMINATE_OUTCOME)};
const SHARED_CONTROL_USER_INPUT_MARKER_TYPE = ${jsValue(PI_BRIDGE_USER_INPUT_MARKER_TYPE)};
const SHARED_CONTROL_FORWARDED_TOOL_EVENTS = ["tool_execution_start", "tool_execution_update", "tool_execution_end"];

function isSharedControlEndpoint(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && value.host === "127.0.0.1"
    && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535
    && typeof value.token === "string" && value.token.length > 0;
}

// Pi's inter-extension bus carries side-channel lines (model discovery) in TUI mode. Lines that
// arrive before the connection exists keep only the latest per marker type.
function createSharedControlSideChannel(pi) {
  let writer = null;
  const slots = new Map();
  const publish = (line) => {
    if (typeof line !== "string" || !line) return;
    if (writer) { writer(line); return; }
    let key = "";
    try { const parsed = JSON.parse(line); if (parsed && typeof parsed.type === "string") key = parsed.type; } catch {}
    slots.delete(key);
    slots.set(key, line);
  };
  pi.events?.on(SHARED_CONTROL_SIDE_CHANNEL_EVENT, publish);
  return {
    attach(nextWriter) {
      writer = nextWriter;
      for (const line of slots.values()) writer(line);
      slots.clear();
    },
  };
}

// Pi's own JSON projection of message_update (dist/modes/json-event.js): drop the cumulative
// message and the per-event partial so each token costs its delta, not the whole message.
function projectSharedControlMessageUpdate(event) {
  const update = event.assistantMessageEvent;
  let projected = update;
  if (update && typeof update === "object" && "partial" in update) {
    const { partial, ...delta } = update;
    projected = delta;
    if (update.type === "toolcall_start") {
      const toolCall = partial?.content?.[update.contentIndex];
      projected = { ...delta, id: toolCall?.id, toolName: toolCall?.name };
    }
  }
  return { type: "message_update", usage: event.message?.usage, assistantMessageEvent: projected };
}

function readSharedControlUserText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\\n");
}

function startSharedControl(pi, ctx, endpoint, sideChannel) {
  let live = true;
  let admitted = false;
  let socket = null;
  let markerCount = 0;
  let compacting = false;

  const goInert = () => {
    live = false;
    try { socket?.destroy(); } catch {}
  };
  const writeFrame = (frame) => {
    if (!live || !socket) return;
    try { socket.write(JSON.stringify(frame) + "\\n"); } catch { goInert(); }
  };
  const sendOut = (record) => writeFrame({ ch: "out", line: JSON.stringify(record) });
  const sendErr = (line) => writeFrame({ ch: "err", line });
  const respond = (id, command, success, extra) => sendOut({ id, type: "response", command, success, ...extra });
  const summarizeModel = (model) => (model ? { id: model.id, provider: model.provider, name: model.name } : null);

  const commandHandlers = {
    get_state: (command) => respond(command.id, "get_state", true, {
      data: {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        isStreaming: !ctx.isIdle(),
        isCompacting: compacting,
        thinkingLevel: pi.getThinkingLevel(),
        model: summarizeModel(ctx.model),
      },
    }),
    get_commands: (command) => respond(command.id, "get_commands", true, { data: { commands: pi.getCommands() } }),
    get_session_stats: (command) => respond(command.id, "get_session_stats", true, {
      data: { sessionId: ctx.sessionManager.getSessionId(), contextUsage: ctx.getContextUsage() ?? null },
    }),
    prompt: (command) => {
      const message = typeof command.message === "string" ? command.message : "";
      if (compacting || !ctx.isIdle() || ctx.hasPendingMessages()) {
        respond(command.id, "prompt", false, { error: SHARED_CONTROL_BUSY_ERROR });
        return;
      }
      try {
        pi.sendUserMessage(message, { expandPromptTemplates: true });
      } catch {
        respond(command.id, "prompt", false, {
          error: "Unable to confirm delivery to the Pi terminal",
          data: { outcome: SHARED_CONTROL_INDETERMINATE_OUTCOME },
        });
        return;
      }
      respond(command.id, "prompt", true, { data: { disposition: SHARED_CONTROL_PROMPT_HANDED_OFF } });
    },
    abort: (command) => {
      // A Stop during input preparation may arrive before Pi exposes anything cancellable.
      const didRequestAbort = compacting || !ctx.isIdle();
      if (didRequestAbort) ctx.abort();
      respond(command.id, "abort", true, { data: { didRequestAbort } });
    },
    set_model: async (command) => {
      const model = ctx.modelRegistry.find(command.provider, command.modelId);
      if (!model) {
        respond(command.id, "set_model", false, { error: "Model not found: " + command.provider + "/" + command.modelId });
        return;
      }
      if (!(await pi.setModel(model))) {
        respond(command.id, "set_model", false, { error: "No configured authentication for " + command.provider + "/" + command.modelId });
        return;
      }
      respond(command.id, "set_model", true, { data: summarizeModel(model) });
    },
    set_thinking_level: (command) => {
      pi.setThinkingLevel(command.level);
      respond(command.id, "set_thinking_level", true);
    },
  };

  const handleCommand = async (command) => {
    const type = typeof command.type === "string" ? command.type : "unknown";
    if (type === SHARED_CONTROL_ADMISSION_FRAME) {
      admitted = true;
      return;
    }
    if (!admitted) {
      respond(command.id, type, false, { error: SHARED_CONTROL_BRIDGE_UNAVAILABLE_ERROR });
      return;
    }
    const handler = SHARED_CONTROL_SUPPORTED_COMMANDS.includes(type) ? commandHandlers[type] : undefined;
    if (!handler) {
      respond(command.id, type, false, { error: SHARED_CONTROL_UNSUPPORTED_COMMAND_ERROR });
      return;
    }
    try {
      await handler(command);
    } catch (error) {
      respond(command.id, type, false, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  // Every frame below is a no-op once the connection is gone (writeFrame), so Pi keeps running
  // on its own when the runner disappears.
  socket = connect({ host: endpoint.host, port: endpoint.port });
  socket.setEncoding("utf8");
  socket.setNoDelay(true);
  // Pi's lifetime is the TUI's; this connection must never keep the process alive.
  socket.unref();
  socket.on("error", goInert);
  socket.on("close", goInert);
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\\n"); index >= 0; index = buffer.indexOf("\\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line || !live) continue;
      let command;
      try {
        command = JSON.parse(line);
      } catch (error) {
        respond(undefined, "parse", false, { error: "Failed to parse command: " + (error instanceof Error ? error.message : String(error)) });
        continue;
      }
      if (command && typeof command === "object") void handleCommand(command);
    }
  });
  writeFrame({
    type: "hello",
    v: SHARED_CONTROL_PROTOCOL_VERSION,
    token: endpoint.token,
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile() ?? null,
  });
  sideChannel.attach(sendErr);

  const on = (type, handler) => pi.on(type, (event) => {
    if (!live) return;
    try { return handler(event); } catch { goInert(); }
  });
  on("agent_start", () => {
    sendOut({ type: "agent_start" });
  });

  on("message_start", sendOut);

  on("message_update", (event) => {
    sendOut(projectSharedControlMessageUpdate(event));
  });

  on("message_end", (event) => {
    const message = event.message;
    if (message?.role === "user") {
      const text = readSharedControlUserText(message);
      if (text) {
        markerCount += 1;
        sendOut({
          type: "extension_ui_request",
          id: "happier-user-input-" + markerCount,
          method: "notify",
          message: JSON.stringify({ type: SHARED_CONTROL_USER_INPUT_MARKER_TYPE, text }),
        });
      }
    }
    sendOut(event);
  });

  for (const type of SHARED_CONTROL_FORWARDED_TOOL_EVENTS) {
    on(type, (event) => {
      sendOut(event);
    });
  }

  // Pi's extension agent_end has no willRetry and fires before retries and queued follow-ups;
  // agent_settled is the final idle signal, so the run ends there.
  on("agent_settled", () => {
    sendOut({ type: "agent_end", willRetry: false });
  });

  on("session_before_compact", (event) => {
    compacting = true;
    sendOut({ type: "compaction_start", reason: event.reason });
  });
  on("session_compact", (event) => {
    compacting = false;
    const tokensBefore = event.compactionEntry?.tokensBefore;
    sendOut({
      type: "compaction_end",
      reason: event.reason,
      aborted: false,
      willRetry: event.willRetry === true,
      ...(Number.isFinite(tokensBefore) ? { result: { tokensBefore } } : {}),
    });
  });
  on("session_compact_failed", (event) => {
    compacting = false;
    sendOut({
      type: "compaction_end",
      reason: event.reason,
      aborted: event.aborted === true,
      willRetry: event.willRetry === true,
      ...(typeof event.errorMessage === "string" ? { errorMessage: event.errorMessage } : {}),
    });
  });

  on("session_shutdown", (event) => {
    writeFrame({ type: "bye", reason: event.reason });
    live = false;
    socket.end();
  });

  return { sendErr, isAdmitted: () => live && admitted };
}
`;
}
