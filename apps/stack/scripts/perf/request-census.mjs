#!/usr/bin/env node
// P03 request census (development QA tooling): per-screen and per-flow server
// request, socket event and full-snapshot read counts, plus React commit/render
// counts and long-task blocked time from this directory's browser probe, on a
// live QA stack, with count budgets. It attaches to an existing QA browser (dev-targets browser
// start) through the Stack CDP transport and reuses this directory's route and
// socket classifiers. It never launches or stops a browser, server or daemon,
// never signs in and never records headers, bodies, query values or text.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateRawSync } from 'node:zlib';
import { networkRouteClass, safeUrl, socketFrameClassification } from './analysis.mjs';

// Route classes whose response is a full list or snapshot rather than a row or delta.
export const SNAPSHOT_ROUTE_CLASSES = Object.freeze(['session-read-batch', 'session-list', 'organization-full']);
const TOTALS = ['requests', 'socketEvents', 'snapshotReads', 'commits', 'renders'];

export function censusRouteKey(method, url) {
  const path = new URL(safeUrl(url), 'http://relative.invalid').pathname
    .split('/').map(segment => (/^\d+$/.test(segment) ? ':n'
      : segment.length >= 16 && /\d/.test(segment) && /^[A-Za-z0-9_-]+$/.test(segment) ? ':id' : segment)).join('/');
  return `${method} ${path}`;
}

// A long task blocks input for the part beyond 50 ms (the long-task threshold).
const blockedMs = longTasks => Math.round(longTasks.reduce((sum, task) => sum + Math.max(0, task.durationMs - 50), 0));

function summarizeProbe(probe) {
  if (!probe) return {};
  const topRenders = Object.fromEntries(Object.entries(probe.components ?? {})
    .map(([name, row]) => [name, row.renders]).sort((a, b) => b[1] - a[1]).slice(0, 12));
  const roots = probe.diagnostics?.updateRoots;
  return { commits: probe.commits, renders: probe.renders, blockedMs: blockedMs(probe.longTasks ?? []), longTasks: (probe.longTasks ?? []).length, topRenders,
    ...(roots ? { updateRoots: Object.fromEntries(Object.entries(roots).sort((a, b) => b[1] - a[1]).slice(0, 12)) } : {}) };
}

// One flow window: requests started inside it, socket frames received/sent inside
// it and, when the browser probe ran, the React work it recorded.
export function summarizeCensusFlow({ requests = [], frames = [], probe = null, preflights = [], assets = [] }) {
  const routes = {}, routeClasses = {}, socket = {}, wakeKinds = {}, routeBytes = {}, socketBytes = {}, routeFields = {}, socketFields = {};
  const bytes = { up: 0, httpEncoded: 0, httpDecoded: 0, preflights: preflights.length, preflightEncoded: 0,
    assets: assets.length, assetsCached: 0, assetEncoded: 0, assetDecoded: 0, wsUp: 0, wsDown: 0, wsFramesUp: 0, wsFramesDown: 0, wsDownMaxFrame: 0, wsDownFramesOver1KiB: 0,
    repeatedResponses: 0, repeatedEncoded: 0 };
  const seenBodies = new Set();
  let snapshotReads = 0, socketEvents = 0;
  for (const request of requests) {
    const key = censusRouteKey(request.method, request.url);
    routes[key] = (routes[key] ?? 0) + 1;
    // Bytes: request body up, response wire (headers + compressed body) and decoded body down.
    if (request.fieldWeights) {
      const weights = routeFields[key] ??= {};
      for (const [path, size] of Object.entries(request.fieldWeights)) weights[path] = (weights[path] ?? 0) + size;
    }
    const row = routeBytes[key] ??= { count: 0, up: 0, encoded: 0, decoded: 0 };
    row.count++; row.up += request.requestBytes ?? 0; row.encoded += request.encodedBytes ?? 0; row.decoded += request.decodedBytes ?? 0;
    bytes.up += request.requestBytes ?? 0; bytes.httpEncoded += request.encodedBytes ?? 0; bytes.httpDecoded += request.decodedBytes ?? 0;
    // A response whose body equals an earlier one for the same route in this flow carried nothing new.
    if (request.bodyHash) {
      const bodyKey = `${key} ${request.bodyHash}`;
      if (seenBodies.has(bodyKey)) { bytes.repeatedResponses++; bytes.repeatedEncoded += request.encodedBytes ?? 0; } else seenBodies.add(bodyKey);
    }
    const routeClass = networkRouteClass(new URL(safeUrl(request.url), 'http://relative.invalid').pathname, request.method);
    routeClasses[routeClass] = (routeClasses[routeClass] ?? 0) + 1;
    if (SNAPSHOT_ROUTE_CLASSES.includes(routeClass)) snapshotReads++;
  }
  for (const preflight of preflights) bytes.preflightEncoded += preflight.encodedBytes ?? 0;
  for (const asset of assets) {
    if (asset.cached) bytes.assetsCached++;
    bytes.assetEncoded += asset.encodedBytes ?? 0; bytes.assetDecoded += asset.decodedBytes ?? 0;
  }
  Object.assign(bytes, socketDeflateEstimate(frames));
  for (const frame of frames) {
    // Socket.IO frames are uncompressed text unless permessage-deflate is negotiated, so payload length ≈ wire bytes.
    const size = (frame.payload ?? '').length;
    if (frame.direction === 'sent') { bytes.wsUp += size; bytes.wsFramesUp++; bytes.up += size; } else {
      bytes.wsDown += size; bytes.wsFramesDown++;
      // Frame sizes: the largest and how many reach the 1 KiB compression threshold.
      bytes.wsDownMaxFrame = Math.max(bytes.wsDownMaxFrame, size); if (size >= 1024) bytes.wsDownFramesOver1KiB++;
    }
    const row = socketFrameClassification(frame.payload ?? '', frame.opcode ?? 1);
    if (row.kind !== 'event') continue;
    socketEvents++;
    const key = `${frame.direction} ${row.event}/${row.type}`;
    socket[key] = (socket[key] ?? 0) + 1;
    socketBytes[key] = (socketBytes[key] ?? 0) + size;
    if (frame.fieldWeights) {
      const weights = socketFields[key] ??= {};
      for (const [path, weight] of Object.entries(frame.fieldWeights)) weights[path] = (weights[path] ?? 0) + weight;
    }
    if (row.type === 'account-change') {
      for (const kind of accountChangeKinds(frame.payload)) wakeKinds[kind] = (wakeKinds[kind] ?? 0) + 1;
    }
  }
  return { requests: requests.length, socketEvents, snapshotReads, routes, routeClasses, socket, wakeKinds, bytes, routeBytes, socketBytes, ...(Object.keys(routeFields).length ? { routeFields } : {}), ...(Object.keys(socketFields).length ? { socketFields } : {}), ...summarizeProbe(probe) };
}

// What permessage-deflate would put on the wire for the received text frames:
// per message without context takeover (each frame alone) and with one shared
// context (a long-lived connection keeps its window), both above a 1 KiB threshold.
export function socketDeflateEstimate(frames) {
  let wsDownDeflatedAlone = 0, wsDownDeflatedShared = 0, window = Buffer.alloc(0);
  for (const frame of frames) {
    if (frame.direction !== 'received' || (frame.opcode ?? 1) !== 1) continue;
    const payload = Buffer.from(frame.payload ?? '');
    if (payload.length < 1024) { wsDownDeflatedAlone += payload.length; wsDownDeflatedShared += payload.length; continue; }
    // The trailing 4-byte sync marker is stripped on the wire (RFC 7692 §7.2.1).
    wsDownDeflatedAlone += deflateRawSync(payload).length - 4;
    // A shared context sees the previous 32 KiB of compressed traffic as its dictionary.
    wsDownDeflatedShared += (window.length ? deflateRawSync(payload, { dictionary: window }) : deflateRawSync(payload)).length - 4;
    window = Buffer.concat([window, payload]).subarray(-32768);
  }
  return { wsDownDeflatedAlone, wsDownDeflatedShared };
}

// Only the change-kind vocabulary is read from a wake; ids and values are not.
function accountChangeKinds(payload) {
  try {
    const body = JSON.parse(payload.slice(payload.indexOf('[')))[1]?.body;
    return Array.isArray(body?.changeKinds) ? body.changeKinds.filter(kind => /^[a-z-]{1,40}$/.test(kind)) : [];
  } catch { return []; }
}

// Budget = the accepted measured count. Any flow total, route or socket key above
// its budget fails; a key without a budget has budget 0. Decreases are reported
// so the budget can be lowered deliberately.
export function checkCensusBudgets(run, budgets) {
  const failures = [], decreases = [], notRun = [];
  for (const [flow, budget] of Object.entries(budgets.flows ?? {})) {
    const observed = run.flows?.[flow];
    if (!observed || observed.status !== 'ok') { notRun.push(flow); continue; }
    const compare = (metric, actual = 0, allowed = 0) => {
      if (actual > allowed) failures.push({ flow, metric, budget: allowed, observed: actual });
      else if (actual < allowed) decreases.push({ flow, metric, budget: allowed, observed: actual });
    };
    for (const total of TOTALS) compare(total, observed[total], budget[total]);
    for (const group of ['routes', 'socket']) {
      for (const key of new Set([...Object.keys(budget[group] ?? {}), ...Object.keys(observed[group] ?? {})])) {
        compare(`${group}:${key}`, observed[group]?.[key], budget[group]?.[key]);
      }
    }
  }
  return { ok: failures.length === 0 && notRun.length === 0, failures, decreases, notRun };
}

export function budgetsFromRuns(runs, bed) {
  const flows = {};
  for (const run of runs) {
    for (const [flow, observed] of Object.entries(run.flows ?? {})) {
      if (observed.status !== 'ok') continue;
      const budget = flows[flow] ??= { routes: {}, socket: {} };
      for (const total of TOTALS) budget[total] = Math.max(budget[total] ?? 0, observed[total] ?? 0);
      for (const group of ['routes', 'socket']) {
        for (const [key, value] of Object.entries(observed[group])) budget[group][key] = Math.max(budget[group][key] ?? 0, value);
      }
    }
  }
  return { bed, basis: `max over ${runs.length} measured run(s)`, flows };
}

// ---- live driver -----------------------------------------------------------

const FLOW_ORDER = ['cold', 'revisit', 'idle60', 'settings', 'notifications', 'store', 'projects', 'inbox', 'search', 'newSession', 'workflows', 'workflow', 'workflowRun', 'sessionShort', 'session', 'scrollBack', 'switch', 'home', 'turn', 'stream', 'stop', 'sendAfterStop', 'idleVisible', 'idleHidden', 'resume'];
const SCREENS = { settings: '/settings', notifications: '/settings/notifications', store: '/plugins', projects: '/projects', inbox: '/inbox', search: '/search?q=message', newSession: '/new', workflows: '/workflows', home: '/' };
const SHORT_PROMPT = 'Reply with the single word: ok';
const LONG_PROMPT = 'Write the integers from 1 to 400 separated by single spaces, nothing else.';
// The fake Claude's long-stream prompt: `lsl <rounds> <deltas> <deltaMs>` streams that many text deltas, so bytes per delta are known.
const STREAM_PROMPT = 'lsl 1 200 30';
const FIRST_ROW = `[...document.querySelectorAll('[data-testid^="transcript-item-"]')].some(e => e.getClientRects().length > 0)`;

async function attach(cdpEndpoint, pageId, { attribution = false } = {}) {
  const { connectPage } = await import('./cdp.mjs');
  const cdp = await connectPage(cdpEndpoint, pageId);
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // The PERF capture's React/long-task probe. React must see the hook before its
  // renderer initializes, so it is counted from the next document load on.
  const probe = `globalThis.__HAPPIER_PERF_CAPTURE_MODE__ = 'counts'; globalThis.__HAPPIER_PERF_DIAGNOSTICS__ = ${attribution};\n`
    + await readFile(new URL('./browser-probe.js', import.meta.url), 'utf8');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: probe });
  // A background tab is a hidden runtime: the app idles it and refuses Home
  // probes, so every count would describe a different program. Keep it in front.
  await cdp.send('Page.bringToFront');
  return cdp;
}

// Throughput/latency presets (WebPageTest connectivity profiles), applied through
// Chrome's network emulation to HTTP and WebSocket traffic alike.
export const THROTTLE_PROFILES = Object.freeze({
  '3gslow': { latency: 400, downloadThroughput: 400_000 / 8, uploadThroughput: 400_000 / 8 },
  '3g': { latency: 300, downloadThroughput: 1_600_000 / 8, uploadThroughput: 768_000 / 8 },
  '4g': { latency: 170, downloadThroughput: 9_000_000 / 8, uploadThroughput: 9_000_000 / 8 },
  // Chrome DevTools "Slow 4G" preset (its former "Fast 3G"): 1.44 Mbit/s down, 675 kbit/s up, 562.5 ms.
  slow4g: { latency: 562.5, downloadThroughput: 1_600_000 / 8 * 0.9, uploadThroughput: 750_000 / 8 * 0.9 },
});

// Byte weight of each field path in a JSON body (array items merged as `[]`),
// two levels below the top. Only field names and sizes are kept; values and
// id-like map keys (`:id`) are not.
export function jsonFieldWeights(value, depth = 3, prefix = '', out = {}) {
  const add = (path, item) => { out[path] = (out[path] ?? 0) + JSON.stringify(item ?? null).length; };
  if (Array.isArray(value)) { for (const item of value) jsonFieldWeights(item, depth, `${prefix}[]`, out); return out; }
  if (!value || typeof value !== 'object' || depth === 0) return out;
  for (const [rawKey, item] of Object.entries(value)) {
    const key = rawKey.length >= 16 && /\d/.test(rawKey) || /^[0-9a-f-]{20,}$/i.test(rawKey) ? ':id' : rawKey;
    const path = prefix ? `${prefix}.${key}` : key;
    add(path, item);
    jsonFieldWeights(item, depth - 1, path, out);
  }
  return out;
}

const hashBody = async body => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
};

function recorder(cdp, serverOrigin, { shapes = false } = {}) {
  let window = null, lastRequestAt = Date.now();
  const inflight = new Map();
  const isServer = url => { try { const u = new URL(url); return u.origin === serverOrigin || (/^\/v\d+\//.test(u.pathname) && !u.pathname.endsWith('.bundle')); } catch { return false; } };
  // Engine.IO long-polling carries socket traffic; its bodies are not responses worth hashing.
  const isPolling = url => { try { return new URL(url).pathname.startsWith('/v1/updates'); } catch { return false; } };
  cdp.on('Network.requestWillBeSent', event => {
    const { method, url, postData } = event.request;
    if (!window || url.startsWith('data:') || url.startsWith('blob:')) return;
    const kind = method === 'OPTIONS' || event.type === 'Preflight' ? 'preflight' : isServer(url) ? 'request' : 'asset';
    if (kind !== 'asset') lastRequestAt = Date.now();
    const row = { method, url, requestBytes: postData ? Buffer.byteLength(postData) : 0, encodedBytes: 0, decodedBytes: 0, cached: false };
    inflight.set(event.requestId, { kind, row, window });
    window[kind === 'request' ? 'requests' : kind === 'preflight' ? 'preflights' : 'assets'].push(row);
  });
  cdp.on('Network.responseReceived', event => {
    const entry = inflight.get(event.requestId);
    if (entry && (event.response.fromDiskCache || event.response.fromServiceWorker || event.response.fromPrefetchCache)) entry.row.cached = true;
  });
  cdp.on('Network.dataReceived', event => { const entry = inflight.get(event.requestId); if (entry) entry.row.decodedBytes += event.dataLength; });
  cdp.on('Network.loadingFinished', event => {
    const entry = inflight.get(event.requestId);
    if (!entry) return;
    inflight.delete(event.requestId);
    entry.row.encodedBytes = event.encodedDataLength;
    if (entry.kind !== 'request' || isPolling(entry.row.url)) return;
    // Only a digest of the body is kept, to recognise a response repeated within the flow.
    entry.window.pending.push(cdp.send('Network.getResponseBody', { requestId: event.requestId })
      .then(async ({ body, base64Encoded }) => {
        const raw = base64Encoded ? Buffer.from(body, 'base64') : body;
        entry.row.bodyHash = await hashBody(raw);
        if (shapes && !base64Encoded) { try { entry.row.fieldWeights = jsonFieldWeights(JSON.parse(body)); } catch {} }
      })
      .catch(() => {}));
  });
  cdp.on('Network.loadingFailed', event => inflight.delete(event.requestId));
  for (const [method, direction] of [['Network.webSocketFrameReceived', 'received'], ['Network.webSocketFrameSent', 'sent']]) {
    cdp.on(method, event => {
      if (!window) return;
      const frame = { direction, opcode: event.response.opcode, payload: event.response.payloadData };
      if (shapes && frame.opcode === 1 && frame.payload.length >= 512) {
        try { frame.fieldWeights = jsonFieldWeights(JSON.parse(frame.payload.slice(frame.payload.indexOf('[')))[1]); } catch {}
      }
      window.frames.push(frame);
    });
  }
  return {
    async start() {
      window = { requests: [], preflights: [], assets: [], frames: [], pending: [], startMs: Date.now() }; lastRequestAt = Date.now();
      await evaluate(cdp, 'globalThis.__happierPerfProbe?.reset()');
    },
    // A document load replaces the page, so its probe starts counting at the new document.
    async stop() {
      const done = window; window = null;
      await Promise.all(done.pending);
      const probe = await evaluate(cdp, 'globalThis.__happierPerfProbe ? (({ commits, renders, components, longTasks, diagnostics }) => ({ commits, renders, components, longTasks, diagnostics: diagnostics && { updateRoots: diagnostics.updateRoots } }))(globalThis.__happierPerfProbe.collect()) : null').catch(() => null);
      if (!probe) throw new Error('browser probe unavailable: reload the page after attaching');
      return { ...summarizeCensusFlow({ ...done, probe }), windowMs: Date.now() - done.startMs };
    },
    async quiet(quietMs, maxMs) {
      const t0 = Date.now();
      while (Date.now() - lastRequestAt < quietMs && Date.now() - t0 < maxMs) await delay(250);
      return Date.now() - lastRequestAt >= quietMs;
    },
  };
}

const evaluate = async (cdp, expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
// Retained surfaces keep hidden copies of a test id; act on the visible one.
const visibleElement = testId => `[...document.querySelectorAll('[data-testid="${testId}"]')].find(e => e.getClientRects().length > 0)`;
const visible = testId => `!!(${visibleElement(testId)})`;

async function waitFor(cdp, expression, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) { if (await evaluate(cdp, expression).catch(() => false)) return Date.now() - t0; await delay(250); }
  return null;
}

async function clickTestId(cdp, testId) {
  const box = await evaluate(cdp, `(() => { const e = ${visibleElement(testId)}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!box) throw new Error(`missing ${testId}`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
}

async function send(cdp, text) {
  const focused = await evaluate(cdp, `(() => { const root = ${visibleElement('session-composer-input')}; const e = root?.matches('textarea,input,[contenteditable]') ? root : root?.querySelector('textarea,input,[contenteditable]'); if (!e) return false; e.focus(); return document.activeElement === e; })()`);
  if (!focused) throw new Error('composer input not focusable');
  await cdp.send('Input.insertText', { text });
  await delay(200);
  for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
}

// Headless Chromium keeps a background tab `visible`, so hiding is the page's own visibility
// override plus a visibilitychange event (the method P03-FOREGROUND/REOPEN used).
const setHidden = (cdp, hidden) => evaluate(cdp, `(() => { const h = ${hidden}; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => h ? 'hidden' : 'visible' });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); document.dispatchEvent(new Event('visibilitychange')); return document.visibilityState; })()`);

const push = (cdp, path) => evaluate(cdp, `(() => { history.pushState({}, '', ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent('popstate', { state: {} })); return true; })()`);

async function runLive(options) {
  const cdp = await attach(options.cdp, options['page-id'], { attribution: Boolean(options.attribution) });
  const rec = recorder(cdp, new URL(options.server).origin, { shapes: Boolean(options.shapes) });
  if (options.throttle) {
    const profile = THROTTLE_PROFILES[options.throttle];
    if (!profile) throw new Error(`--throttle must be one of ${Object.keys(THROTTLE_PROFILES).join(', ')}`);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, ...profile });
  }
  const flows = {};
  const selected = options.flows ? options.flows.split(',') : FLOW_ORDER;
  const quietMs = Number(options['quiet-ms'] ?? 3000), maxMs = Number(options['max-ms'] ?? 60000);
  const appUrl = `${options.ui.replace(/\/$/, '')}/?server=${encodeURIComponent(options.server)}&happier_hmr=0`;
  const measure = async (flow, action) => {
    if (!selected.includes(flow)) return;
    process.stdout.write(`${flow} ... `);
    await cdp.send('Page.bringToFront');
    await rec.start();
    try {
      const detail = await action();
      if (await evaluate(cdp, 'document.visibilityState') !== 'visible') throw new Error('page was hidden during the flow');
      flows[flow] = { status: 'ok', ...(await rec.stop()), ...detail };
      console.log(`requests ${flows[flow].requests}, socket events ${flows[flow].socketEvents}, snapshot reads ${flows[flow].snapshotReads}, commits ${flows[flow].commits}, renders ${flows[flow].renders}, blocked ${flows[flow].blockedMs} ms`);
    } catch (error) {
      const partial = await rec.stop().catch(() => ({}));
      flows[flow] = { status: 'failed', reason: String(error.message).slice(0, 120), ...partial };
      console.log(`FAILED (${flows[flow].reason})`);
    }
  };
  const settle = async () => ({ quiet: await rec.quiet(quietMs, maxMs) });
  const load = async () => {
    await cdp.send('Page.navigate', { url: appUrl });
    const readyMs = await waitFor(cdp, visible('app-rail'), Number(options['boot-ms'] ?? 600000));
    if (readyMs === null) throw new Error('app shell did not render');
    return { readyMs, ...(await settle()) };
  };
  const turnEnd = async maxTurnMs => {
    const started = await waitFor(cdp, visible('agent-input-abort'), 30000);
    const ended = started === null ? null : await waitFor(cdp, `!${visible('agent-input-abort')}`, maxTurnMs);
    if (ended === null) throw new Error('turn did not start and finish');
    await delay(3000);
    return { startMs: started, ...(await settle()) };
  };

  await measure('cold', async () => {
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.clearBrowserCache');
    try { return await load(); } finally { await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }); }
  });
  await measure('revisit', load);
  await measure('idle60', async () => { await push(cdp, '/'); await delay(60000); return {}; });
  for (const flow of ['settings', 'notifications', 'store', 'projects', 'inbox', 'search', 'newSession', 'workflows']) {
    await measure(flow, async () => { await push(cdp, SCREENS[flow]); return settle(); });
  }
  // A saved Workflow and a Workflow run, opened by id.
  for (const [flow, option, path] of [['workflow', 'workflow', '/workflows/'], ['workflowRun', 'workflow-run', '/workflows/runs/']]) {
    if (options[option]) await measure(flow, async () => { await push(cdp, path + options[option]); return settle(); });
  }
  // Open a Session: time to the composer and to the first visible transcript row.
  const openSession = async id => {
    const t0 = Date.now();
    await push(cdp, `/session/${id}`);
    const readyMs = await waitFor(cdp, visible('session-composer-input'), 180000);
    if (readyMs === null) throw new Error('composer did not render');
    const rowMs = await waitFor(cdp, FIRST_ROW, 180000);
    return { readyMs, firstRowMs: rowMs === null ? null : Date.now() - t0, ...(await settle()) };
  };
  if (options['session-short']) await measure('sessionShort', () => openSession(options['session-short']));
  if (options.session) await measure('session', () => openSession(options.session));
  if (options.session) {
    // Scroll back through the open transcript: 20 wheel steps up at the transcript's centre.
    await measure('scrollBack', async () => {
      const box = await evaluate(cdp, `(() => { const e = ${visibleElement('session-composer-input')}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: Math.max(40, r.y - 300) }; })()`);
      if (!box) throw new Error('no open transcript');
      for (let step = 0; step < 20; step++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -1200 });
        await delay(300);
      }
      return settle();
    });
  }
  if (options.session && options['session-2']) {
    // Switch to a second Session and back to the first (both opened before).
    await measure('switch', async () => {
      for (const id of [options['session-2'], options.session]) {
        await push(cdp, `/session/${id}`);
        if (await waitFor(cdp, visible('session-composer-input'), 180000) === null) throw new Error('composer did not render');
        await rec.quiet(quietMs, maxMs);
      }
      return {};
    });
  }
  await measure('home', async () => { await push(cdp, '/'); return settle(); });
  if (options.session) {
    const onSession = async () => {
      await push(cdp, `/session/${options.session}`);
      if (await waitFor(cdp, visible('session-composer-input'), 180000) === null) throw new Error('composer did not render');
      await rec.quiet(quietMs, maxMs);
    };
    if (['turn', 'stream', 'stop', 'sendAfterStop'].some(flow => selected.includes(flow))) await onSession().catch(() => {});
    await measure('turn', async () => { await send(cdp, SHORT_PROMPT); return turnEnd(180000); });
    // Streaming: a known number of text deltas, the time to the first streamed text and the bytes per delta.
    await measure('stream', async () => {
      const prompt = String(options['stream-prompt'] ?? STREAM_PROMPT);
      const deltas = Number(/lsl\s+(\d+)\s+(\d+)/.exec(prompt)?.slice(1).reduce((a, b) => a * b, 1) ?? 0);
      const t0 = Date.now();
      await send(cdp, prompt);
      const firstTextMs = await waitFor(cdp, `document.body.innerText.includes('item 0.0')`, 120000);
      return { deltas, firstTextMs: firstTextMs === null ? null : Date.now() - t0, ...(await turnEnd(300000)) };
    });
    await measure('stop', async () => {
      await send(cdp, LONG_PROMPT);
      if (await waitFor(cdp, visible('agent-input-abort'), 30000) === null) throw new Error('turn did not start');
      await delay(1500);
      const clickedAt = Date.now();
      await clickTestId(cdp, 'agent-input-abort');
      const stopped = await waitFor(cdp, `!${visible('agent-input-abort')}`, 60000);
      if (stopped === null) throw new Error('stop did not end the turn');
      await delay(3000);
      return { stopMs: Date.now() - clickedAt - 3000, ...(await settle()) };
    });
    await measure('sendAfterStop', async () => { await send(cdp, SHORT_PROMPT); return turnEnd(180000); });
  }
  const idleMs = Number(options['idle-ms'] ?? 300000);
  await measure('idleVisible', async () => { await push(cdp, '/'); await rec.quiet(quietMs, maxMs); await rec.start(); await delay(idleMs); return { idleMs }; });
  // Hidden, as when the user switches away from the app.
  await measure('idleHidden', async () => {
    await push(cdp, '/');
    await rec.quiet(quietMs, maxMs);
    if (await setHidden(cdp, true) !== 'hidden') throw new Error('page did not hide');
    await rec.start();
    try { await delay(idleMs); } finally { await setHidden(cdp, false); }
    return { idleMs, hidden: true };
  });
  // Foreground after being away: hidden for --away-ms (not counted), then the return is counted.
  await measure('resume', async () => {
    await push(cdp, '/');
    await rec.quiet(quietMs, maxMs);
    const awayMs = Number(options['away-ms'] ?? idleMs);
    if (await setHidden(cdp, true) !== 'hidden') throw new Error('page did not hide');
    await delay(awayMs);
    await rec.start();
    await setHidden(cdp, false);
    return { awayMs, ...(await settle()) };
  });
  cdp.close();
  return { at: new Date().toISOString(), ui: new URL(options.ui).origin, flows };
}

export function formatCensusTable(run) {
  const lines = ['| flow | requests | socket events | full snapshot reads | commits | renders | blocked ms | top routes | socket events by type | account-change kinds | top renders |', '|---|---:|---:|---:|---:|---:|---:|---|---|---|---|'];
  const top = (map, n = 6) => Object.entries(map ?? {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ×${v}`).join('; ');
  for (const [flow, row] of Object.entries(run.flows)) {
    if (row.status !== 'ok') { lines.push(`| ${flow} | ${row.status} | | | | | | ${row.reason ?? ''} | | | |`); continue; }
    lines.push(`| ${flow} | ${row.requests} | ${row.socketEvents} | ${row.snapshotReads} | ${row.commits} | ${row.renders} | ${row.blockedMs} | ${top(row.routes)} | ${top(row.socket, 5)} | ${top(row.wakeKinds, 4)} | ${top(row.topRenders, 4)} |`);
  }
  return lines.join('\n');
}

const kib = value => (value / 1024).toFixed(1);
export function formatBytesTable(run) {
  const lines = ['| flow | ready ms (composer / first row / first streamed text) | requests | preflights | up KiB | HTTP down wire KiB | HTTP down decoded KiB | repeated responses (KiB) | assets (cached) | asset wire KiB | WS frames down/up (≥1 KiB, max B) | WS down KiB | WS down if deflated KiB (per msg / shared ctx) | WS up KiB | top routes by wire KiB | top socket types by KiB |',
    '|---|---:|---:|---:|---:|---:|---:|---|---|---:|---|---:|---|---:|---|---|'];
  for (const [flow, row] of Object.entries(run.flows)) {
    if (row.status !== 'ok' || !row.bytes) { lines.push(`| ${flow} | ${row.status} |`); continue; }
    const b = row.bytes;
    const topRoutes = Object.entries(row.routeBytes ?? {}).sort((x, y) => y[1].encoded - x[1].encoded).slice(0, 4)
      .map(([key, value]) => `${key} ×${value.count} ${kib(value.encoded)}/${kib(value.decoded)}`).join('; ');
    const topSocket = Object.entries(row.socketBytes ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([key, value]) => `${key} ${kib(value)}`).join('; ');
    const ready = [row.readyMs, row.firstRowMs && `row ${row.firstRowMs}`, row.firstTextMs && `text ${row.firstTextMs}`].filter(v => v != null && v !== '').join(' / ');
    lines.push(`| ${flow} | ${ready} | ${row.requests} | ${b.preflights} | ${kib(b.up)} | ${kib(b.httpEncoded)} | ${kib(b.httpDecoded)} | ${b.repeatedResponses} (${kib(b.repeatedEncoded)}) | ${b.assets} (${b.assetsCached}) | ${kib(b.assetEncoded)} | ${b.wsFramesDown}/${b.wsFramesUp} (${b.wsDownFramesOver1KiB}, ${b.wsDownMaxFrame}) | ${kib(b.wsDown)} | ${kib(b.wsDownDeflatedAlone)} / ${kib(b.wsDownDeflatedShared)} | ${kib(b.wsUp)} | ${topRoutes} | ${topSocket} |`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) options[match[1]] = match[2] ?? true;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options['write-budgets']) {
    const runs = await Promise.all(String(options.runs ?? '').split(',').filter(Boolean).map(async file => JSON.parse(await readFile(file, 'utf8'))));
    if (!runs.length) throw new Error('--write-budgets needs --runs=a.json[,b.json]');
    await writeFile(options['write-budgets'], JSON.stringify(budgetsFromRuns(runs, options.bed ?? null), null, 2) + '\n');
    return 0;
  }
  let run;
  if (options.input) run = JSON.parse(await readFile(options.input, 'utf8'));
  else {
    if (!options.cdp || !options.ui || !options.server) throw new Error('--cdp, --ui and --server are required (or --input=run.json)');
    run = await runLive(options);
    if (options.out) await writeFile(options.out, JSON.stringify(run, null, 1) + '\n', { mode: 0o600 });
  }
  console.log(formatCensusTable(run));
  console.log(formatBytesTable(run));
  if (!options.budgets) return 0;
  const result = checkCensusBudgets(run, JSON.parse(await readFile(options.budgets, 'utf8')));
  for (const failure of result.failures) console.log(`OVER BUDGET ${failure.flow} ${failure.metric}: ${failure.observed} > ${failure.budget}`);
  for (const flow of result.notRun) console.log(`NOT RUN ${flow}`);
  if (result.decreases.length) console.log(`${result.decreases.length} metric(s) below budget; lower the budget once the decrease is confirmed`);
  console.log(result.ok ? 'CENSUS WITHIN BUDGET' : 'CENSUS FAILED');
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code), error => { console.error(`request-census: ${error.message}`); process.exit(1); });
}
