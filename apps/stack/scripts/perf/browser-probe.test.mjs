import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { safeUrl, requestFingerprint, summarizeNetwork, compareRuns } from './analysis.mjs';
import { createSyncPerformanceTelemetry, emitSyncPerformanceSummaryToConsole, installSyncPerformanceTelemetryGlobal } from '../../../ui/sources/sync/runtime/syncPerformanceTelemetry.ts';
import { summarizeSyncPerformanceSummaries } from '../../../ui/scripts/syncPerformanceTelemetryReport.mjs';

test('diagnostics observe React tracks and LoAFs without a fiber hook, bind late export telemetry, drain and clean up', async () => {
  const observers = [], listeners = new Map();
  class Observer {
    static supportedEntryTypes = ['longtask', 'long-animation-frame', 'measure'];
    constructor(callback) { this.callback = callback; this.pending = []; observers.push(this); }
    observe(options) { this.type = options.type; }
    takeRecords() { return this.pending.splice(0); }
    disconnect() { this.disconnected = true; }
  }
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  let notify, setup, unsubscribed = 0, setupUnsubscribed = 0;
  const setupDeliveries = [];
  const api = { isEnabled: () => false, reset() {}, flush() {},
    scopedRpcSetupAvailable: () => true,
    subscribeScopedRpcSetup(callback) { setup = callback; return () => { setupUnsubscribed++; setup = null; }; },
    storeNotificationsAvailable: () => true,
    subscribeStoreNotifications(callback) { notify = callback; return () => { unsubscribed++; notify = null; }; } };
  const context = vm.createContext({ __HAPPIER_PERF_CAPTURE_MODE__: 'timing', __HAPPIER_PERF_DIAGNOSTICS__: true,
    __happierPerfTelemetry: payload => setupDeliveries.push(JSON.parse(payload)),
    performance: { now: () => 20, timeOrigin: 1000 }, PerformanceObserver: Observer, URL,
    localStorage: storage, sessionStorage: storage,
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name) });
  vm.runInContext(await readFile(new URL('./browser-probe.js', import.meta.url), 'utf8'), context);
  assert.equal(context.__REACT_DEVTOOLS_GLOBAL_HOOK__, undefined);
  context.__HAPPIER_SYNC_PERFORMANCE__ = api;
  listeners.get('happier:sync-performance-ready')();
  assert.equal(typeof setup, 'function', 'the existing diagnostic owner must attach the scoped setup producer');
  setup({ phase: 'acquire', connectionId: 1, atMs: 20, origin: 'http://app.test', private: 'never-save' });
  assert.deepEqual(setupDeliveries, [{ scopedRpcSetup: { phase: 'acquire', connectionId: 1, timeOrigin: 1000, atMs: 1020, origin: 'http://app.test' } }]);
  notify({ atMs: 7, changedKeys: ['machines'] });
  const measures = observers.find(observer => observer.type === 'measure');
  measures.callback({ getEntries: () => [
    { name: '\u200bVisibleRow', startTime: 3, duration: 4, detail: { devtools: { track: 'Components', trackGroup: 'React Components', secret: 'omit' }, props: { secret: 'omit' } } },
    { name: 'Update', startTime: 8, duration: 2, detail: { devtools: { track: 'Blocking', trackGroup: 'Scheduler' } } },
    { name: 'unrelated', startTime: 1, duration: 1, detail: { props: 'omit' } },
  ] });
  const loaf = observers.find(observer => observer.type === 'long-animation-frame');
  loaf.pending.push({ startTime: 5, duration: 70, blockingDuration: 20, renderStart: 6, styleAndLayoutStart: 7, firstUIEventTimestamp: 0,
    scripts: [{ startTime: 5, duration: 60, forcedStyleAndLayoutDuration: 2, invoker: 'Window.requestAnimationFrame', invokerType: 'user-callback', sourceFunctionName: 'render', sourceURL: 'https://user:password@example.com/app.js?key=secret#secret', sourceCharPosition: 12 }] });
  const collected = context.__happierPerfProbe.collect();
  const result = JSON.parse(JSON.stringify(collected));
  assert.equal(result.timeOrigin, 1000);
  assert.equal(result.diagnostics.timeOrigin, 1000);
  assert.equal(result.diagnostics.storeNotificationsAvailable, true);
  assert.deepEqual(result.diagnostics.storeNotifications, [{ atMs: 1007, changedKeys: ['machines'] }]);
  assert.equal(result.diagnostics.socketEventsAvailable, false);
  assert.equal(result.diagnostics.scopedRpcSetupAvailable, true);
  assert.deepEqual(result.diagnostics.reactMeasures, [
    { name: '\u200bVisibleRow', startTime: 3, duration: 4, track: 'Components', trackGroup: 'React Components' },
    { name: 'Update', startTime: 8, duration: 2, track: 'Blocking', trackGroup: 'Scheduler' },
  ]);
  assert.equal(result.diagnostics.loafs[0].scripts[0].sourceURL, 'https://example.com/app.js');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(notify, null, 'collection releases the diagnostic store subscription');
  assert.equal(setup, null, 'collection releases the scoped setup subscription');
  measures.callback({ getEntries: () => [{ name: '\u200bLate', startTime: 100, duration: 1 }] });
  assert.equal(collected.diagnostics.reactMeasures.length, 2);
  context.__happierPerfProbe.reset();
  notify({ atMs: 21, changedKeys: [] });
  assert.equal(context.__happierPerfProbe.collect().diagnostics.storeNotifications.length, 1);
  context.__happierPerfProbe.stop();
  assert.equal(unsubscribed, 2);
  assert.equal(setupUnsubscribed, 2);
  assert.equal(listeners.size, 0);
  assert.ok(observers.every(observer => observer.disconnected));
  const priorObservers = observers.length;
  context.__HAPPIER_PERF_DIAGNOSTICS__ = false;
  vm.runInContext(await readFile(new URL('./browser-probe.js', import.meta.url), 'utf8'), context);
  assert.deepEqual(observers.slice(priorObservers).map(observer => observer.type), ['longtask']);
  assert.equal(listeners.size, 0);
  assert.equal(context.__happierPerfProbe.collect().diagnostics, undefined);
  context.__happierPerfProbe.stop();
});

test('periodic producer summaries and terminal remainder aggregate exactly once even when flushes are identical', async () => {
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const delivered = [];
  const context = vm.createContext({ __HAPPIER_PERF_CAPTURE_MODE__: 'counts',
    __happierPerfTelemetry: payload => delivered.push(JSON.parse(payload)),
    performance: { now: () => 1 }, PerformanceObserver: { supportedEntryTypes: [] }, localStorage: storage, sessionStorage: storage });
  const priorHook = globalThis.nativeLoggingHook, priorApi = globalThis.__HAPPIER_SYNC_PERFORMANCE__;
  let now = 0;
  const telemetry = createSyncPerformanceTelemetry({ enabled: true, now: () => now, flushIntervalMs: 1000, emitSummary: emitSyncPerformanceSummaryToConsole });
  installSyncPerformanceTelemetryGlobal(telemetry);
  context.__HAPPIER_SYNC_PERFORMANCE__ = globalThis.__HAPPIER_SYNC_PERFORMANCE__;
  try {
    vm.runInContext(await readFile(new URL('./browser-probe.js', import.meta.url), 'utf8'), context);
    globalThis.nativeLoggingHook = context.nativeLoggingHook;
    context.__happierPerfProbe.reset();
    now = 1000; telemetry.count('sync.store.storage.notify');
    now = 2000; telemetry.count('sync.store.storage.notify');
    now = 2001; telemetry.count('sync.store.storage.notify');
    const terminal = context.__happierPerfProbe.collect();
    const result = summarizeSyncPerformanceSummaries([...delivered, ...(terminal.telemetry ? [terminal.telemetry] : [])]);
    assert.equal(result.events.find(event => event.name === 'sync.store.storage.notify').count, 3);
    assert.equal(result.events.find(event => event.name === 'sync.performance.scenario.perf-capture-end').count, 1);
    assert.ok(delivered.length >= 2, 'periodic flushed summaries must survive production console removal');
  } finally {
    context.__happierPerfProbe?.stop(); telemetry.reset();
    if (priorHook === undefined) delete globalThis.nativeLoggingHook; else globalThis.nativeLoggingHook = priorHook;
    if (priorApi === undefined) delete globalThis.__HAPPIER_SYNC_PERFORMANCE__; else globalThis.__HAPPIER_SYNC_PERFORMANCE__ = priorApi;
  }
});

test('timing mode never installs a fiber hook and requests disabled store telemetry across documents', async () => {
  const local = new Map(), session = new Map();
  const storage = map => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
  const context = vm.createContext({ __HAPPIER_PERF_CAPTURE_MODE__: 'timing', performance: { now: () => 1 }, PerformanceObserver: { supportedEntryTypes: [] }, localStorage: storage(local), sessionStorage: storage(session), __HAPPIER_SYNC_PERFORMANCE__: { isEnabled: () => false, reset() {}, flush() {} } });
  vm.runInContext(await readFile(new URL('./browser-probe.js', import.meta.url), 'utf8'), context);
  assert.equal(context.__REACT_DEVTOOLS_GLOBAL_HOOK__, undefined);
  assert.equal(JSON.parse(local.get('HAPPIER_SYNC_TUNING_JSON')).syncPerformanceTelemetryEnabled, false);
  const result = context.__happierPerfProbe.collect();
  assert.equal(result.instrumentation.fiberHook, false);
  assert.equal(result.instrumentation.storeTelemetry, false);
  assert.equal(result.diagnostics, undefined, 'diagnostic observers are opt-in');
  context.__happierPerfProbe.stop();
  const existingHook = { onCommitFiberRoot() {}, renderers: new Map() };
  const reused = vm.createContext({ __HAPPIER_PERF_CAPTURE_MODE__: 'timing', __REACT_DEVTOOLS_GLOBAL_HOOK__: existingHook, performance: { now: () => 1 }, PerformanceObserver: { supportedEntryTypes: [] }, localStorage: storage(local), sessionStorage: storage(session) });
  vm.runInContext(await readFile(new URL('./browser-probe.js', import.meta.url), 'utf8'), reused);
  assert.equal(reused.__happierPerfProbe.collect().instrumentation.fiberHook, true, 'pre-existing instrumentation cannot be certified OFF');
  reused.__happierPerfProbe.stop();
  assert.equal(reused.__REACT_DEVTOOLS_GLOBAL_HOOK__, existingHook);
});

test('promoted fiber probe rejects unchanged children with retained PerformedWork flags and restores tuning', async () => {
  const local = new Map([['HAPPIER_SYNC_TUNING_JSON', '{"other":true}']]), session = new Map();
  const storage = map => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
  const context = vm.createContext({ performance: { now: () => 1 }, PerformanceObserver: { supportedEntryTypes: [] }, localStorage: storage(local), sessionStorage: storage(session) });
  const source = await readFile(new URL('./browser-probe.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  const child = { tag: 0, type: function VisibleRow() {}, flags: 1 };
  const root = { current: { tag: 3, child } };
  context.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, root);
  context.__happierPerfProbe.reset();
  root.current = { ...root.current };
  context.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, root);
  assert.equal(context.__happierPerfProbe.collect().renders, 0);
  const alternate = { ...child, alternate: child }; child.alternate = alternate;
  root.current = { tag: 3, child: alternate };
  context.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, root);
  assert.equal(context.__happierPerfProbe.collect().components.VisibleRow.renders, 1);
  // Simulate a second document using the same origin before final cleanup.
  const secondDocument = vm.createContext({ performance: { now: () => 1 }, PerformanceObserver: { supportedEntryTypes: [] }, localStorage: storage(local), sessionStorage: storage(session) });
  vm.runInContext(source, secondDocument);
  secondDocument.__happierPerfProbe.stop();
  assert.equal(local.get('HAPPIER_SYNC_TUNING_JSON'), '{"other":true}');
  assert.equal(session.size, 0);
});

test('network evidence strips query, fragment, userinfo and protocol-owned capability paths', () => {
  const projected = safeUrl('https://user:password@example.com/share/capability?key=secret#secret');
  assert.equal(projected, 'https://example.com/share/:token');
  assert.equal(safeUrl('data:text/javascript,secret'), 'data:[omitted]');
  const a = requestFingerprint({ method: 'GET', url: 'http://a/items?q=one' }, 'salt');
  const b = requestFingerprint({ method: 'GET', url: 'http://a/items?q=two' }, 'salt');
  assert.notEqual(a, b);
  assert.equal(summarizeNetwork([{ method: 'POST', endpoint: '/x', fingerprint: a, bodyUnknown: true, startMs: 0 },
    { method: 'POST', endpoint: '/x', fingerprint: a, bodyUnknown: true, startMs: 1 }]).duplicateCandidates, 0);
});

test('comparison never turns unavailable counters into zero or dev timings into production evidence', () => {
  const run = { journey: 'J13', cache: 'warm', uiMode: 'dev', durationMs: 1, counts: { requests: null } };
  const result = compareRuns(Array(5).fill(run), Array(5).fill(run));
  assert.equal(result[0].counts.requests.before, null);
  assert.equal(result[0].counts.requests.delta, null);
  assert.equal(result[0].beforeTiming, null);
});

test('timings exclude count instrumentation and never pool capture modes or legacy unknown modes', () => {
  const run = { journey: 'J1', cache: 'cold', uiMode: 'export', status: 'CAPTURED', counts: {}, durationMs: 10 };
  const counts = Array(5).fill({ ...run, captureMode: 'counts', instrumentation: { storeTelemetry: true, fiberHook: true } });
  const timing = Array(5).fill({ ...run, captureMode: 'timing', instrumentation: { storeTelemetry: false, fiberHook: false } });
  const result = compareRuns([...counts, ...timing], [...counts, ...timing]);
  assert.equal(result.length, 2);
  assert.equal(result.find(row => row.captureMode === 'counts').beforeTiming, null);
  assert.equal(result.find(row => row.captureMode === 'timing').beforeTiming.p50Ms, 10);
  assert.equal(compareRuns(Array(5).fill(run), Array(5).fill(run))[0].beforeTiming, null);
});
