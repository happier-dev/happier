import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { join } from 'node:path';
import { SourceMap } from 'node:module';
import { connectPage } from './cdp.mjs';
import { frameKey, networkRouteClass, normalizeProfileSamples, requestFingerprint, safeUrl, socketFrameClassification, summarizeNetwork, summarizeProfile } from './analysis.mjs';
import { summarizeHeapProfile, summarizeMainThreadTrace, summarizeJsThreadLagSampler } from './profiling.mjs';

const TRACE_CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink.user_timing', 'disabled-by-default-v8.cpu_profiler'];
const frameProjection = frame => ({ functionName: frame.functionName, scriptId: frame.scriptId,
  url: safeUrl(frame.url), lineNumber: frame.lineNumber, columnNumber: frame.columnNumber });
function traceProjection(event) {
  const row = Object.fromEntries(['name', 'cat', 'ph', 'pid', 'tid', 'ts', 'dur', 'id', 'id2', 'scope', 's', 'tts', 'tdur'].filter(key => event[key] !== undefined).map(key => [key, event[key]]));
  const data = event.args?.data;
  if (data && typeof data === 'object') {
    const safe = Object.fromEntries(['scriptId', 'functionName', 'lineNumber', 'columnNumber', 'timerId', 'singleShot', 'timeout', 'type', 'startTime', 'endTime', 'id', 'timeDeltas', 'lines'].filter(key => data[key] !== undefined).map(key => [key, data[key]]));
    if (typeof data.url === 'string') safe.url = safeUrl(data.url);
    if (Array.isArray(data.stackTrace)) safe.stackTrace = data.stackTrace.map(frameProjection);
    if (data.cpuProfile) safe.cpuProfile = { ...data.cpuProfile, nodes: data.cpuProfile.nodes?.map(node => ({ ...node, callFrame: node.callFrame ? frameProjection(node.callFrame) : undefined })) };
    row.args = { data: safe };
  }
  if (['thread_name', 'process_name'].includes(event.name)) row.args = { name: event.args?.name };
  return row;
}

function fullTrace(cdp, directory, measurementDurationMs, cpuProfile, captureMode) {
  const categories = [
    ...TRACE_CATEGORIES.filter(category => cpuProfile || category !== 'disabled-by-default-v8.cpu_profiler'),
    ...(captureMode === 'counts' ? ['disabled-by-default-devtools.timeline.stack'] : []),
  ];
  let stream, file, completion, acceptComplete, fileDone, count = 0, writeError, started = false, terminal;
  let samplerSources = [];
  const summaryEvents = [];
  cdp.on('Tracing.dataCollected', ({ value }) => {
    if (!started || writeError) return;
    for (const event of value) {
      const safe = traceProjection(event);
      stream.write(`${count++ ? ',' : ''}${JSON.stringify(safe)}\n`);
      if (/^(?:happier-perf:|RunTask$|ThreadControllerImpl::RunTask$|MessageLoop::RunTask$|ThreadPool_RunTask$|Layout$|UpdateLayoutTree$|RecalculateStyles$|PrePaint$|Paint|CompositeLayers$|Layerize$|UpdateLayerTree$|TimerFire$|FunctionCall$|FireAnimationFrame$|EventDispatch$|WebSocket|RunMicrotasks$)|GC|GarbageCollect/.test(event.name)) summaryEvents.push(safe);
    }
  });
  cdp.on('Tracing.tracingComplete', result => acceptComplete?.(result));
  return {
    async start(sources = []) {
      samplerSources = sources;
      file = createWriteStream(join(directory, 'trace.json.gz'), { mode: 0o600 });
      stream = createGzip(); stream.pipe(file);
      fileDone = new Promise(resolve => { file.once('finish', resolve); file.once('error', error => { writeError = error; resolve(); }); stream.once('error', error => { writeError = error; resolve(); }); });
      stream.write('{"traceEvents":[\n');
      completion = new Promise(resolve => { acceptComplete = resolve; });
      started = true;
      // The default 200 MiB dropped five-minute traces on the real fleet.
      // This diagnostic buffer covers the observed volume; dropped traces still
      // fail closed. It does not bound application work or accepted user data.
      await cdp.send('Tracing.start', { traceConfig: { recordMode: 'recordAsMuchAsPossible', traceBufferSizeInKb: 2097152, includedCategories: categories }, transferMode: 'ReportEvents' });
    },
    async stop() {
      if (terminal) return terminal;
      if (!started) return null;
      let result;
      try {
        await cdp.send('Tracing.end');
        result = await Promise.race([completion, cdp.disconnected.then(() => { throw new Error('Trace transport disconnected'); })]);
      } finally { started = false; stream.end(']}'); await fileDone; }
      if (writeError) throw new Error('Trace artifact unavailable');
      const start = summaryEvents.find(event => event.name === 'happier-perf:start');
      const end = summaryEvents.find(event => event.name === 'happier-perf:end');
      const endUs = Number.isFinite(measurementDurationMs) ? Math.min(end?.ts, start?.ts + measurementDurationMs * 1000) : end?.ts;
      const summary = summarizeMainThreadTrace(summaryEvents, { startUs: start?.ts, endUs, pid: start?.pid, tid: start?.tid });
      const sampler = result.dataLossOccurred === false
        ? summarizeJsThreadLagSampler(summaryEvents, summary, samplerSources)
        : { available: false, unavailableReason: 'complete-trace-required', counterfactual: false };
      return terminal = { artifact: 'trace.json.gz', categories, eventCount: count,
        dataLossOccurred: result.dataLossOccurred, summary,
        instrumentation: { jsThreadLagSampler: { ...sampler, sourceRanges: samplerSources } } };
    },
  };
}

// Resolve only this canonical module, outside the measured window. Generated
// locations are evidence; no bundle-line constants or 50ms cadence heuristic.
async function jsThreadLagSamplerSources(cdp) {
  function loadedFactory() {
    const modules = globalThis.__r?.getModules?.();
    if (!modules) return;
    for (const [, module] of modules) {
      if (module.isInitialized && module.factory
        && /(?:^|\/)sync\/runtime\/performance\/jsThreadLagTelemetry\.[jt]s$/.test(String(module.verboseName ?? '').replaceAll('\\', '/'))) return module.factory;
    }
  }
  let objectId;
  try {
    const factory = await cdp.send('Runtime.evaluate', { expression: `(${loadedFactory.toString()})()` });
    objectId = factory.result?.objectId;
    if (factory.exceptionDetails || !objectId) return [];
    const [properties, lines] = await Promise.all([
      cdp.send('Runtime.getProperties', { objectId, ownProperties: true }),
      cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function() { return this.toString().split("\\n").length; }', returnByValue: true }),
    ]);
    const location = properties.internalProperties?.find(row => row.name === '[[FunctionLocation]]')?.value?.value;
    const count = lines.result?.value;
    if (!location || !Number.isInteger(location.lineNumber) || !Number.isInteger(count) || count < 1) return [];
    // CDP locations are zero-based; timeline FunctionCall lines are one-based.
    return [{ scriptId: location.scriptId, startLine: location.lineNumber + 1, endLine: location.lineNumber + count + 1 }];
  } catch { return []; } // The summary reports missing source proof, never zero cost.
  finally { if (objectId) await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {}); }
}

// Counts-only diagnostic budget: retain at most eight async scheduling hops.
// This bounds debugger bookkeeping, not user work or the synchronous frames.
const COUNTS_ASYNC_STACK_DEPTH = 8;

function stackFrames(stack, parents = COUNTS_ASYNC_STACK_DEPTH) {
  return stack ? [...(stack.callFrames ?? []).map(frame => ({ functionName: frame.functionName, url: safeUrl(frame.url), lineNumber: frame.lineNumber, columnNumber: frame.columnNumber })),
    ...(parents > 0 ? stackFrames(stack.parent, parents - 1) : [])] : [];
}

function pageAuthSurface() {
  const visible = selector => [...document.querySelectorAll(selector)].some(node => node.getClientRects().length > 0);
  const welcome = visible('[data-testid="welcome-decision-panel"], [data-testid="unauth-shell-brand-pane"]');
  const shell = visible('[data-testid="session-list-view-options-trigger"], [data-testid="home-header-start-new-session"], [data-testid="app-shell-title-strip"]');
  return { surface: welcome ? 'welcome' : shell ? 'shell' : 'unknown',
    authenticated: null, basis: 'visible DOM markers only; not credential authority',
    retirementReasonCode: null, retirementReasonAvailability: 'not exposed by the app browser surface' };
}

// Join only inside this recorder. Raw Engine.IO connection ids, query values and
// namespace/auth payloads never leave this closure or enter the saved capture.
function socketConnectionRecorder() {
  const byEngineId = new Map(), byWebSocket = new Map(), connections = [];
  const setupEvents = [], networkPhases = [], poolConnections = new Map();
  const setupPhases = new Set(['retirement-wait', 'retired', 'acquire', 'reachability-start', 'reachability-ready', 'connect', 'connected']);
  const toWall = (timestamp, pairs) => {
    const pair = pairs.findLast(pair => pair.timestamp <= timestamp) ?? pairs[0];
    return Number.isFinite(timestamp) && pair ? timestamp * 1000 + pair.offsetMs : null;
  };
  const create = (timestamp, origin) => {
    const connection = { id: `connection-${connections.length + 1}`, purpose: 'unknown', clientRole: 'unknown', transports: new Set(),
      origin,
      upgradeOutcome: 'not-observed', first: timestamp, last: timestamp, websocketFirst: null, websocketClosed: null, closed: null,
      probeAcknowledged: false, clientDisconnectObserved: false };
    connections.push(connection);
    return connection;
  };
  const touch = (connection, timestamp) => {
    if (!Number.isFinite(timestamp)) return;
    connection.first = Number.isFinite(connection.first) ? Math.min(connection.first, timestamp) : timestamp;
    connection.last = Number.isFinite(connection.last) ? Math.max(connection.last, timestamp) : timestamp;
  };
  const parseUrl = raw => {
    try {
      const url = new URL(raw);
      if (url.pathname.replace(/\/$/, '') !== '/v1/updates') return null;
      const transport = url.searchParams.get('transport');
      if (!['polling', 'websocket'].includes(transport)) return null;
      return { origin: url.origin.replace(/^ws/, 'http'), engineId: url.searchParams.get('sid'), transport };
    } catch { return null; }
  };
  const packet = (connection, payload, direction, timestamp) => {
    if (typeof payload !== 'string') return;
    for (const part of payload.split('\x1e')) {
      if (direction === 'received' && part.startsWith('0{')) {
        try {
          const open = JSON.parse(part.slice(1));
          if (typeof open?.sid === 'string') byEngineId.set(JSON.stringify([connection.origin, open.sid]), connection);
        } catch {} // A malformed Engine open cannot establish a private join.
      }
      if (direction === 'received' && part.startsWith('40{')) {
        try {
          if (typeof JSON.parse(part.slice(2))?.sid === 'string') networkPhases.push({ phase: 'registered', timestamp, connection });
        } catch {} // Namespace admission is observed, never inferred from a dial.
      }
      const name = socketFrameClassification(part, 1).event;
      if (direction === 'sent' && ['rpc-register', 'rpc-call'].includes(name)) {
        networkPhases.push({ phase: name === 'rpc-call' ? 'request-sent' : 'rpc-register-sent', timestamp, connection });
      }
      if (direction === 'sent' && part.startsWith('40{')) {
        try {
          const auth = JSON.parse(part.slice(2));
          if (['user-scoped', 'session-scoped', 'machine-scoped'].includes(auth?.clientType)) connection.clientRole = auth.clientType;
          if (typeof auth?.clientPurpose === 'string') connection.purpose = auth.clientPurpose === 'scoped-rpc' ? 'scoped-RPC'
            : auth.clientPurpose === 'sync' && auth.clientType === 'user-scoped' ? 'Account' : 'other';
          else if (['session-scoped', 'machine-scoped'].includes(connection.clientRole)) connection.purpose = 'other';
        } catch {} // An incomplete body cannot establish a purpose.
      }
      if (direction === 'sent' && part === '41') connection.clientDisconnectObserved = true;
      if (direction === 'received' && part === '3probe') connection.probeAcknowledged = true;
      if (direction === 'sent' && part === '5' && connection.probeAcknowledged) {
        connection.upgradeOutcome = 'succeeded';
        networkPhases.push({ phase: 'upgrade', timestamp, connection });
      }
    }
  };
  return {
    request(event) {
      const parsed = parseUrl(event.request.url);
      if (!parsed) return {};
      // Initial polling opens have no Engine.IO id yet. Leave them unjoined
      // rather than guessing from timestamps or fetching response bodies.
      if (!parsed.engineId) return { socketTransport: parsed.transport, socketConnectionId: null };
      const identity = JSON.stringify([parsed.origin, parsed.engineId]);
      let connection = byEngineId.get(identity);
      if (!connection) { connection = create(event.timestamp, parsed.origin); byEngineId.set(identity, connection); }
      touch(connection, event.timestamp);
      connection.transports.add(parsed.transport);
      packet(connection, event.request.postData, 'sent', event.timestamp);
      return { socketTransport: parsed.transport, socketConnectionId: connection.id };
    },
    websocket(event, kind) {
      if (kind === 'created') {
        const parsed = parseUrl(event.url);
        if (!parsed) return;
        const identity = parsed.engineId ? JSON.stringify([parsed.origin, parsed.engineId]) : null;
        let connection = identity ? byEngineId.get(identity) : null;
        if (!connection) connection = create(event.timestamp, parsed.origin);
        if (identity) byEngineId.set(identity, connection);
        connection.transports.add('websocket');
        connection.upgradeOutcome = parsed.engineId ? 'attempted' : 'not-applicable';
        connection.websocketFirst = Number.isFinite(event.timestamp) ? event.timestamp : null;
        byWebSocket.set(event.requestId, connection);
      }
      const connection = byWebSocket.get(event.requestId);
      if (!connection) return;
      touch(connection, event.timestamp);
      if (kind === 'handshake-request' && connection.websocketFirst === null) connection.websocketFirst = event.timestamp;
      if (kind === 'closed') {
        connection.websocketClosed = event.timestamp;
        if (['succeeded', 'not-applicable'].includes(connection.upgradeOutcome)) connection.closed = event.timestamp;
        else if (connection.upgradeOutcome === 'attempted') connection.upgradeOutcome = 'closed-before-upgrade';
      }
      if (kind === 'frame-error' && connection.upgradeOutcome === 'attempted') connection.upgradeOutcome = 'failed';
    },
    frame(event, direction) {
      const connection = byWebSocket.get(event.requestId);
      if (!connection) return {};
      touch(connection, event.timestamp);
      if (event.response.opcode === 1) packet(connection, event.response.payloadData, direction, event.timestamp);
      return { socketConnectionId: connection.id };
    },
    setup(event) {
      if (!setupPhases.has(event?.phase) || !Number.isSafeInteger(event.connectionId) || event.connectionId <= 0
        || !Number.isFinite(event.atMs) || !Number.isFinite(event.timeOrigin) || typeof event.origin !== 'string') return;
      let origin;
      try { origin = new URL(event.origin).origin; } catch { return; }
      const identity = JSON.stringify([event.timeOrigin, event.connectionId]);
      let pool = poolConnections.get(identity);
      if (!pool) { pool = { id: `pool-${poolConnections.size + 1}`, engines: new Set() }; poolConnections.set(identity, pool); }
      const engine = typeof event.engineId === 'string' && event.engineId ? JSON.stringify([origin, event.engineId]) : null;
      if (engine) pool.engines.add(engine);
      setupEvents.push({ phase: event.phase, atMs: event.atMs, pool, engine });
    },
    setupSnapshot(startMs, endMs, pairs) {
      const network = networkPhases.map(row => ({ phase: row.phase, atMs: toWall(row.timestamp, pairs), socketConnectionId: row.connection.id }));
      const producer = setupEvents.map(row => {
        // One logical Socket.IO object can reconnect. A phase carrying its own
        // Engine id is exact; earlier phases join only an unambiguous lifetime.
        const engine = row.engine ?? (row.pool.engines.size === 1 ? row.pool.engines.values().next().value : null);
        return { phase: row.phase, atMs: row.atMs, poolConnectionId: row.pool.id,
          socketConnectionId: engine ? byEngineId.get(engine)?.id ?? null : null };
      });
      return [...network, ...producer].filter(row => row.atMs !== null && row.atMs >= startMs && row.atMs <= endMs)
        .sort((left, right) => left.atMs - right.atMs);
    },
    snapshot(startMs, endMs, pairs) {
      const wall = timestamp => toWall(timestamp, pairs);
      return connections.filter(connection => {
        const first = wall(connection.first), closed = wall(connection.closed);
        return first !== null && first <= endMs && (closed === null || closed >= startMs);
      }).map(connection => ({ id: connection.id, purpose: connection.purpose, clientRole: connection.clientRole, transports: [...connection.transports],
        upgradeOutcome: connection.upgradeOutcome, clientDisconnectObserved: connection.clientDisconnectObserved,
        firstObservedMs: wall(connection.first), lastObservedMs: wall(connection.last), closedMs: wall(connection.closed),
        observedLifetimeMs: Math.max(0, (wall(connection.closed) ?? wall(connection.last)) - wall(connection.first)),
        lifetimeBasis: 'first-to-last observed transport event; lower bound, absence of closure is not proof of liveness',
        websocketLifetimeMs: Number.isFinite(connection.websocketFirst) && Number.isFinite(connection.websocketClosed)
          ? Math.round((connection.websocketClosed - connection.websocketFirst) * 1000) : null }));
    },
    clear() { byEngineId.clear(); byWebSocket.clear(); poolConnections.clear(); connections.length = 0; setupEvents.length = 0; networkPhases.length = 0; },
  };
}

export async function startCapture(options) {
  if (!['timing', 'counts'].includes(options.captureMode)) throw new Error('Explicit captureMode=timing|counts required');
  if (options.profiling && !options.outputDir) throw new Error('Profiling requires the existing bundle output directory');
  let cdp;
  try { cdp = await connectPage(options.cdp, options.pageId, options.signal); }
  catch {
    const error = new Error('CDP setup.connect failed; discovery/transport details suppressed');
    error.captureDiagnostics = { setup: { phase: 'setup.connect', kind: 'discovery-or-transport' }, cleanup: { status: 'NOT_CONNECTED', authState: null, asyncCallStackDepth: null } };
    throw error;
  }
  const salt = randomBytes(32).toString('hex');
  // Counts need task/timer envelopes, not necessarily sampled CPU-stack attribution.
  const cpuProfile = options.cpuProfile !== false;
  const trace = options.profiling ? fullTrace(cdp, options.outputDir, options.measurementDurationMs, cpuProfile, options.captureMode) : null;
  let heapStarted = false;
  const requests = [], sockets = [], socketLifecycle = [], telemetry = [], scripts = new Map(), nativePairs = [];
  const socketUrls = new Map();
  const socketConnections = socketConnectionRecorder();
  const initiatorWork = [];
  let asyncCallStackDepth = null, beginAuthState = null;
  const requestedAsyncDepth = options.captureMode === 'counts' ? COUNTS_ASYNC_STACK_DEPTH : 0;
  const expandStack = async (stack, parents = requestedAsyncDepth, seen = new Set()) => {
    if (!stack) return [];
    const frames = stackFrames(stack, 0);
    if (!parents) return frames;
    let parent = stack.parent;
    if (!parent && stack.parentId) {
      const key = JSON.stringify(stack.parentId);
      if (seen.has(key)) return frames;
      seen.add(key);
      parent = (await cdp.send('Debugger.getStackTrace', { stackTraceId: stack.parentId })).stackTrace;
    }
    return [...frames, ...await expandStack(parent, parents - 1, seen)];
  };
  const inFlight = new Map();
  let recording = false, profileStarted = false, identifier, finished, unmappedRequests = 0;
  let startMs, phase = 'setup.connect';
  const diagnostic = (error, failedPhase) => ({ phase: failedPhase,
    kind: /timeout|timed out/i.test(error.message) ? 'timeout' : /closed|disconnect|socket/i.test(error.message) ? 'transport-closed' : 'protocol-or-evaluation' });
  const step = async (name, operation) => { phase = name; return await operation(); };
  const at = (timestamp, request) => timestamp * 1000 + request.clockOffsetMs;
  cdp.on('Debugger.scriptParsed', event => scripts.set(event.scriptId, { url: event.url, sourceMapURL: event.sourceMapURL }));
  cdp.on('Network.requestWillBeSent', event => {
    const socketIdentity = socketConnections.request(event);
    // Both clocks are sampled together by Chromium, not by a queued renderer
    // evaluation. Keep preparation pairs too: an idle window may have sockets
    // before its first new HTTP request (or no HTTP requests at all).
    const paired = Number.isFinite(event.wallTime) && Number.isFinite(event.timestamp);
    const clockOffsetMs = paired ? event.wallTime * 1000 - event.timestamp * 1000 : undefined;
    if (paired) nativePairs.push({ wallTime: event.wallTime, timestamp: event.timestamp, offsetMs: clockOffsetMs });
    if (!recording) return;
    if (!paired) unmappedRequests++;
    if (event.redirectResponse && inFlight.has(event.requestId)) {
      const prior = inFlight.get(event.requestId);
      prior.endMs = at(event.timestamp, prior);
      prior.status = event.redirectResponse.status;
    }
    const row = { id: `${event.requestId}:${requests.length}`, requestId: event.requestId,
      endpoint: safeUrl(event.request.url), method: event.request.method,
      routeClass: networkRouteClass(event.request.url, event.request.method), ...socketIdentity,
      startMs: paired ? event.wallTime * 1000 : undefined, requestStartMs: paired ? event.wallTime * 1000 : undefined,
      nativeWallTime: event.wallTime, nativeTimestamp: event.timestamp, clockOffsetMs,
      fingerprint: requestFingerprint(event.request, salt),
      bodyUnknown: Boolean(event.request.hasPostData && !event.request.postData),
      requestBodyBytes: event.request.postData === undefined ? event.request.hasPostData ? null : 0 : Buffer.byteLength(event.request.postData),
      decodedBytes: 0, encodedBodyBytes: 0, dataChunks: 0,
      initiator: { type: event.initiator?.type, stack: stackFrames(event.initiator?.stack, requestedAsyncDepth) } };
    requests.push(row); inFlight.set(event.requestId, row);
    if (requestedAsyncDepth) initiatorWork.push(expandStack(event.initiator?.stack)
      .then(frames => { row.initiator.stack = frames; })
      .catch(() => { row.initiator.asyncStackUnavailable = true; }));
  });
  cdp.on('Network.responseReceived', event => {
    const row = inFlight.get(event.requestId);
    if (!row) return;
    row.status = event.response.status;
    row.fromCache = Boolean(event.response.fromDiskCache || event.response.fromServiceWorker);
    row.mimeType = event.response.mimeType;
    row.responseReceivedMs = at(event.timestamp, row);
    row.nativeResponseTimestamp = event.timestamp;
    const timing = event.response.timing;
    if (timing && timing.requestTime >= 0) {
      row.requestStartMs = at(timing.requestTime, row);
      if (timing.sendStart >= 0) row.sendStartMs = at(timing.requestTime, row) + timing.sendStart;
      if (timing.receiveHeadersStart >= 0) row.responseHeadersMs = at(timing.requestTime, row) + timing.receiveHeadersStart;
    }
    row.ttfbMs = (row.responseHeadersMs ?? row.responseReceivedMs) - row.requestStartMs;
    row.ttfbBasis = row.responseHeadersMs === undefined ? 'responseReceived.timestamp (headers timing unavailable)' : 'response.timing.receiveHeadersStart';
    if (row.sendStartMs !== undefined) row.sendToHeadersMs = (row.responseHeadersMs ?? row.responseReceivedMs) - row.sendStartMs;
    const header = Object.entries(event.response.headers).find(([key]) => key.toLowerCase() === 'x-request-id');
    if (header && /^[a-zA-Z0-9._:-]+$/.test(String(header[1]))) row.serverRequestId = header[1];
  });
  cdp.on('Network.dataReceived', event => {
    const row = inFlight.get(event.requestId);
    if (row) {
      row.decodedBytes += event.dataLength;
      row.encodedBodyBytes = row.encodedBodyBytes === null || !Number.isFinite(event.encodedDataLength)
        ? null : row.encodedBodyBytes + event.encodedDataLength;
      row.dataChunks++;
    }
  });
  cdp.on('Network.loadingFinished', event => {
    const row = inFlight.get(event.requestId);
    if (row) {
      row.endMs = at(event.timestamp, row); row.nativeEndTimestamp = event.timestamp; row.encodedBytes = event.encodedDataLength;
      if (row.method === 'HEAD' || [204, 304].includes(row.status)) row.decodedBytes = row.encodedBodyBytes = 0;
      else if (!row.dataChunks) row.decodedBytes = row.encodedBodyBytes = null;
      else if (row.decodedBytes > 0 && row.encodedBodyBytes === 0) row.encodedBodyBytes = null;
      inFlight.delete(event.requestId);
    }
  });
  cdp.on('Network.loadingFailed', event => {
    const row = inFlight.get(event.requestId);
    if (row) {
      row.endMs = at(event.timestamp, row); row.nativeEndTimestamp = event.timestamp; row.failed = true; row.canceled = typeof event.canceled === 'boolean' ? event.canceled : null;
      row.decodedBytes = row.encodedBodyBytes = null;
      // CDP errorText can contain arbitrary content; retain only Chromium's code.
      row.failureCode = /^net::ERR_[A-Z0-9_]+$/.test(event.errorText) ? event.errorText : 'unclassified';
      if (/^[a-zA-Z0-9_-]+$/.test(event.blockedReason ?? '')) row.blockedReason = event.blockedReason;
      if (/^[a-zA-Z0-9_-]+$/.test(event.corsErrorStatus?.corsError ?? '')) row.corsError = event.corsErrorStatus.corsError;
      inFlight.delete(event.requestId);
    }
  });
  for (const [method, kind] of [['Created', 'created'], ['WillSendHandshakeRequest', 'handshake-request'], ['HandshakeResponseReceived', 'handshake-response'], ['Closed', 'closed'], ['FrameError', 'frame-error']]) cdp.on(`Network.webSocket${method}`, event => {
    socketConnections.websocket(event, kind);
    if (event.url) socketUrls.set(event.requestId, safeUrl(event.url.replace(/^ws/, 'http')));
    if (recording) socketLifecycle.push({ requestId: event.requestId, kind, nativeTimestamp: event.timestamp ?? null,
      receiptMs: Date.now(), endpoint: socketUrls.get(event.requestId) ?? null });
  });
  for (const direction of ['Sent', 'Received']) cdp.on(`Network.webSocketFrame${direction}`, event => {
    const socketIdentity = socketConnections.frame(event, direction.toLowerCase());
    if (!recording) return;
    const { payloadData, opcode } = event.response;
    const classification = socketFrameClassification(payloadData, opcode);
    const name = classification.event;
    let rpcMethod;
    // Only the method identifier leaves this boundary, never Socket.IO args.
    if (name === 'rpc-call') {
      try { const payload = JSON.parse(payloadData.slice(payloadData.indexOf('['))); const value = payload[1]?.method;
        if (typeof value === 'string' && /^[a-zA-Z0-9_.:/-]+$/.test(value)) rpcMethod = value; } catch {}
    }
    sockets.push({ nativeTimestamp: event.timestamp, requestId: event.requestId, ...socketIdentity, direction: direction.toLowerCase(), opcode, ...classification,
      bytes: opcode === 1 ? Buffer.byteLength(payloadData) : Buffer.byteLength(payloadData, 'base64'),
      ...(rpcMethod ? { rpcMethod } : {}) });
  });
  cdp.on('Runtime.bindingCalled', event => {
    if (event.name !== '__happierPerfTelemetry') return;
    try {
      const value = JSON.parse(event.payload);
      // Consume even malformed setup envelopes here: they are never aggregate
      // telemetry and must not carry private join fields into saved summaries.
      if (value && Object.hasOwn(value, 'scopedRpcSetup')) { socketConnections.setup(value.scopedRpcSetup); return; }
      if (recording) telemetry.push(value);
    } catch {}
  });
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('Browser probe evaluation failed (details suppressed)');
    return result.result.value;
  };
  const close = async ({ attestOff = false } = {}) => {
    const operations = [], errors = [];
    const attempt = async (name, operation) => {
      try { const result = await operation(); operations.push({ phase: name, status: 'ok' }); return result; }
      catch (error) { const result = diagnostic(error, name); errors.push(result); operations.push({ ...result, status: 'failed' }); }
    };
    let off, authState;
    try {
      authState = await attempt('cleanup.auth-surface', () => evaluate(`(${pageAuthSurface.toString()})()`));
      await attempt('cleanup.Debugger.asyncStacksOff', async () => {
        await cdp.send('Debugger.setAsyncCallStackDepth', { maxDepth: 0 }); asyncCallStackDepth = 0;
      });
      if (profileStarted) await attempt('cleanup.Profiler.stop', async () => { await cdp.send('Profiler.stop', {}, { timeout: 60000 }); profileStarted = false; });
      if (heapStarted) await attempt('cleanup.HeapProfiler.stopSampling', async () => { await cdp.send('HeapProfiler.stopSampling'); heapStarted = false; });
      if (trace) await attempt('cleanup.Tracing.end', () => trace.stop());
      await attempt('cleanup.Network.setCacheDisabled', () => cdp.send('Network.setCacheDisabled', { cacheDisabled: false }));
      if (identifier) await attempt('cleanup.Page.removeScript', () => cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }));
      await attempt('cleanup.probe.stop', () => evaluate('globalThis.__happierPerfProbe?.stop(); delete globalThis.__HAPPIER_PERF_CAPTURE_MODE__; delete globalThis.__HAPPIER_PERF_DIAGNOSTICS__'));
      await attempt('cleanup.Runtime.removeBinding', () => cdp.send('Runtime.removeBinding', { name: '__happierPerfTelemetry' }));
      if (attestOff) {
        // A counts-mode instance cannot be turned OFF by removing injection:
        // its constructor already ran. Attest a fresh document instead.
        let offIdentifier;
        try {
          const added = await attempt('cleanup.OFF.addScript', () => cdp.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `globalThis.__HAPPIER_PERF_CAPTURE_MODE__ = "timing"; globalThis.__HAPPIER_PERF_OFF_DOCUMENT__ = ${JSON.stringify(salt)};` }));
          offIdentifier = added?.identifier;
          await attempt('cleanup.OFF.reload', () => cdp.send('Page.reload'));
          off = await attempt('cleanup.OFF.attest', () => evaluate(`new Promise(resolve => { const check = () => {
            const api = globalThis.__HAPPIER_SYNC_PERFORMANCE__;
            if (globalThis.__HAPPIER_PERF_OFF_DOCUMENT__ === ${JSON.stringify(salt)} && api?.isEnabled) resolve({ atMs: Date.now(), storeTelemetry: api.isEnabled(), fiberHook: Boolean(globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__), viewport: { width: innerWidth, height: innerHeight }, authState: (${pageAuthSurface.toString()})() });
            else requestAnimationFrame(check);
          }; check(); })`));
        } finally {
          if (offIdentifier) await attempt('cleanup.OFF.removeScript', () => cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: offIdentifier }));
          await attempt('cleanup.OFF.removeOverride', () => evaluate('delete globalThis.__HAPPIER_PERF_CAPTURE_MODE__; delete globalThis.__HAPPIER_PERF_OFF_DOCUMENT__'));
        }
      }
    } finally { recording = false; socketConnections.clear(); cdp.close(); }
    return { status: errors.length || attestOff && (off?.storeTelemetry !== false || off?.fiberHook !== false) ? 'CLEANUP_FAILED' : 'CLEANED', operations, errors,
      asyncCallStackDepth, authState: authState ?? null,
      ...(attestOff ? { freshDocumentOffAttestation: off ?? null } : {}) };
  };
  try {
    for (const domain of ['Page', 'Network', 'Runtime', 'Debugger', 'Profiler']) await step(`setup.${domain}.enable`, () => cdp.send(`${domain}.enable`));
    await step('setup.Debugger.asyncStacks', async () => {
      await cdp.send('Debugger.setAsyncCallStackDepth', { maxDepth: requestedAsyncDepth }); asyncCallStackDepth = requestedAsyncDepth;
    });
    await step('setup.Runtime.addBinding', () => cdp.send('Runtime.addBinding', { name: '__happierPerfTelemetry' }));
    const probe = `globalThis.__HAPPIER_PERF_CAPTURE_MODE__ = ${JSON.stringify(options.captureMode)}; globalThis.__HAPPIER_PERF_DIAGNOSTICS__ = ${Boolean(options.profiling)};\n` + await readFile(new URL('./browser-probe.js', import.meta.url), 'utf8');
    ({ identifier } = await step('setup.Page.addScript', () => cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: probe })));
    // Install on an already loaded J13 page too, then reload through the journey
    // preparation so React sees the hook before its renderer initializes.
    await step('setup.probe.install', () => evaluate(probe));
    return { cdp, evaluate,
      async begin() {
        beginAuthState = await evaluate(`(${pageAuthSurface.toString()})()`);
        await evaluate('globalThis.__happierPerfProbe.reset()');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: options.cache === 'cold' });
        if (options.cache === 'cold') await cdp.send('Network.clearBrowserCache');
        if (options.profiling) {
          const samplerSources = await jsThreadLagSamplerSources(cdp);
          await cdp.send('HeapProfiler.enable');
          // One MiB allocation sampling retains function attribution without
          // the oversized CDP serialization observed at finer sampling.
          await cdp.send('HeapProfiler.startSampling', { samplingInterval: 1048576, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }); heapStarted = true;
          if (cpuProfile) await cdp.send('Profiler.setSamplingInterval', { interval: 10000 });
          await trace.start(samplerSources);
        }
        startMs = Date.now(); recording = true;
        if (cpuProfile) { await cdp.send('Profiler.start'); profileStarted = true; }
        if (options.profiling) {
          const marker = await evaluate(`(() => { const mark = performance.mark('happier-perf:start'); return { epochMs: performance.timeOrigin + mark.startTime, startTime: mark.startTime, timeOrigin: performance.timeOrigin }; })()`);
          if (!Number.isFinite(marker?.epochMs)) throw new Error('Trace start marker clock unavailable');
          startMs = marker.epochMs;
        }
      },
      async finish({ onWindowEnd } = {}) {
        if (finished) return finished;
        let endMs = Date.now();
        const errors = [];
        const available = async (name, operation) => {
          try { return await operation(); } catch (error) { errors.push(diagnostic(error, name)); return null; }
        };
        if (options.profiling) {
          const marker = await available('finish.trace.end-mark', () => evaluate(`(() => { const mark = performance.mark('happier-perf:end'); return { epochMs: performance.timeOrigin + mark.startTime, startTime: mark.startTime, timeOrigin: performance.timeOrigin }; })()`));
          if (Number.isFinite(marker?.epochMs)) endMs = Number.isFinite(options.measurementDurationMs) ? Math.min(marker.epochMs, startMs + options.measurementDurationMs) : marker.epochMs;
          else errors.push({ phase: 'finish.trace.end-mark', kind: 'marker-clock-unavailable' });
        }
        const probeData = await available('finish.probe.collect', () => evaluate('globalThis.__happierPerfProbe.collect()'));
        if (probeData?.longTasks) {
          const origin = probeData.timeOrigin;
          if (!Number.isFinite(origin)) errors.push({ phase: 'finish.long-tasks', kind: 'performance-time-origin-unavailable' });
          else probeData.longTasks = probeData.longTasks.filter(row => origin + row.atMs < endMs && origin + row.atMs + row.durationMs > startMs);
        }
        if (probeData?.diagnostics) {
          const diagnostics = probeData.diagnostics, origin = diagnostics.timeOrigin;
          diagnostics.storeNotifications = diagnostics.storeNotifications.filter(row => row.atMs >= startMs && row.atMs <= endMs);
          diagnostics.socketEvents = diagnostics.socketEvents.filter(row => row.atMs >= startMs && row.atMs <= endMs);
          diagnostics.reactMeasures = diagnostics.reactMeasures.filter(row => origin + row.startTime >= startMs && origin + row.startTime <= endMs);
          diagnostics.loafs = diagnostics.loafs.filter(row => origin + row.startTime < endMs && origin + row.startTime + row.duration > startMs);
          diagnostics.window = { startMs, endMs };
        }
        if (probeData?.telemetry) telemetry.push(probeData.telemetry);
        const stopped = profileStarted ? await available('finish.Profiler.stop', () => cdp.send('Profiler.stop', {}, { timeout: 60000 })) : null;
        if (stopped) profileStarted = false;
        const heap = heapStarted ? await available('finish.HeapProfiler.stopSampling', () => cdp.send('HeapProfiler.stopSampling', {}, { timeout: 120000 })) : null;
        if (heap) heapStarted = false;
        const traceResult = trace ? await available('finish.Tracing.end', () => trace.stop()) : null;
        if (traceResult?.dataLossOccurred !== false || traceResult?.summary.available === false) {
          if (options.profiling) errors.push({ phase: 'finish.Tracing', kind: traceResult?.dataLossOccurred ? 'trace-data-loss' : 'trace-window-unavailable' });
        }
        recording = false;
        await available('finish.async-initiators', () => Promise.all(initiatorWork));
        if (requests.some(row => row.initiator.asyncStackUnavailable)) errors.push({ phase: 'finish.async-initiators', kind: 'parent-stack-unavailable' });
        const endAuthState = await available('finish.auth-surface', () => evaluate(`(${pageAuthSurface.toString()})()`));
        if (probeData?.instrumentation) Object.assign(probeData.instrumentation, { asyncCallStackDepth, profiling: Boolean(options.profiling), cpuProfile });
        const profile = stopped?.profile;
        let summaryProfile = profile ? normalizeProfileSamples(profile) : null;
        if (summaryProfile && traceResult?.summary.available) {
          const { startUs, endUs } = traceResult.summary;
          let cursor = summaryProfile.startTime;
          const samples = [], timeDeltas = [];
          for (let index = 0; index < summaryProfile.samples.length; index++) {
            const left = cursor; cursor += summaryProfile.timeDeltas[index];
            const overlap = Math.min(cursor, endUs) - Math.max(left, startUs);
            if (overlap > 0) { samples.push(summaryProfile.samples[index]); timeDeltas.push(overlap); }
          }
          summaryProfile = { ...summaryProfile, startTime: startUs, endTime: endUs, samples, timeDeltas };
        }
        const pageUrl = await available('finish.page.attest', () => evaluate('location.href'));
        // Read rotating server evidence before potentially large source maps.
        // This callback is outside the capture bracket/profile, not a wait for
        // new work or a synthetic extension of the measured interval.
        if (onWindowEnd) await available('finish.window-evidence', () => onWindowEnd({ startMs, endMs }));
        const symbols = new Map(), sourceMaps = new Map(), mapFailures = [], mapResponses = [];
        // Attribution happens after capture, so reading maps does not inflate
        // journey network or CPU counts. No Metro-only symbolication dependency.
        const heapFrames = [], pendingHeap = heap?.profile?.head ? [heap.profile.head] : [];
        while (pendingHeap.length) { const node = pendingHeap.pop(); heapFrames.push(node.callFrame); pendingHeap.push(...node.children ?? []); }
        for (const frame of [...(profile?.nodes ?? []).map(node => node.callFrame), ...heapFrames]) {
          const script = scripts.get(frame.scriptId);
          if (!script?.sourceMapURL) continue;
          if (!sourceMaps.has(frame.scriptId)) {
            try {
              const mapUrl = script.sourceMapURL.startsWith('data:') ? new URL(script.sourceMapURL) : new URL(script.sourceMapURL, script.url);
              let json;
              if (mapUrl.protocol === 'data:') json = JSON.parse(Buffer.from(mapUrl.href.split(',')[1], 'base64').toString());
              else {
                if (mapUrl.origin !== new URL(script.url).origin) throw new Error('cross-origin map omitted');
                const response = await fetch(mapUrl, { credentials: 'omit', signal: options.signal });
                if (!response.ok) throw new Error('map unavailable');
                json = await response.json();
                mapResponses.push({ script: safeUrl(script.url), map: safeUrl(mapUrl.href), status: response.status });
              }
              sourceMaps.set(frame.scriptId, new SourceMap(json));
            } catch { sourceMaps.set(frame.scriptId, null); mapFailures.push({ scriptId: frame.scriptId, url: safeUrl(script.url) }); }
          }
          const mapped = sourceMaps.get(frame.scriptId)?.findEntry(frame.lineNumber, frame.columnNumber);
          if (mapped?.originalSource) symbols.set(frameKey(frame), { source: mapped.originalSource.split(/[?#]/)[0],
            name: mapped.name ?? frame.functionName, line: mapped.originalLine, column: mapped.originalColumn });
        }
        for (const node of profile?.nodes ?? []) node.callFrame.url = safeUrl(node.callFrame.url);
        for (const frame of heapFrames) frame.url = safeUrl(frame.url);
        // Keys above use original URLs; transfer mappings after URL redaction.
        const cleanSymbols = new Map();
        for (const [key, value] of symbols) { const parts = JSON.parse(key); parts[1] = safeUrl(parts[1]); cleanSymbols.set(JSON.stringify(parts), value); }
        const windowRequests = requests.filter(row => row.startMs >= startMs && row.startMs <= endMs).map(row => ({ ...row,
          pendingAtEnd: row.endMs === undefined || row.endMs > endMs, completedAfterWindow: row.endMs > endMs }));
        const orderedPairs = [...nativePairs].sort((a, b) => a.timestamp - b.timestamp);
        const mappedSockets = sockets.map(row => {
          let low = 0, high = orderedPairs.length;
          while (low < high) { const middle = (low + high) >>> 1;
            if (orderedPairs[middle].timestamp <= row.nativeTimestamp) low = middle + 1; else high = middle; }
          const pair = orderedPairs[Math.max(0, low - 1)];
          return { ...row, atMs: pair ? row.nativeTimestamp * 1000 + pair.offsetMs : null };
        });
        const unmappedSocketFrames = mappedSockets.filter(row => row.atMs === null).length;
        if (unmappedRequests || unmappedSocketFrames) errors.push({ phase: 'finish.clock', kind: 'native-clock-pair-unavailable' });
        const windowSockets = mappedSockets.filter(row => row.atMs !== null && row.atMs >= startMs && row.atMs <= endMs);
        const lifecycle = socketLifecycle.map(row => {
          const pair = orderedPairs.findLast(pair => pair.timestamp <= row.nativeTimestamp) ?? orderedPairs[0];
          return { ...row, atMs: row.nativeTimestamp !== null && pair ? row.nativeTimestamp * 1000 + pair.offsetMs : row.receiptMs,
            clockBasis: row.nativeTimestamp !== null && pair ? 'native-clock-pair' : 'controller-receipt' };
        }).filter(row => row.atMs >= startMs && row.atMs <= endMs);
        if (heap?.profile) await available('finish.heap-artifact', () => writeFile(join(options.outputDir, 'heap.heapprofile'), JSON.stringify(heap.profile) + '\n', { mode: 0o600 }));
        for (const loaf of probeData?.diagnostics?.loafs ?? []) for (const script of loaf.scripts ?? []) {
          script.sourceURL = safeUrl(script.sourceURL);
          if (/^(?:https?:|file:|\/)/.test(script.invoker ?? '')) script.invoker = safeUrl(script.invoker);
        }
        const profiling = options.profiling ? { trace: traceResult, heap: { artifact: heap ? 'heap.heapprofile' : null,
          samplingInterval: 1048576, includesCollectedObjects: true, scope: 'sampling lifecycle includes setup/finalization; estimates are not retained heap',
          summary: summarizeHeapProfile(heap?.profile, cleanSymbols) } } : undefined;
        return finished = { startMs, endMs, durationMs: endMs - startMs, profile: profile ?? null, cpu: summaryProfile ? summarizeProfile(summaryProfile, cleanSymbols) : null, profiling,
          network: { ...summarizeNetwork(windowRequests, { startMs, endMs }), records: windowRequests, observedThroughMs: Date.now() }, sockets: windowSockets,
          socketConnections: socketConnections.snapshot(startMs, endMs, orderedPairs),
          socketSetup: { producerAvailable: probeData?.diagnostics?.scopedRpcSetupAvailable === true,
            phases: socketConnections.setupSnapshot(startMs, endMs, orderedPairs) },
          socketTimeline: { source: 'CDP physical WebSocket lifecycle and Engine.IO/Socket.IO frame kinds; physical connects alone do not establish a logical root reconnect',
            events: [...lifecycle, ...windowSockets].sort((a, b) => a.atMs - b.atMs) }, telemetry,
          react: probeData, authState: { begin: beginAuthState, end: endAuthState }, observedUi: { url: safeUrl(pageUrl), scripts: [...new Set([...scripts.values()].map(script => safeUrl(script.url)).filter(Boolean))] },
          attribution: { sourceMaps: [...sourceMaps.values()].filter(Boolean).length, attemptedSourceMaps: sourceMaps.size,
            mappedFrames: symbols.size, mapResponses, mapFailures },
          clock: { basis: 'Native Network.requestWillBeSent wallTime/timestamp pairs; request-local conversion, preceding pair (first pair for earlier sockets)',
            rendererRoundTripUsed: false, controllerWindowClock: options.profiling ? 'In-page performance mark timeOrigin + startTime; trace uses the same marks, no controller-receipt calibration' : 'Date.now', nativePairs: [...nativePairs], unmappedRequests, unmappedSocketFrames,
            ...(unmappedSocketFrames ? { unmappedSocketRecords: mappedSockets.filter(row => row.atMs === null) } : {}) },
          collectionErrors: errors, socketEventsPerSecond: windowSockets.length * 1000 / (endMs - startMs) };
      },
      close,
    };
  } catch (error) {
    const setup = diagnostic(error, phase);
    const cleanup = await close();
    const failure = new Error(`CDP ${setup.phase} failed (${setup.kind}; details suppressed)`);
    failure.captureDiagnostics = { setup, cleanup };
    throw failure;
  }
}
