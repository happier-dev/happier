/**
 * Fake OpenCode `serve` CLI for deterministic Happier e2e tests.
 *
 * Goal: reproduce the OpenCode managed-server "restart during an in-flight turn"
 * failure shape WITHOUT the real OpenCode binary, so the core-e2e suite can assert
 * Happier's generation-aware recovery deterministically.
 *
 * It is wired in via `HAPPIER_OPENCODE_PATH` (Happier launches it as
 * `<jsRuntime> <this-file> serve --hostname=<h> --port=<p>` because the path ends
 * in `.cjs`, see `providerCliPathRequiresJavaScriptRuntime`). It implements only the
 * HTTP surface the Happier OpenCode server runtime/client touch:
 *   - GET  /global/health        readiness probe
 *   - GET  /event                directory-scoped SSE event stream (raw instance events)
 *   - GET  /global/event         replayable global SSE observation stream
 *   - GET  /global/config
 *   - POST /session              create the (single) fake session
 *   - GET  /session              list sessions
 *   - GET  /session/:id          get one session
 *   - PATCH/session/:id          update (no-op echo)
 *   - GET  /session/status       per-session busy/idle status
 *   - GET  /session/:id/message  durable message history ({info, parts}[])
 *   - GET  /session/:id/todo     []
 *   - GET  /session/:id/diff     []
 *   - POST /session/:id/prompt_async   enqueue a prompt (see lifecycle below)
 *   - POST /session/:id/summarize      no-op
 *   - POST /session/:id/abort    record abort (the recovery policy MUST NOT call this)
 *   - POST /session/:id/fork     echo
 *   - GET  /permission           []
 *   - GET  /question             []
 *   - GET  /agent | /skill       []
 *   - GET  /provider             { all: [], connected: [] }
 *   - POST /mcp | /mcp/:n/disconnect    no-op
 *
 * Cross-process durable state lives at `HAPPIER_E2E_FAKE_OPENCODE_STATE_PATH` (JSON),
 * so the *replacement* server process started by Happier reads the SAME session and
 * history (with the tool still `running`).
 *
 * Lifecycle on the FIRST prompt_async (teardown mode = `crash`, the default):
 *   1. Persist a user message + an assistant message whose only part is a tool part
 *      with `state.status: 'running'` (NO terminal status), set `toolRunning=true`.
 *   2. Emit those as live SSE events to any open stream.
 *   3. After `HAPPIER_E2E_FAKE_OPENCODE_EXIT_DELAY_MS` (default 150ms), `process.exit(0)`
 *      WITHOUT emitting a terminal tool status. The in-flight turn is now orphaned.
 * On replacement start, the new process reads the persisted state and re-serves the
 * same session/history with the tool still `running`, and replays the running-tool
 * events to any SSE subscriber.
 *
 * Teardown mode = `stay_alive`: identical, except the process does NOT exit after
 * emitting the running tool. This models a *Happier-initiated* mid-turn teardown
 * (fingerprint/port replacement) where the old server is still alive; the test/runtime
 * lane triggers the replacement (e.g. a launch-fingerprint change or releaseForAuthSwitch),
 * and the replacement process again reads the shared state with the tool still running.
 *
 * No secrets are read or logged. This file is CommonJS so it runs under bare node/bun.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');

// ---------------------------------------------------------------------------
// Argument + environment parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function parseFlag(name) {
  const eqPrefix = `${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== 'string') continue;
    if (arg.startsWith(eqPrefix)) return arg.slice(eqPrefix.length);
    if (arg === name && index + 1 < argv.length) return argv[index + 1];
  }
  return '';
}

const isServe = argv.includes('serve');
const hostname = (parseFlag('--hostname') || '127.0.0.1').trim() || '127.0.0.1';
const port = Number.parseInt(parseFlag('--port') || '0', 10);

if (!isServe) {
  // Happier only ever launches us as `serve`; anything else is a misconfiguration.
  process.stderr.write(`fake-opencode: expected 'serve' subcommand, got: ${argv.join(' ')}\n`);
  process.exit(2);
}
if (!Number.isFinite(port) || port <= 0) {
  process.stderr.write('fake-opencode: missing or invalid --port\n');
  process.exit(2);
}

const statePath = String(process.env.HAPPIER_E2E_FAKE_OPENCODE_STATE_PATH || '').trim();
const logPath = String(process.env.HAPPIER_E2E_FAKE_OPENCODE_LOG || '').trim();
const teardownMode = (() => {
  const raw = String(process.env.HAPPIER_E2E_FAKE_OPENCODE_TEARDOWN_MODE || 'crash').trim().toLowerCase();
  return raw === 'stay_alive' ? 'stay_alive' : 'crash';
})();
const exitDelayMs = (() => {
  const raw = Number.parseInt(String(process.env.HAPPIER_E2E_FAKE_OPENCODE_EXIT_DELAY_MS || ''), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 150;
})();
const toolName = String(process.env.HAPPIER_E2E_FAKE_OPENCODE_TOOL_NAME || 'read').trim() || 'read';
const fixedSessionId = String(process.env.HAPPIER_E2E_FAKE_OPENCODE_SESSION_ID || '').trim();

const baseUrl = `http://${hostname}:${port}`;

function shortId(prefix) {
  return `${prefix}${randomBytes(8).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// JSONL event log (best-effort, never throws into request handling)
// ---------------------------------------------------------------------------

function logEvent(entry) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${JSON.stringify({ ts: Date.now(), pid: process.pid, port, ...entry })}\n`, 'utf8');
  } catch {
    // ignore log failures
  }
}

// ---------------------------------------------------------------------------
// Durable cross-process state (JSON at HAPPIER_E2E_FAKE_OPENCODE_STATE_PATH)
// ---------------------------------------------------------------------------

function emptyState() {
  return {
    sessionId: fixedSessionId || '',
    directory: '',
    promptCount: 0,
    toolRunning: false,
    messages: [],
    generation: 0,
    processes: [],
    aborts: [],
  };
}

function readState() {
  if (!statePath) return emptyState();
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState();
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

function writeState(next) {
  if (!statePath) return;
  try {
    const tmp = `${statePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
    fs.renameSync(tmp, statePath);
  } catch {
    // ignore persistence failures
  }
}

// Single-process serialized read-modify-write. Cross-process overlap does not happen
// in our flows (process-1 exits or pauses before process-2 starts), but each mutation
// reads fresh from disk so a replacement process always sees the latest committed state.
function mutateState(mutator) {
  const current = readState();
  const next = mutator(current) ?? current;
  writeState(next);
  return next;
}

// ---------------------------------------------------------------------------
// OpenCode message/event shape builders
// ---------------------------------------------------------------------------

function extractPromptText(body) {
  const parts = body && Array.isArray(body.parts) ? body.parts : [];
  for (const part of parts) {
    if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      return part.text;
    }
  }
  return '';
}

function buildRunningTurnMessages(params) {
  const { sessionId, directory, promptText, promptMessageId } = params;
  const now = Date.now();
  const userMessageId = promptMessageId || shortId('msg_user_');
  const assistantMessageId = shortId('msg_asst_');
  const callId = shortId('call_');

  const userMessage = {
    info: {
      id: userMessageId,
      sessionID: sessionId,
      role: 'user',
      time: { created: now },
    },
    parts: [
      {
        id: shortId('prt_'),
        sessionID: sessionId,
        messageID: userMessageId,
        type: 'text',
        text: promptText,
      },
    ],
  };

  const toolPart = {
    id: shortId('prt_'),
    sessionID: sessionId,
    messageID: assistantMessageId,
    type: 'tool',
    callID: callId,
    tool: toolName,
    state: {
      status: 'running',
      time: { start: now },
      input: { path: 'e2e-fixture.txt' },
    },
  };

  const assistantMessage = {
    info: {
      id: assistantMessageId,
      sessionID: sessionId,
      role: 'assistant',
      time: { created: now },
      providerID: 'fake',
      modelID: 'fake-model',
    },
    parts: [toolPart],
  };

  return { userMessage, assistantMessage, directory };
}

function globalEvent(directory, type, properties) {
  return { directory: directory || '', payload: { type, properties: properties || {} } };
}

function instanceEvent(type, properties) {
  return { type, properties: properties || {} };
}

function messageUpdatedEvent(message) {
  return instanceEvent('message.updated', { info: message.info });
}

function messagePartUpdatedEvent(message) {
  const part = Array.isArray(message.parts) ? message.parts[0] : null;
  return instanceEvent('message.part.updated', { part });
}

// ---------------------------------------------------------------------------
// SSE subscribers
// ---------------------------------------------------------------------------

/** @type {Set<{res: import('node:http').ServerResponse, mode: 'global' | 'instance', directory: string}>} */
const sseClients = new Set();

function sseWrite(res, event) {
  try {
    res.write(`id: ${shortId('evt_')}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    // client gone
  }
}

function eventForSubscriber(client, directory, event) {
  if (client.mode === 'global') return globalEvent(directory, event.type, event.properties);
  if (client.directory !== directory) return null;
  return event;
}

function sseBroadcast(directory, event) {
  for (const client of sseClients) {
    const delivered = eventForSubscriber(client, directory, event);
    if (delivered) sseWrite(client.res, delivered);
  }
}

function replayRunningTurnTo(res) {
  const state = readState();
  if (!state.toolRunning || !Array.isArray(state.messages) || state.messages.length === 0) return;
  const directory = state.directory || '';
  for (const message of state.messages) {
    if (!message || typeof message !== 'object') continue;
    sseWrite(res, globalEvent(directory, 'message.updated', { info: message.info }));
    if (Array.isArray(message.parts) && message.parts.some((p) => p && p.type === 'tool')) {
      const part = Array.isArray(message.parts) ? message.parts[0] : null;
      sseWrite(res, globalEvent(directory, 'message.part.updated', { part }));
    }
  }
  if (state.sessionId) {
    sseWrite(res, globalEvent(directory, 'session.status', { sessionID: state.sessionId, status: { type: 'busy' } }));
  }
}

// ---------------------------------------------------------------------------
// First-prompt lifecycle (emit running tool, then crash or stay alive)
// ---------------------------------------------------------------------------

function emitRunningTurnAndMaybeCrash(body) {
  const state = readState();
  const sessionId = state.sessionId || (fixedSessionId || shortId('ses_fake'));
  const directory = state.directory || '';
  const promptText = extractPromptText(body);
  const promptMessageId = body && typeof body.messageID === 'string' ? body.messageID : '';

  const { userMessage, assistantMessage } = buildRunningTurnMessages({
    sessionId,
    directory,
    promptText,
    promptMessageId,
  });

  mutateState((current) => ({
    ...current,
    sessionId,
    toolRunning: true,
    messages: [userMessage, assistantMessage],
  }));

  // Live events to currently-open SSE subscribers.
  sseBroadcast(directory, messageUpdatedEvent(userMessage));
  sseBroadcast(directory, messageUpdatedEvent(assistantMessage));
  sseBroadcast(directory, messagePartUpdatedEvent(assistantMessage));
  sseBroadcast(directory, instanceEvent('session.status', { sessionID: sessionId, status: { type: 'busy' } }));

  logEvent({ type: 'running_tool_emitted', sessionId, tool: toolName, teardownMode });

  if (teardownMode === 'crash') {
    // Orphan the in-flight turn: exit WITHOUT a terminal tool status.
    const delay = setTimeout(() => {
      logEvent({ type: 'serve_exit', reason: 'crash_after_running_tool', sessionId });
      // Hard-exit so Happier's next HTTP request hits a dead server and ensures a replacement.
      process.exit(0);
    }, exitDelayMs);
    delay.unref?.();
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJson(res, status, value) {
  const payload = value === undefined ? '' : JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

async function readJsonBody(req) {
  return await new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function ensureSession(directory) {
  return mutateState((current) => {
    const sessionId = current.sessionId || (fixedSessionId || shortId('ses_fake'));
    return {
      ...current,
      sessionId,
      directory: current.directory || directory || '',
    };
  });
}

function matchSessionSubpath(pathname, suffix) {
  // /session/<id>/<suffix>  ->  decoded id, or null
  const m = pathname.match(new RegExp(`^/session/([^/]+)/${suffix}$`));
  return m ? decodeURIComponent(m[1]) : null;
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    logEvent({ type: 'request_error', message: error instanceof Error ? error.message : String(error) });
    try {
      sendJson(res, 500, { error: 'fake-opencode internal error' });
    } catch {
      // ignore
    }
  });
});

async function handleRequest(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  const url = new URL(req.url || '/', baseUrl);
  const pathname = url.pathname;
  const directory = url.searchParams.get('directory') || '';

  // --- Global and instance event streams -----------------------------------
  if (pathname === '/global/health') {
    sendJson(res, 200, { healthy: true, version: `fake-opencode-gen${readState().generation}` });
    return;
  }
  if (pathname === '/global/config') {
    sendJson(res, 200, { model: 'fake/fake-model' });
    return;
  }
  if (pathname === '/global/event' || pathname === '/event') {
    const mode = pathname === '/global/event' ? 'global' : 'instance';
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const client = { res, mode, directory };
    sseClients.add(client);
    logEvent({ type: 'sse_open', generation: readState().generation, mode, directory });
    // The instance stream boundary precedes only future instance-bus events. Global observation
    // retains replay behavior for external-session consumers and generation-wait test helpers.
    sseWrite(res, mode === 'global'
      ? globalEvent(directory, 'server.connected', {})
      : instanceEvent('server.connected', {}));
    if (mode === 'global') replayRunningTurnTo(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        // ignore
      }
    }, 5_000);
    heartbeat.unref?.();
    const cleanup = () => {
      clearInterval(heartbeat);
      sseClients.delete(client);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
    return;
  }

  // --- Discovery surfaces -----------------------------------------------------
  if (pathname === '/agent' || pathname === '/skill') {
    sendJson(res, 200, []);
    return;
  }
  if (pathname === '/provider') {
    sendJson(res, 200, { all: [], connected: [] });
    return;
  }
  if (pathname === '/permission' && method === 'GET') {
    sendJson(res, 200, []);
    return;
  }
  if (pathname === '/question' && method === 'GET') {
    sendJson(res, 200, []);
    return;
  }
  if (pathname === '/session/status' && method === 'GET') {
    const state = readState();
    const status = state.sessionId && state.toolRunning
      ? { [state.sessionId]: { type: 'busy' } }
      : {};
    sendJson(res, 200, status);
    return;
  }

  // --- Session collection -----------------------------------------------------
  if (pathname === '/session' && method === 'POST') {
    const state = ensureSession(directory);
    logEvent({ type: 'session_create', sessionId: state.sessionId });
    sendJson(res, 200, { id: state.sessionId, directory: state.directory });
    return;
  }
  if (pathname === '/session' && method === 'GET') {
    const state = readState();
    sendJson(res, 200, state.sessionId ? [{ id: state.sessionId, directory: state.directory }] : []);
    return;
  }

  // --- Session sub-resources --------------------------------------------------
  const messageSessionId = matchSessionSubpath(pathname, 'message');
  if (messageSessionId && method === 'GET') {
    const state = readState();
    sendJson(res, 200, Array.isArray(state.messages) ? state.messages : []);
    return;
  }
  if ((matchSessionSubpath(pathname, 'todo') || matchSessionSubpath(pathname, 'diff')) && method === 'GET') {
    sendJson(res, 200, []);
    return;
  }

  const promptSessionId = matchSessionSubpath(pathname, 'prompt_async');
  if (promptSessionId && method === 'POST') {
    const body = await readJsonBody(req);
    const promptText = extractPromptText(body);
    const next = mutateState((current) => ({ ...current, promptCount: (current.promptCount || 0) + 1 }));
    logEvent({
      type: 'prompt_async',
      sessionId: promptSessionId,
      generation: next.generation,
      promptIndex: next.promptCount,
      messageID: typeof body.messageID === 'string' ? body.messageID : null,
      text: promptText,
    });
    // Respond before (maybe) crashing so the caller's request resolves cleanly.
    sendJson(res, 200, {});
    if (next.promptCount === 1) {
      emitRunningTurnAndMaybeCrash(body);
    }
    return;
  }

  const summarizeSessionId = matchSessionSubpath(pathname, 'summarize');
  if (summarizeSessionId && method === 'POST') {
    sendJson(res, 200, {});
    return;
  }

  const abortSessionId = matchSessionSubpath(pathname, 'abort');
  if (abortSessionId && method === 'POST') {
    // The generation-recovery policy MUST NOT abort on a server-replacement interruption.
    // Record any abort so the e2e can assert it never happened for this scenario.
    mutateState((current) => ({
      ...current,
      aborts: [...(Array.isArray(current.aborts) ? current.aborts : []), { sessionId: abortSessionId, ts: Date.now() }],
    }));
    logEvent({ type: 'session_abort', sessionId: abortSessionId });
    sendJson(res, 200, {});
    return;
  }

  const forkSessionId = matchSessionSubpath(pathname, 'fork');
  if (forkSessionId && method === 'POST') {
    sendJson(res, 200, { id: forkSessionId, directory });
    return;
  }

  // Permission / question replies (POST /permission/:id/reply, etc.)
  if (/^\/(permission|question)\/[^/]+\/(reply|reject)$/.test(pathname) && method === 'POST') {
    sendJson(res, 200, true);
    return;
  }

  // MCP add/disconnect — no-ops.
  if (pathname === '/mcp' && method === 'POST') {
    sendJson(res, 200, {});
    return;
  }
  if (/^\/mcp\/[^/]+\/disconnect$/.test(pathname) && method === 'POST') {
    sendJson(res, 200, {});
    return;
  }

  // --- Single session get/update (kept last so sub-resources match first) -----
  const singleSession = pathname.match(/^\/session\/([^/]+)$/);
  if (singleSession) {
    const id = decodeURIComponent(singleSession[1]);
    const state = readState();
    if (method === 'GET' || method === 'PATCH') {
      sendJson(res, 200, { id: state.sessionId || id, directory: state.directory || directory });
      return;
    }
  }

  sendJson(res, 404, { error: 'not found', path: pathname });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

server.listen(port, hostname, () => {
  const state = mutateState((current) => ({
    ...current,
    generation: (current.generation || 0) + 1,
    processes: [
      ...(Array.isArray(current.processes) ? current.processes : []),
      { pid: process.pid, port, baseUrl, startedAtMs: Date.now(), generation: (current.generation || 0) + 1 },
    ],
  }));
  logEvent({ type: 'serve_start', generation: state.generation, toolRunning: state.toolRunning, teardownMode });
  // Single readiness line (real opencode prints similar). Managed-server wrapper drains stdout.
  process.stdout.write(`fake-opencode serve listening on ${baseUrl} (gen=${state.generation})\n`);
});

server.on('error', (error) => {
  process.stderr.write(`fake-opencode: server error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

function shutdown() {
  logEvent({ type: 'serve_exit', reason: 'signal' });
  try {
    server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
  setTimeout(() => process.exit(0), 500).unref?.();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
