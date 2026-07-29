import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'agentBrowserUiPerfAudit.mjs');

async function loadModule() {
  try {
    return await import(`file://${scriptPath}`);
  } catch (error) {
    assert.fail(`agent browser UI perf audit module should load: ${error?.message ?? error}`);
  }
}

test('default plan covers the critical UI journeys and stress scenario', async () => {
  const { buildDefaultPerfAuditPlan } = await loadModule();

  const plan = buildDefaultPerfAuditPlan({ defaultDurationMs: 1234 });
  const scenarioIds = plan.scenarios.map((scenario) => scenario.id);

  assert.equal(plan.version, 1);
  assert.ok(scenarioIds.includes('desktop.sessionList.idle'));
  assert.ok(scenarioIds.includes('desktop.sessionList.scroll'));
  assert.ok(scenarioIds.includes('desktop.sessionList.search'));
  assert.ok(scenarioIds.includes('desktop.newSession.open'));
  assert.ok(scenarioIds.includes('desktop.newSession.composerTyping'));
  assert.ok(scenarioIds.includes('desktop.sessionView.idle'));
  assert.ok(scenarioIds.includes('desktop.sessionView.streamingIdle'));
  assert.ok(scenarioIds.includes('desktop.sessionView.transcriptScroll'));
  assert.ok(scenarioIds.includes('desktop.sessionView.tabs'));
  assert.ok(scenarioIds.includes('desktop.multiSessionStreaming.sidebarVisible'));
  assert.ok(scenarioIds.includes('mobile.sessionList.hiddenMounted'));
  assert.equal(plan.scenarios.find((scenario) => scenario.id === 'desktop.multiSessionStreaming.sidebarVisible')?.requiresStressSessions, false);
  assert.equal(plan.scenarios.every((scenario) => scenario.durationMs === 1234), true);
});

test('perf audit URL and dev-key defaults come only from explicit environment variables', async () => {
  const { resolvePerfAuditEnvironmentDefaults } = await loadModule();

  assert.deepEqual(resolvePerfAuditEnvironmentDefaults({}), { url: null, devKey: null });
  assert.deepEqual(
    resolvePerfAuditEnvironmentDefaults({
      HAPPIER_UI_PERF_APP_URL: 'http://localhost:1234/?happier_hmr=0',
      HAPPIER_UI_PERF_DEV_KEY: 'test-dev-key',
    }),
    { url: 'http://localhost:1234/?happier_hmr=0', devKey: 'test-dev-key' },
  );
});

test('perf audit usage names required environment variables without embedding local hosts or keys', async () => {
  const { buildAgentBrowserPerfAuditUsage } = await loadModule();

  const text = buildAgentBrowserPerfAuditUsage();

  assert.match(text, /HAPPIER_UI_PERF_APP_URL/);
  assert.match(text, /HAPPIER_UI_PERF_DEV_KEY/);
  assert.doesNotMatch(text, /happier-repo-[a-z0-9-]+\.localhost/i);
  assert.doesNotMatch(text, /[A-Z0-9]{5}(?:-[A-Z0-9]{5}){9}/);
});

test('perf audit runtime validation fails clearly without URL or needed dev key', async () => {
  const { validatePerfAuditRuntimeArgs } = await loadModule();

  assert.throws(
    () => validatePerfAuditRuntimeArgs({ url: null, devKey: 'test-dev-key', skipAuth: false }, { scenarios: [] }),
    /HAPPIER_UI_PERF_APP_URL|--url/,
  );
  assert.throws(
    () => validatePerfAuditRuntimeArgs({ url: 'http://localhost:1234', devKey: null, skipAuth: false }, { scenarios: [] }),
    /HAPPIER_UI_PERF_DEV_KEY|--dev-key/,
  );
  assert.doesNotThrow(() => validatePerfAuditRuntimeArgs(
    { url: 'http://localhost:1234', devKey: null, skipAuth: true },
    { scenarios: [{ requiresColdAuth: false }] },
  ));
  assert.throws(
    () => validatePerfAuditRuntimeArgs(
      { url: 'http://localhost:1234', devKey: null, skipAuth: true },
      { scenarios: [{ requiresColdAuth: true }] },
    ),
    /HAPPIER_UI_PERF_DEV_KEY|--dev-key/,
  );
});

test('stress prompt wrapper confines destructive tool testing to a scratch directory', async () => {
  const { buildSafeStressPrompt } = await loadModule();

  const prompt = buildSafeStressPrompt({
    scratchDir: '/tmp/happier-ui-perf-stress-safe',
    basePrompt: 'please use write, edit, patch, remove, and bash tools',
  });

  assert.match(prompt, /\/tmp\/happier-ui-perf-stress-safe/);
  assert.match(prompt, /only inside/i);
  assert.match(prompt, /Do not modify/i);
  assert.match(prompt, /remove/);
});

test('new-session URL carries a directory seed so stress launches are actionable', async () => {
  const { buildNewSessionUrl } = await loadModule();

  assert.equal(
    buildNewSessionUrl('http://app.local/?happier_hmr=0', '/repo/dev'),
    'http://app.local/new?happier_hmr=0&directory=%2Frepo%2Fdev',
  );
});

test('stress launch button selection prefers composer launch over page header controls', async () => {
  const { chooseLaunchSessionButtonRef } = await loadModule();

  assert.equal(chooseLaunchSessionButtonRef({
    data: {
      refs: {
        e1: { role: 'button', name: 'Start New Session' },
        e2: { role: 'button', name: 'Resume Claude session' },
      },
    },
  }), '@e2');
  assert.equal(chooseLaunchSessionButtonRef({
    data: {
      snapshot: '- button "Start New Session" [ref=e3]\n- text "Resume Claude session"',
      refs: {
        e3: { role: 'button', name: 'Start New Session' },
      },
    },
  }), null);
  assert.equal(chooseLaunchSessionButtonRef({
    data: {
      refs: {
        e3: { role: 'button', name: 'Start New Session' },
      },
    },
  }), '@e3');
});

test('sync tuning override enables telemetry without changing optimized production defaults', async () => {
  const { buildSyncTuningOverride } = await loadModule();

  assert.deepEqual(buildSyncTuningOverride(), {
    syncPerformanceTelemetryEnabled: true,
    syncPerformanceTelemetrySlowThresholdMs: 16,
    syncPerformanceTelemetryFlushIntervalMs: 30000,
    jsThreadLagTelemetrySampleIntervalMs: 50,
    jsThreadLagTelemetryThresholdMs: 50,
    jsThreadLagTelemetryMaxSamples: 2048,
    transcriptViewportTelemetryEnabled: true,
    transcriptViewportTelemetryMaxEvents: 2048,
  });
  assert.equal(buildSyncTuningOverride({ flushIntervalMs: 120000 }).syncPerformanceTelemetryFlushIntervalMs, 120000);
});

test('live telemetry configure script enables sync telemetry without reloading the app', async () => {
  const { buildLiveTelemetryConfigureScript } = await loadModule();
  const calls = [];
  const context = {
    window: {
      __HAPPIER_SYNC_PERFORMANCE__: {
        configure(options) { calls.push(options); },
      },
    },
  };

  const configured = vm.runInNewContext(buildLiveTelemetryConfigureScript({ flushIntervalMs: 12345 }), context);

  assert.equal(configured, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ enabled: true, slowThresholdMs: 16, flushIntervalMs: 12345 }]);
});

test('sync tuning override can merge explicit perf experiment knobs', async () => {
  const { buildSyncTuningOverride, parseSyncTuningOverrideJson } = await loadModule();

  const overrides = parseSyncTuningOverrideJson('{"messageDecryptBatchSize":4,"messageDecryptYieldDelayMs":8,"__proto__":{"polluted":true}}');
  const tuning = buildSyncTuningOverride({ syncTuningOverrides: overrides });

  assert.equal(tuning.syncPerformanceTelemetryEnabled, true);
  assert.equal(tuning.messageDecryptBatchSize, 4);
  assert.equal(tuning.messageDecryptYieldDelayMs, 8);
  assert.equal(Object.prototype.polluted, undefined);
  assert.throws(() => parseSyncTuningOverrideJson('[]'), /JSON object/);
});

test('mobile-hidden plan isolates the keep-mounted mobile session list scenario', async () => {
  const { buildDefaultPerfAuditPlan, selectPlanScenarios } = await loadModule();

  const plan = selectPlanScenarios(buildDefaultPerfAuditPlan(), 'mobile-hidden');

  assert.deepEqual(plan.scenarios.map((scenario) => scenario.id), ['mobile.sessionList.hiddenMounted']);
});

test('cold-hydration plan isolates the fresh auth session-list hydration scenario outside full runs', async () => {
  const { buildDefaultPerfAuditPlan, selectPlanScenarios } = await loadModule();
  const basePlan = buildDefaultPerfAuditPlan({ defaultDurationMs: 1234 });

  const fullPlan = selectPlanScenarios(basePlan, 'full');
  assert.equal(fullPlan.scenarios.some((scenario) => scenario.id === 'desktop.sessionList.coldAuthHydration'), false);

  const coldPlan = selectPlanScenarios(basePlan, 'cold-hydration');
  assert.deepEqual(coldPlan.scenarios.map((scenario) => scenario.id), ['desktop.sessionList.coldAuthHydration']);
  assert.equal(coldPlan.scenarios[0].requiresColdAuth, true);
  assert.equal(coldPlan.scenarios[0].durationMs, 1234);
});

test('plan selection accepts exact scenario ids for targeted repro runs', async () => {
  const { buildDefaultPerfAuditPlan, selectPlanScenarios } = await loadModule();

  const plan = selectPlanScenarios(buildDefaultPerfAuditPlan(), 'desktop.newSession.composerTyping');

  assert.deepEqual(plan.scenarios.map((scenario) => scenario.id), ['desktop.newSession.composerTyping']);
});

test('auth snapshot parsing treats slow-loading welcome controls as pending', async () => {
  const { resolveAuthenticationSurfaceFromSnapshot } = await loadModule();

  assert.deepEqual(resolveAuthenticationSurfaceFromSnapshot({
    data: {
      snapshot: '- heading "Welcome." [ref=e1]\n- heading "First time here?" [ref=e2]\n- text "Loading..."',
      refs: {},
    },
  }), { state: 'pending' });
});

test('auth snapshot parsing recognizes restore controls after login disclosure opens', async () => {
  const { resolveAuthenticationSurfaceFromSnapshot } = await loadModule();

  assert.deepEqual(resolveAuthenticationSurfaceFromSnapshot({
    data: {
      refs: {
        e1: { role: 'textbox', name: 'Enter your secret key' },
        e2: { role: 'button', name: 'Restore Account' },
      },
    },
  }), { state: 'restore', textboxRef: '@e1', restoreAccountRef: '@e2' });
});

test('auth snapshot parsing recognizes compact authenticated session-list tabs', async () => {
  const { resolveAuthenticationSurfaceFromSnapshot } = await loadModule();

  assert.deepEqual(resolveAuthenticationSurfaceFromSnapshot({
    data: {
      snapshot: '- button "localhost:52753 " [ref=e3]\n- tab "Happier" [selected, ref=e1]\n- tab "Direct" [ref=e2]',
      refs: {
        e1: { role: 'tab', name: 'Happier' },
        e2: { role: 'tab', name: 'Direct' },
        e3: { role: 'button', name: 'localhost:52753 ' },
      },
    },
  }), { state: 'authenticated' });
});

test('target session URL detection accepts only concrete session routes', async () => {
  const { isSessionViewUrl } = await loadModule();

  assert.equal(isSessionViewUrl('http://app.local/session/session-1'), true);
  assert.equal(isSessionViewUrl('http://app.local/session/session-1?x=1'), true);
  assert.equal(isSessionViewUrl('http://app.local/'), false);
  assert.equal(isSessionViewUrl('http://app.local/new'), false);
  assert.equal(isSessionViewUrl('http://app.local/session-history'), false);
});

test('target session URL option normalizes direct session routes for DB-unavailable perf repros', async () => {
  const { buildTargetSessionUrl } = await loadModule();

  assert.equal(
    buildTargetSessionUrl('http://app.local/?happier_hmr=0', '/session/session-1?serverId=srv_1'),
    'http://app.local/session/session-1?serverId=srv_1&happier_hmr=0',
  );
  assert.equal(buildTargetSessionUrl('http://app.local/?happier_hmr=0', ''), null);
  assert.throws(() => buildTargetSessionUrl('http://app.local/', '/new'), /session.*route/);
});

test('target session preparation reuses an already-open target route', async () => {
  const { shouldOpenTargetSessionUrl } = await loadModule();

  assert.equal(
    shouldOpenTargetSessionUrl(
      'http://app.local/session/session-1?serverId=srv_1&happier_hmr=0',
      'http://app.local/session/session-1?serverId=srv_1&happier_hmr=0',
    ),
    false,
  );
  assert.equal(
    shouldOpenTargetSessionUrl(
      'http://app.local/session/session-1?serverId=srv_1',
      'http://app.local/session/session-1?serverId=srv_1&happier_hmr=0',
    ),
    false,
  );
  assert.equal(
    shouldOpenTargetSessionUrl(
      'http://app.local/session/session-2?serverId=srv_1&happier_hmr=0',
      'http://app.local/session/session-1?serverId=srv_1&happier_hmr=0',
    ),
    true,
  );
});

test('scenario execution phases install probes after navigation setup', async () => {
  const { resolveScenarioExecutionPhases } = await loadModule();

  assert.deepEqual(resolveScenarioExecutionPhases('sessionListScroll'), { prepare: 'root', measure: 'scroll' });
  assert.deepEqual(resolveScenarioExecutionPhases('sessionViewIdle'), { prepare: 'targetSession', measure: 'idle' });
  assert.deepEqual(resolveScenarioExecutionPhases('mobileHiddenSessionList'), { prepare: 'mobileTargetSession', measure: 'idle' });
  assert.deepEqual(resolveScenarioExecutionPhases('coldAuthSessionListHydration'), { prepare: 'none', measure: 'coldAuthHydration' });
});

test('transcript scroll scenarios wait for the transcript scroller before measuring', async () => {
  const { shouldWaitForTranscriptScrollerBeforeMeasurement } = await loadModule();

  assert.equal(
    shouldWaitForTranscriptScrollerBeforeMeasurement({ id: 'desktop.sessionView.transcriptScroll', action: 'sessionViewTranscriptScroll' }),
    true,
  );
  assert.equal(
    shouldWaitForTranscriptScrollerBeforeMeasurement({ id: 'desktop.sessionList.scroll', action: 'sessionListScroll' }),
    false,
  );
});

test('transcript scroller ready script waits for a real transcript scroll container', async () => {
  const { buildTranscriptScrollerReadyScript } = await loadModule();
  const transcriptScroller = {
    getAttribute: (name) => (name === 'data-testid' ? 'transcript-chat-list' : null),
    scrollHeight: 1400,
    clientHeight: 700,
  };
  const sidebarScroller = {
    getAttribute: () => null,
    scrollHeight: 5000,
    clientHeight: 900,
  };

  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(buildTranscriptScrollerReadyScript(), {
    document: { querySelector: () => sidebarScroller },
  }))), {
    clientHeight: 900,
    ready: false,
    scrollHeight: 5000,
    targetTestId: '',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(buildTranscriptScrollerReadyScript(), {
    document: { querySelector: () => transcriptScroller },
  }))), {
    clientHeight: 700,
    ready: true,
    scrollHeight: 1400,
    targetTestId: 'transcript-chat-list',
  });
});

test('mobile target-session preparation preserves the mobile viewport while opening root', async () => {
  const { resolvePreparationOpenRootViewport } = await loadModule();

  assert.equal(resolvePreparationOpenRootViewport({ prepare: 'targetSession', scenarioViewport: 'desktop' }), 'desktop');
  assert.equal(resolvePreparationOpenRootViewport({ prepare: 'mobileTargetSession', scenarioViewport: 'mobile' }), 'mobile');
});

test('agent-browser wait timeout leaves enough settle margin for long measurements', async () => {
  const { buildAgentBrowserWaitTimeoutMs } = await loadModule();

  assert.equal(buildAgentBrowserWaitTimeoutMs(30000), 90000);
  assert.equal(buildAgentBrowserWaitTimeoutMs(0), 60000);
});

test('scroll kickoff script starts scrolling without awaiting the whole measurement window', async () => {
  const { buildScrollKickoffScript } = await loadModule();
  const scrollTarget = {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 100,
    clientWidth: 200,
    getBoundingClientRect: () => ({ width: 200, height: 100 }),
  };
  let frameCallback = null;
  const context = {
    document: {
      scrollingElement: scrollTarget,
      body: scrollTarget,
      querySelectorAll: () => [],
    },
    window: {},
    performance: { now: () => 0 },
    requestAnimationFrame: (callback) => {
      frameCallback = callback;
      return 1;
    },
    cancelAnimationFrame: () => {},
  };

  const result = vm.runInNewContext(buildScrollKickoffScript(12000), context);

  assert.equal(result.started, true);
  assert.equal(result.durationMs, 12000);
  assert.equal(result.scrollTop, 0);
  assert.equal(result.scrollHeight, 1000);
  assert.equal(result.clientHeight, 100);
  assert.equal(typeof frameCallback, 'function');
  frameCallback(16);
  assert.equal(scrollTarget.scrollTop, 48);
});

test('scroll kickoff script prefers the transcript scroller over a larger session list', async () => {
  const { buildScrollKickoffScript } = await loadModule();
  const makeTarget = (name, metrics, testId = null) => ({
    name,
    scrollTop: 0,
    scrollHeight: metrics.scrollHeight,
    clientHeight: metrics.clientHeight,
    clientWidth: metrics.clientWidth,
    getAttribute: (attribute) => (attribute === 'data-testid' ? testId : null),
    getBoundingClientRect: () => ({ width: metrics.clientWidth, height: metrics.clientHeight }),
  });
  const sidebar = makeTarget('sidebar', { scrollHeight: 5000, clientHeight: 900, clientWidth: 1000 }, 'session-list');
  const transcript = makeTarget('transcript', { scrollHeight: 1400, clientHeight: 700, clientWidth: 720 }, 'transcript-chat-list');
  let frameCallback = null;
  const context = {
    document: {
      scrollingElement: sidebar,
      body: sidebar,
      querySelectorAll: () => [sidebar, transcript],
    },
    window: {},
    performance: { now: () => 0 },
    requestAnimationFrame: (callback) => {
      frameCallback = callback;
      return 1;
    },
    cancelAnimationFrame: () => {},
  };

  const result = vm.runInNewContext(buildScrollKickoffScript(10000), context);

  assert.equal(result.started, true);
  assert.equal(result.scrollHeight, 1400);
  assert.equal(result.clientHeight, 700);
  assert.equal(result.targetTestId, 'transcript-chat-list');
  frameCallback(16);
  assert.equal(transcript.scrollTop, 48);
  assert.equal(sidebar.scrollTop, 0);
});

test('scroll kickoff script labels session-list scrollers by their keyboard-zone ancestor', async () => {
  const { buildScrollKickoffScript } = await loadModule();
  const sessionListScroller = {
    scrollTop: 0,
    scrollHeight: 5000,
    clientHeight: 900,
    clientWidth: 380,
    getAttribute: () => null,
    closest: (selector) => (selector === '[data-testid="sessions-list-keyboard-zone"]' ? { tagName: 'DIV' } : null),
    getBoundingClientRect: () => ({ width: 380, height: 900 }),
  };
  let frameCallback = null;
  const context = {
    document: {
      scrollingElement: sessionListScroller,
      body: sessionListScroller,
      querySelectorAll: () => [],
    },
    window: {},
    performance: { now: () => 0 },
    requestAnimationFrame(callback) {
      frameCallback = callback;
      return 1;
    },
    cancelAnimationFrame: () => {},
  };

  const result = vm.runInNewContext(buildScrollKickoffScript(10000), context);

  assert.equal(result.started, true);
  assert.equal(result.targetTestId, 'session-list');
  frameCallback(16);
  assert.equal(sessionListScroller.scrollTop, 48);
});

test('scroll scenarios fail fast when kickoff targets the wrong scroller', async () => {
  const { validateScrollKickoffResult } = await loadModule();

  assert.throws(
    () => validateScrollKickoffResult(
      { id: 'desktop.sessionView.transcriptScroll', action: 'sessionViewTranscriptScroll' },
      { started: true, targetTestId: 'session-list', scrollHeight: 5000, clientHeight: 900 },
    ),
    /transcript scroller/i,
  );
  assert.doesNotThrow(() => validateScrollKickoffResult(
    { id: 'desktop.sessionView.transcriptScroll', action: 'sessionViewTranscriptScroll' },
    { started: true, targetTestId: 'transcript-chat-list', scrollHeight: 1400, clientHeight: 700 },
  ));
  assert.throws(
    () => validateScrollKickoffResult(
      { id: 'desktop.sessionList.scroll', action: 'sessionListScroll' },
      { started: true, targetTestId: '', scrollHeight: 5000, clientHeight: 900 },
    ),
    /session list scroller/i,
  );
  assert.doesNotThrow(() => validateScrollKickoffResult(
    { id: 'desktop.sessionList.scroll', action: 'sessionListScroll' },
    { started: true, targetTestId: 'session-list', scrollHeight: 5000, clientHeight: 900 },
  ));
});

test('visible textbox value script writes through DOM events without keyboard typing', async () => {
  const { buildSetFirstVisibleTextboxValueScript } = await loadModule();
  class FakeInput {
    constructor() {
      this._value = '';
      this.events = [];
      this.focused = false;
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }
    get value() { return this._value; }
    set value(next) { this._value = String(next); }
    getBoundingClientRect() { return { width: 320, height: 24 }; }
    focus() { this.focused = true; }
    dispatchEvent(event) { this.events.push(event.type); }
  }
  const input = new FakeInput();
  const context = {
    document: { querySelectorAll: () => [input] },
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: class {},
    InputEvent: class {
      constructor(type) { this.type = type; }
    },
    Event: class {
      constructor(type) { this.type = type; }
    },
  };

  const result = vm.runInNewContext(buildSetFirstVisibleTextboxValueScript('perf smoke'), context);

  assert.equal(result.ok, true);
  assert.equal(result.length, 10);
  assert.equal(input.value, 'perf smoke');
  assert.equal(input.focused, true);
  assert.deepEqual(input.events, ['input', 'change']);
});

test('textbox value script accepts animated search inputs with zero measured width', async () => {
  const { buildSetFirstVisibleTextboxValueScript } = await loadModule();
  class FakeSearchInput {
    constructor() {
      this._value = '';
      this.events = [];
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }
    get value() { return this._value; }
    set value(next) { this._value = String(next); }
    getAttribute(name) {
      if (name === 'aria-label') return 'Search sessions';
      if (name === 'placeholder') return 'Search sessions...';
      return null;
    }
    getBoundingClientRect() { return { width: 0, height: 20 }; }
    focus() { this.focused = true; }
    dispatchEvent(event) { this.events.push(event.type); }
  }
  const input = new FakeSearchInput();
  const context = {
    document: { querySelectorAll: () => [input] },
    HTMLInputElement: FakeSearchInput,
    HTMLTextAreaElement: class {},
    InputEvent: class {
      constructor(type) { this.type = type; }
    },
    Event: class {
      constructor(type) { this.type = type; }
    },
  };

  const result = vm.runInNewContext(buildSetFirstVisibleTextboxValueScript('perf'), context);

  assert.equal(result.ok, true);
  assert.equal(input.value, 'perf');
});

test('browser storage clear script removes warm auth/cache state while preserving requested localStorage keys', async () => {
  const { buildClearBrowserStorageScript } = await loadModule();
  const deletedDatabases = [];
  const deletedCaches = [];
  const unregisteredWorkers = [];
  const localEntries = new Map([
    ['HAPPIER_SYNC_TUNING_JSON', '{"syncPerformanceTelemetryEnabled":true}'],
    ['auth-token', 'secret'],
  ]);
  const context = {
    localStorage: {
      getItem: (key) => localEntries.get(key) ?? null,
      setItem: (key, value) => localEntries.set(key, String(value)),
      clear: () => localEntries.clear(),
    },
    sessionStorage: { cleared: false, clear() { this.cleared = true; } },
    caches: {
      keys: async () => ['app-cache', 'image-cache'],
      delete: async (key) => {
        deletedCaches.push(key);
        return true;
      },
    },
    indexedDB: {
      databases: async () => [{ name: 'warm-cache' }, { name: 'auth-cache' }],
      deleteDatabase: (name) => {
        deletedDatabases.push(name);
        const request = {};
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    },
    navigator: {
      serviceWorker: {
        getRegistrations: async () => [
          { unregister: async () => { unregisteredWorkers.push('worker-a'); return true; } },
        ],
      },
    },
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };

  const result = await vm.runInNewContext(
    buildClearBrowserStorageScript({ preserveLocalStorageKeys: ['HAPPIER_SYNC_TUNING_JSON'] }),
    context,
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    localStorageCleared: true,
    sessionStorageCleared: true,
    deletedCaches: 2,
    deletedDatabases: 2,
    blockedDatabases: 0,
    serviceWorkersUnregistered: 1,
    errors: [],
  });
  assert.deepEqual([...localEntries.entries()], [['HAPPIER_SYNC_TUNING_JSON', '{"syncPerformanceTelemetryEnabled":true}']]);
  assert.deepEqual(deletedCaches, ['app-cache', 'image-cache']);
  assert.deepEqual(deletedDatabases, ['warm-cache', 'auth-cache']);
  assert.deepEqual(unregisteredWorkers, ['worker-a']);
  assert.equal(context.sessionStorage.cleared, true);
});

test('visible control click script can use accessible labels when text locators cannot', async () => {
  const { buildClickVisibleControlByNameScript } = await loadModule();
  const button = {
    clicked: false,
    tagName: 'BUTTON',
    textContent: '',
    innerText: '',
    getAttribute: (name) => (name === 'aria-label' ? 'Search sessions' : null),
    getBoundingClientRect: () => ({ width: 44, height: 44 }),
    click() { this.clicked = true; },
  };
  const context = {
    document: { querySelectorAll: () => [button] },
  };

  const clicked = vm.runInNewContext(buildClickVisibleControlByNameScript('Search sessions'), context);

  assert.equal(clicked, true);
  assert.equal(button.clicked, true);
});

test('installed browser probe reset drops capture setup artifacts from later snapshots', async () => {
  const { buildInstallProbeScript } = await loadModule();
  let now = 100;
  let observerCallback = null;
  class FakePerformanceObserver {
    constructor(callback) {
      observerCallback = callback;
      this.disconnected = false;
    }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const context = {
    window: {},
    location: { href: 'http://app.local/session/1' },
    performance: { now: () => now },
    requestAnimationFrame: () => 1,
    PerformanceObserver: FakePerformanceObserver,
    WebSocket: function WebSocket() {},
  };

  const installed = vm.runInNewContext(buildInstallProbeScript(), context);
  assert.equal(installed, true);
  context.window.__HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__ = () => ({
    droppedCount: 1,
    events: [{ type: 'scroll-observed', sessionId: 'redacted-session' }],
  });
  observerCallback({
    getEntries: () => [{ name: 'self', startTime: 101, duration: 2150 }],
  });
  now = 150;
  context.window.__HAPPIER_AGENT_BROWSER_PERF_AUDIT__.reset();
  observerCallback({
    getEntries: () => [
      { name: 'self', startTime: 101, duration: 2150 },
      { name: 'self', startTime: 151, duration: 75 },
    ],
  });
  now = 250;

  const snapshot = context.window.__HAPPIER_AGENT_BROWSER_PERF_AUDIT__.snapshot();

  assert.equal(snapshot.startedAtMs, 150);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.longTasks)), [{ name: 'self', startTime: 151, duration: 75 }]);
  assert.deepEqual(snapshot.transcriptViewport, {
    droppedCount: 1,
    events: [{ type: 'scroll-observed', sessionId: 'redacted-session' }],
  });
});

test('browser probe summary reports long tasks and frame gaps', async () => {
  const { summarizeBrowserProbe } = await loadModule();

  const summary = summarizeBrowserProbe({
    startedAtMs: 0,
    finishedAtMs: 1000,
    longTasks: [
      { duration: 55 },
      { duration: 12 },
      { duration: 130 },
    ],
    frameGaps: [16, 17, 35, 80],
  });

  assert.deepEqual(summary, {
    durationMs: 1000,
    longTaskCount: 2,
    longTaskTotalMs: 185,
    maxLongTaskMs: 130,
    frameGapCount: 2,
    maxFrameGapMs: 80,
  });
});

test('fallback scenario snapshot script preserves sync telemetry when the audit probe is unavailable', async () => {
  const { buildFallbackScenarioSnapshotScript } = await loadModule();
  const context = {
    window: {
      __HAPPIER_SYNC_PERFORMANCE__: {
        snapshot: () => ({
          events: [{ name: 'sync.store.sessions.apply', count: 2, totalMs: 10, maxMs: 7 }],
        }),
      },
      __HAPPIER_SYNC_RELIABILITY__: {
        snapshot: () => ({ droppedEvents: 0 }),
      },
      __HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__: () => ({ droppedCount: 0, events: [] }),
    },
    location: { href: 'http://app.local/session/session-1' },
    performance: {
      now: () => 1234,
      memory: {
        usedJSHeapSize: 10,
        totalJSHeapSize: 20,
        jsHeapSizeLimit: 30,
      },
    },
  };

  const snapshot = vm.runInNewContext(
    buildFallbackScenarioSnapshotScript('Browser perf probe snapshot was not available'),
    context,
  );

  assert.equal(snapshot.auditProbeAvailable, false);
  assert.equal(snapshot.auditProbeError, 'Browser perf probe snapshot was not available');
  assert.equal(snapshot.url, 'http://app.local/session/session-1');
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.memory)), {
    usedJSHeapSize: 10,
    totalJSHeapSize: 20,
    jsHeapSizeLimit: 30,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.syncPerformance.events)), [
    { name: 'sync.store.sessions.apply', count: 2, totalMs: 10, maxMs: 7 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.syncReliability)), { droppedEvents: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.transcriptViewport)), { droppedCount: 0, events: [] });
});

test('scenario snapshot result keeps sync telemetry for fallback snapshots', async () => {
  const { buildScenarioSnapshotResult } = await loadModule();

  const result = buildScenarioSnapshotResult({
    auditProbeAvailable: false,
    auditProbeError: 'Browser perf probe snapshot was not available',
    startedAtMs: 0,
    finishedAtMs: 10,
    longTasks: [],
    frameGaps: [],
    syncPerformance: {
      events: [
        { name: 'sync.socket.event', count: 3, totalMs: 9.1234, maxMs: 6.789 },
        { name: 'sync.store.sessions.apply', count: 1, totalMs: 12, maxMs: 12 },
      ],
    },
  });

  assert.equal(result.browserSummary, null);
  assert.equal(result.snapshotWarning, 'Browser perf probe snapshot was not available');
  assert.deepEqual(result.syncTopEvents.map((event) => event.name), [
    'sync.store.sessions.apply',
    'sync.socket.event',
  ]);
  assert.equal(result.syncTopEvents[1].totalMs, 9.123);
});

test('detects recoverable agent-browser runtime errors', async () => {
  const {
    isAgentBrowserCaptureAlreadyActiveError,
    isAgentBrowserOperationTimeoutError,
    isBrowserLocationAtTargetUrl,
  } = await loadModule();

  assert.equal(isAgentBrowserCaptureAlreadyActiveError('Profiling/tracing already active'), true);
  assert.equal(isAgentBrowserCaptureAlreadyActiveError('some other agent-browser failure'), false);
  assert.equal(isAgentBrowserOperationTimeoutError('Operation timed out. The page may still be loading'), true);
  assert.equal(
    isAgentBrowserOperationTimeoutError('Command failed: agent-browser perf open https://example.test\nOperation timed out'),
    true,
  );
  assert.equal(
    isAgentBrowserOperationTimeoutError('Command failed: agent-browser perf open https://example.test\nDNS lookup failed'),
    false,
  );
  assert.equal(isAgentBrowserOperationTimeoutError('element not visible'), false);
  assert.equal(isBrowserLocationAtTargetUrl('https://example.test/path', 'https://example.test/path'), true);
  assert.equal(isBrowserLocationAtTargetUrl('https://example.test/path', 'https://example.test/other'), false);
  assert.equal(isBrowserLocationAtTargetUrl('not a url', 'https://example.test/path'), false);
});

test('DevToolsActivePort parser extracts the debugger port and browser path', async () => {
  const { parseDevToolsActivePortFile } = await loadModule();

  assert.deepEqual(parseDevToolsActivePortFile('57481\n/devtools/browser/browser-id\n'), {
    port: 57481,
    browserPath: '/devtools/browser/browser-id',
  });
  assert.throws(() => parseDevToolsActivePortFile('not-a-port\n/devtools/browser/x\n'), /DevToolsActivePort/);
  assert.throws(() => parseDevToolsActivePortFile('57481\n'), /DevToolsActivePort/);
});

test('V8 profile CDP target selection prefers the current page URL', async () => {
  const { selectV8ProfileCdpTarget } = await loadModule();

  const targets = [
    { type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://blank' },
    { type: 'service_worker', url: 'http://app.local/sw.js', webSocketDebuggerUrl: 'ws://sw' },
    { type: 'page', url: 'http://app.local/session/other', webSocketDebuggerUrl: 'ws://other' },
    { type: 'page', url: 'http://app.local/session/target?serverId=srv_1', webSocketDebuggerUrl: 'ws://target' },
  ];

  assert.equal(
    selectV8ProfileCdpTarget(targets, 'http://app.local/session/target?serverId=srv_1')?.webSocketDebuggerUrl,
    'ws://target',
  );
  assert.equal(selectV8ProfileCdpTarget(targets, 'http://missing.local/')?.webSocketDebuggerUrl, 'ws://other');
  assert.equal(selectV8ProfileCdpTarget([{ type: 'service_worker', webSocketDebuggerUrl: 'ws://sw' }], null), null);
});

test('perf audit usage exposes valid direct-CDP V8 profiling separately from traces', async () => {
  const { buildAgentBrowserPerfAuditUsage } = await loadModule();

  const text = buildAgentBrowserPerfAuditUsage();

  assert.match(text, /--v8-profile/);
  assert.match(text, /direct-CDP V8/i);
});

test('perf audit args can skip telemetry reload for warm repeated measurements', async () => {
  const { parsePerfAuditArgs } = await loadModule();

  const args = parsePerfAuditArgs(['--skip-telemetry-reload'], {});

  assert.equal(args.skipTelemetryReload, true);
});

test('perf audit closes script-owned browser sessions by default unless warm reuse is explicit', async () => {
  const { buildAgentBrowserPerfAuditUsage, parsePerfAuditArgs, shouldCloseAgentBrowserSession } = await loadModule();

  const defaultArgs = parsePerfAuditArgs([], {});
  const warmReuseArgs = parsePerfAuditArgs(['--keep-browser-session'], {});

  assert.equal(defaultArgs.keepBrowserSession, false);
  assert.equal(warmReuseArgs.keepBrowserSession, true);
  assert.equal(shouldCloseAgentBrowserSession(defaultArgs), true);
  assert.equal(shouldCloseAgentBrowserSession(warmReuseArgs), false);
  assert.match(buildAgentBrowserPerfAuditUsage(), /--keep-browser-session/);
});

test('trace summary groups renderer, compositor, and GPU thread work', async () => {
  const { summarizeChromeTrace } = await loadModule();

  const summary = summarizeChromeTrace({
    traceEvents: [
      { ph: 'M', name: 'thread_name', pid: 1, tid: 11, args: { name: 'CrRendererMain' } },
      { ph: 'M', name: 'thread_name', pid: 1, tid: 12, args: { name: 'Compositor' } },
      { ph: 'M', name: 'thread_name', pid: 2, tid: 21, args: { name: 'VizCompositorThread' } },
      { ph: 'X', name: 'v8.callFunction', pid: 1, tid: 11, dur: 2000 },
      { ph: 'X', name: 'Layout', pid: 1, tid: 11, dur: 1000 },
      { ph: 'X', name: 'Graphics.Pipeline', pid: 1, tid: 12, dur: 3000 },
      { ph: 'X', name: 'SwapBuffers', pid: 2, tid: 21, dur: 4000 },
    ],
  });

  assert.equal(summary.totalCompleteEventMs, 10);
  assert.deepEqual(summary.threadGroups, {
    rendererMain: 3,
    compositor: 3,
    gpuViz: 4,
    other: 0,
  });
  assert.deepEqual(summary.topEvents.slice(0, 2), [
    { name: 'SwapBuffers', totalMs: 4, count: 1, maxMs: 4 },
    { name: 'Graphics.Pipeline', totalMs: 3, count: 1, maxMs: 3 },
  ]);
});

test('trace file summary streams traceEvents without loading the full file as one string', async () => {
  const { summarizeChromeTraceFile } = await loadModule();
  const dir = await mkdtemp(join(tmpdir(), 'happier-trace-summary-'));
  const tracePath = join(dir, 'trace.json');
  try {
    await writeFile(tracePath, JSON.stringify({
      traceEvents: [
        { ph: 'X', name: 'Layout', pid: 1, tid: 11, dur: 1500 },
        { ph: 'M', name: 'thread_name', pid: 1, tid: 11, args: { name: 'CrRendererMain' } },
        { ph: 'X', name: 'SwapBuffers', pid: 2, tid: 21, dur: 2500 },
        { ph: 'M', name: 'thread_name', pid: 2, tid: 21, args: { name: 'VizCompositorThread' } },
      ],
      metadata: { ignored: true },
    }), 'utf8');

    const summary = await summarizeChromeTraceFile(tracePath, { highWaterMark: 17 });

    assert.equal(summary.totalCompleteEventMs, 4);
    assert.deepEqual(summary.threadGroups, {
      rendererMain: 1.5,
      compositor: 0,
      gpuViz: 2.5,
      other: 0,
    });
    assert.deepEqual(summary.topEvents.slice(0, 2), [
      { name: 'SwapBuffers', totalMs: 2.5, count: 1, maxMs: 2.5 },
      { name: 'Layout', totalMs: 1.5, count: 1, maxMs: 1.5 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
