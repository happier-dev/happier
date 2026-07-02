import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(plan.scenarios.every((scenario) => scenario.durationMs === 1234), true);
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
});

test('perf audit closes script-owned browser sessions by default unless warm reuse is explicit', async () => {
  const { shouldCloseAgentBrowserSession } = await loadModule();

  assert.equal(shouldCloseAgentBrowserSession({}), true);
  assert.equal(shouldCloseAgentBrowserSession({ keepBrowserSession: false }), true);
  assert.equal(shouldCloseAgentBrowserSession({ keepBrowserSession: true }), false);
});

test('mobile-hidden plan isolates the keep-mounted mobile session list scenario', async () => {
  const { buildDefaultPerfAuditPlan, selectPlanScenarios } = await loadModule();

  const plan = selectPlanScenarios(buildDefaultPerfAuditPlan(), 'mobile-hidden');

  assert.deepEqual(plan.scenarios.map((scenario) => scenario.id), ['mobile.sessionList.hiddenMounted']);
});

test('plan selection accepts exact scenario ids for targeted repro runs', async () => {
  const { buildDefaultPerfAuditPlan, selectPlanScenarios } = await loadModule();

  const plan = selectPlanScenarios(buildDefaultPerfAuditPlan(), 'desktop.newSession.composerTyping');

  assert.deepEqual(plan.scenarios.map((scenario) => scenario.id), ['desktop.newSession.composerTyping']);
});

test('scenario execution phases install probes after navigation setup', async () => {
  const { resolveScenarioExecutionPhases } = await loadModule();

  assert.deepEqual(resolveScenarioExecutionPhases('sessionListScroll'), { prepare: 'root', measure: 'scroll' });
  assert.deepEqual(resolveScenarioExecutionPhases('sessionViewIdle'), { prepare: 'targetSession', measure: 'idle' });
  assert.deepEqual(resolveScenarioExecutionPhases('mobileHiddenSessionList'), { prepare: 'mobileTargetSession', measure: 'idle' });
});

test('mobile target-session preparation preserves the mobile viewport while opening root', async () => {
  const { resolvePreparationOpenRootViewport } = await loadModule();

  assert.equal(resolvePreparationOpenRootViewport({ prepare: 'targetSession', scenarioViewport: 'desktop' }), 'desktop');
  assert.equal(resolvePreparationOpenRootViewport({ prepare: 'mobileTargetSession', scenarioViewport: 'mobile' }), 'mobile');
});

test('scroll kickoff script starts scrolling without awaiting the whole measurement window', async () => {
  const { buildScrollKickoffScript } = await loadModule();
  const scrollTarget = {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 100,
    clientWidth: 200,
    getAttribute: () => null,
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
    requestAnimationFrame: (callback) => {
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

test('session-list scroll scenario fails fast when kickoff targets another scroller', async () => {
  const { validateScrollKickoffResult } = await loadModule();

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

test('detects recoverable agent-browser runtime errors', async () => {
  const { isAgentBrowserCaptureAlreadyActiveError, isAgentBrowserOperationTimeoutError } = await loadModule();

  assert.equal(isAgentBrowserCaptureAlreadyActiveError('Profiling/tracing already active'), true);
  assert.equal(isAgentBrowserCaptureAlreadyActiveError('some other agent-browser failure'), false);
  assert.equal(isAgentBrowserOperationTimeoutError('Operation timed out. The page may still be loading'), true);
  assert.equal(isAgentBrowserOperationTimeoutError('element not visible'), false);
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
