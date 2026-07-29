import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'webMemoryProfile.mjs');

async function loadModule() {
  try {
    return await import(`file://${scriptPath}`);
  } catch (error) {
    assert.fail(`web memory profile module should load: ${error?.message ?? error}`);
  }
}

test('web memory profile args require an existing CDP source and normalize durations', async () => {
  const {
    parseWebMemoryProfileArgs,
    validateWebMemoryProfileArgs,
  } = await loadModule();

  const args = parseWebMemoryProfileArgs([
    '--agent-browser-session', 'happier-target',
    '--scenario', 'session-view-idle',
    '--cycles', '3',
    '--cycle-ms', '15000',
    '--idle-ms', '45000',
    '--heap-snapshots',
    '--out-dir', '.reviews/memory',
  ], {});

  assert.equal(args.agentBrowserSession, 'happier-target');
  assert.equal(args.scenario, 'session-view-idle');
  assert.equal(args.cycles, 3);
  assert.equal(args.cycleMs, 15000);
  assert.equal(args.idleMs, 45000);
  assert.equal(args.heapSnapshots, true);
  assert.equal(args.outDir, '.reviews/memory');
  assert.doesNotThrow(() => validateWebMemoryProfileArgs(args));

  assert.throws(
    () => validateWebMemoryProfileArgs(parseWebMemoryProfileArgs([], {})),
    /--cdp-url|--agent-browser-session/,
  );
});

test('web memory profile env defaults are explicit and do not embed local secrets', async () => {
  const { buildWebMemoryProfileUsage, parseWebMemoryProfileArgs } = await loadModule();

  assert.equal(
    parseWebMemoryProfileArgs([], { HAPPIER_WEB_MEMORY_AGENT_BROWSER_SESSION: 'warm-ui' }).agentBrowserSession,
    'warm-ui',
  );
  assert.equal(
    parseWebMemoryProfileArgs([], { HAPPIER_WEB_MEMORY_CDP_URL: 'ws://127.0.0.1:1/devtools/browser/test' }).cdpUrl,
    'ws://127.0.0.1:1/devtools/browser/test',
  );

  const usage = buildWebMemoryProfileUsage();
  assert.match(usage, /HAPPIER_WEB_MEMORY_CDP_URL/);
  assert.match(usage, /HAPPIER_WEB_MEMORY_AGENT_BROWSER_SESSION/);
  assert.doesNotMatch(usage, /[A-Z0-9]{5}(?:-[A-Z0-9]{5}){9}/);
  assert.doesNotMatch(usage, /happier-repo-[a-z0-9-]+\.localhost/i);
});

test('sync telemetry filtering keeps only high-signal profiling events', async () => {
  const { filterSyncTelemetrySnapshot } = await loadModule();

  const filtered = filterSyncTelemetrySnapshot({
    marks: [{ name: 'start' }],
    events: [
      { name: 'sync.socket.event', count: 2, totalMs: 3 },
      { name: 'sync.store.sessions.warmCache.schedule', count: 1, totalMs: 0 },
      { name: 'sync.store.sessions.warmCache.flush', count: 1, totalMs: 2 },
      { name: 'ui.sessionsList.rowStoreSubscriptions', count: 1, totalMs: 0 },
      { name: 'ui.sessionsList.viewableRows.changed', count: 1, totalMs: 0 },
      { name: 'sync.sessions.snapshot.hydrationPriority', count: 1, totalMs: 0 },
      { name: 'sync.sessions.snapshot.backgroundHydration', count: 1, totalMs: 12 },
      { name: 'sync.sessions.snapshot.backgroundHydration.attribution', count: 1, totalMs: 1 },
      { name: 'sync.sessions.snapshot.hydrationRow', count: 3, totalMs: 9 },
      { name: 'sync.sessions.snapshot.requiredHydration.wait', count: 1, totalMs: 4 },
      { name: 'sync.sessions.snapshot.firstUsableList', count: 1, totalMs: 20 },
      { name: 'sync.sessions.snapshot.fullyHydratedList', count: 1, totalMs: 45 },
      { name: 'sync.sessions.snapshot.fetchPage.request', count: 1, totalMs: 2 },
      { name: 'sync.sessions.snapshot.fetchPage', count: 1, totalMs: 18 },
      { name: 'sync.sessions.snapshot.fetchPage.responseBody', count: 1, totalMs: 3 },
      { name: 'sync.sessions.snapshot.fetchPage.responseJson', count: 1, totalMs: 4 },
      { name: 'sync.sessions.snapshot.fetchPage.responseSchema', count: 1, totalMs: 5 },
      { name: 'sync.sessions.snapshot.fetchPage.process', count: 1, totalMs: 6 },
      { name: 'sync.sessions.snapshot.decryptDataKeys', count: 1, totalMs: 7 },
      { name: 'sync.sessions.snapshot.decryptRows', count: 1, totalMs: 8 },
      { name: 'sync.sessions.snapshot.renderableBuild', count: 1, totalMs: 9 },
      { name: 'sync.sessions.snapshot.applyRenderables', count: 1, totalMs: 10 },
      { name: 'unrelated.debug.noise', count: 99, totalMs: 999 },
      { name: 'ui.react.render.sessions.list.virtualized', count: 1, totalMs: 4 },
    ],
  });

  assert.deepEqual(filtered.marks, [{ name: 'start' }]);
  assert.deepEqual(filtered.events.map((event) => event.name), [
    'sync.socket.event',
    'sync.store.sessions.warmCache.schedule',
    'sync.store.sessions.warmCache.flush',
    'ui.sessionsList.rowStoreSubscriptions',
    'ui.sessionsList.viewableRows.changed',
    'sync.sessions.snapshot.hydrationPriority',
    'sync.sessions.snapshot.backgroundHydration',
    'sync.sessions.snapshot.backgroundHydration.attribution',
    'sync.sessions.snapshot.hydrationRow',
    'sync.sessions.snapshot.requiredHydration.wait',
    'sync.sessions.snapshot.firstUsableList',
    'sync.sessions.snapshot.fullyHydratedList',
    'sync.sessions.snapshot.fetchPage.request',
    'sync.sessions.snapshot.fetchPage',
    'sync.sessions.snapshot.fetchPage.responseBody',
    'sync.sessions.snapshot.fetchPage.responseJson',
    'sync.sessions.snapshot.fetchPage.responseSchema',
    'sync.sessions.snapshot.fetchPage.process',
    'sync.sessions.snapshot.decryptDataKeys',
    'sync.sessions.snapshot.decryptRows',
    'sync.sessions.snapshot.renderableBuild',
    'sync.sessions.snapshot.applyRenderables',
    'ui.react.render.sessions.list.virtualized',
  ]);
});

test('web memory summary reports forced-GC heap and DOM trends without claiming leaks', async () => {
  const { summarizeWebMemoryProfileSamples } = await loadModule();

  const summary = summarizeWebMemoryProfileSamples([
    {
      label: 'baseline',
      heapUsage: { usedSize: 100, totalSize: 200 },
      domCounters: { nodes: 10, jsEventListeners: 4, documents: 1 },
      pageSignals: {
        performanceMemory: { usedJSHeapSize: 150 },
        syncPerformance: { events: [{ name: 'sync.socket.event', count: 1 }] },
      },
    },
    {
      label: 'cycle',
      heapUsage: { usedSize: 180, totalSize: 240 },
      domCounters: { nodes: 12, jsEventListeners: 5, documents: 1 },
      pageSignals: {
        performanceMemory: { usedJSHeapSize: 230 },
        syncPerformance: { events: [{ name: 'sync.socket.event', count: 5 }] },
      },
    },
    {
      label: 'final',
      heapUsage: { usedSize: 120, totalSize: 220 },
      domCounters: { nodes: 11, jsEventListeners: 4, documents: 1 },
      pageSignals: {
        performanceMemory: { usedJSHeapSize: 170 },
        syncPerformance: { events: [{ name: 'sync.socket.event', count: 8 }] },
      },
    },
  ]);

  assert.deepEqual(summary.trend, {
    heapUsedDelta: 20,
    heapUsedPeak: 180,
    performanceUsedJSHeapDelta: 20,
    nodesDelta: 1,
    jsEventListenersDelta: 0,
    documentsDelta: 0,
    monotonicallyIncreasingHeap: false,
  });
  assert.deepEqual(summary.samples.map((sample) => sample.label), ['baseline', 'cycle', 'final']);
  assert.equal(summary.samples[2].socketEvents, 8);
});

test('web memory profile detaches from existing CDP browsers without closing them', async () => {
  const { closeWebMemoryProfileBrowserConnection } = await loadModule();
  const calls = [];

  await closeWebMemoryProfileBrowserConnection({
    disconnect() { calls.push('disconnect'); },
    close() { calls.push('close'); },
  });

  assert.deepEqual(calls, ['disconnect']);
});

test('web memory profile waits for the app telemetry global after page reload', async () => {
  const { configureAppTelemetry } = await loadModule();
  let attempts = 0;
  let waitedMs = 0;

  const configured = await configureAppTelemetry({
    async evaluate() {
      attempts += 1;
      return attempts >= 3;
    },
    async waitForTimeout(ms) {
      waitedMs += ms;
    },
  }, { attempts: 4, retryMs: 5 });

  assert.equal(configured, true);
  assert.equal(attempts, 3);
  assert.equal(waitedMs, 10);
});

test('web memory profile pre-navigation script enables sync telemetry before app boot', async () => {
  const { buildWebMemoryProfileSyncTuningInitScript } = await loadModule();
  const storage = new Map();
  const context = {
    window: {
      localStorage: {
        setItem(key, value) {
          storage.set(key, value);
        },
      },
    },
  };

  const installed = vm.runInNewContext(buildWebMemoryProfileSyncTuningInitScript({ flushIntervalMs: 120000 }), context);

  assert.equal(installed, true);
  assert.deepEqual(JSON.parse(storage.get('HAPPIER_SYNC_TUNING_JSON')), {
    syncPerformanceTelemetryEnabled: true,
    syncPerformanceTelemetrySlowThresholdMs: 16,
    syncPerformanceTelemetryFlushIntervalMs: 120000,
    jsThreadLagTelemetrySampleIntervalMs: 50,
    jsThreadLagTelemetryThresholdMs: 50,
    jsThreadLagTelemetryMaxSamples: 2048,
    transcriptViewportTelemetryEnabled: true,
    transcriptViewportTelemetryMaxEvents: 2048,
  });
});

test('web memory profile can configure telemetry without resetting cold-start events', async () => {
  const { configureAppTelemetry } = await loadModule();
  const calls = [];

  const configured = await configureAppTelemetry({
    async evaluate(fn, arg) {
      const telemetry = {
        configure(options) {
          calls.push(['configure', options]);
        },
        reset() {
          calls.push(['reset']);
        },
        markScenario(name) {
          calls.push(['markScenario', name]);
        },
        snapshot() {
          return {};
        },
      };
      const previousWindow = globalThis.window;
      globalThis.window = { __HAPPIER_SYNC_PERFORMANCE__: telemetry };
      try {
        return fn(arg);
      } finally {
        globalThis.window = previousWindow;
      }
    },
    async waitForTimeout() {},
  }, { reset: false });

  assert.equal(configured, true);
  assert.deepEqual(calls, [
    ['configure', { enabled: true, slowThresholdMs: 4, flushIntervalMs: 120000 }],
    ['markScenario', 'web-memory-profile-start'],
  ]);
});
