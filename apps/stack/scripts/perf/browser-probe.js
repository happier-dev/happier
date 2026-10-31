// PERF10 react-hook v3's PerformedWork + alternate identity rule. Aggregate in
// the browser rather than retaining every fiber/commit or any props/state data.
(() => {
  if (globalThis.__happierPerfProbe) return;
  const counts = globalThis.__HAPPIER_PERF_CAPTURE_MODE__ !== 'timing';
  const diagnostics = globalThis.__HAPPIER_PERF_DIAGNOSTICS__ === true;
  const supportedEntryTypes = typeof PerformanceObserver === 'undefined' ? [] : PerformanceObserver.supportedEntryTypes ?? [];
  const tags = new Set([0, 1, 9, 11, 14, 15]);
  const current = new WeakMap();
  const name = type => typeof type === 'function' ? type.displayName || type.name || 'Anonymous'
    : type && typeof type === 'object' ? type.displayName || name(type.render || type.type) : 'Anonymous';
  const empty = () => ({ commits: 0, renders: 0, components: Object.create(null), hookMs: 0, longTasks: [],
    ...(diagnostics ? { diagnostics: { supportedEntryTypes: [...supportedEntryTypes], loafs: [], reactMeasures: [],
      storeNotifications: [], storeNotificationsAvailable: false, socketEvents: [], socketEventsAvailable: false,
      timeOrigin: performance.timeOrigin ?? null } } : {}) });
  let data = empty();
  let recording = true;
  let unsubscribeStore, unsubscribeScopedSetup, setupDeliveryFailed = false;
  const attachTelemetry = () => {
    if (!diagnostics || !recording) return;
    const telemetry = globalThis.__HAPPIER_SYNC_PERFORMANCE__;
    if (!unsubscribeScopedSetup && typeof telemetry?.subscribeScopedRpcSetup === 'function' && typeof globalThis.__happierPerfTelemetry === 'function') {
      unsubscribeScopedSetup = telemetry.subscribeScopedRpcSetup(event => {
        const { phase, connectionId, atMs, origin, engineId } = event;
        try {
          globalThis.__happierPerfTelemetry(JSON.stringify({ scopedRpcSetup: {
            phase, connectionId, timeOrigin: performance.timeOrigin, atMs: performance.timeOrigin + atMs, origin,
            ...(typeof engineId === 'string' ? { engineId } : {}),
          } }));
        } catch { setupDeliveryFailed = true; }
      });
    }
    if (!unsubscribeStore && typeof telemetry?.subscribeStoreNotifications === 'function') unsubscribeStore = telemetry.subscribeStoreNotifications(event => {
      // The producer uses performance.now(); capture windows use epoch time.
      if (recording) data.diagnostics.storeNotifications.push({ atMs: performance.timeOrigin + event.atMs, changedKeys: [...event.changedKeys] });
    });
  };
  if (diagnostics) {
    globalThis.addEventListener?.('happier:sync-performance-ready', attachTelemetry);
    attachTelemetry();
  }
  // Use the emitter's existing native hook path: production removes console.info.
  // One binding delivery per emitted event; do not also collect console echoes.
  const previousLoggingHook = globalThis.nativeLoggingHook;
  if (counts && typeof globalThis.__happierPerfTelemetry === 'function') globalThis.nativeLoggingHook = function (message, level) {
    if (typeof message === 'string' && message.startsWith('[sync-perf] ')) globalThis.__happierPerfTelemetry(message.slice('[sync-perf] '.length));
    else previousLoggingHook?.(message, level);
  };
  const previous = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const hook = previous ?? { supportsFiber: true, renderers: new Map(),
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
    checkDCE() {}, on() {}, off() {}, emit() {}, sub() { return () => {}; } };
  const commit = hook.onCommitFiberRoot;
  if (counts) hook.onCommitFiberRoot = function (...args) {
    commit?.apply(this, args);
    const started = performance.now();
    const root = args[1];
    const stack = [root.current], names = new Set();
    data.commits++;
    while (stack.length) {
      const fiber = stack.pop();
      if (tags.has(fiber.tag) && current.get(fiber) !== true && (!fiber.alternate || (fiber.flags & 1) === 1)) {
        const component = name(fiber.type);
        const row = data.components[component] ??= { renders: 0, commits: 0 };
        row.renders++;
        data.renders++;
        names.add(component);
      }
      current.set(fiber, true);
      if (fiber.alternate) current.set(fiber.alternate, false);
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    for (const component of names) data.components[component].commits++;
    data.hookMs += performance.now() - started;
  };
  if (counts && !previous) Object.defineProperty(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true });
  const observers = [];
  const observe = (type, consume) => {
    if (!supportedEntryTypes.includes(type)) return;
    const observer = new PerformanceObserver(list => { if (recording) consume(list.getEntries()); });
    observer.observe({ type, buffered: false });
    observers.push({ observer, type, consume });
  };
  observe('longtask', entries => {
    for (const task of entries) data.longTasks.push({ atMs: task.startTime, durationMs: task.duration });
  });
  const sourceUrl = raw => {
    if (!raw) return '';
    try {
      const url = new URL(raw, globalThis.location?.href ?? 'http://relative.invalid');
      if (!['http:', 'https:', 'file:'].includes(url.protocol)) return '[non-url]';
      return (url.origin === 'http://relative.invalid' || url.protocol === 'file:' ? '' : url.origin) + url.pathname;
    } catch { return '[non-url]'; }
  };
  const invoker = value => typeof value === 'string'
    ? value.replace(/(?:https?|file):\/\/[^\s)]+/g, sourceUrl) : '';
  if (diagnostics) {
    observe('long-animation-frame', entries => {
      for (const entry of entries) data.diagnostics.loafs.push({
        startTime: entry.startTime, duration: entry.duration, blockingDuration: entry.blockingDuration,
        renderStart: entry.renderStart, styleAndLayoutStart: entry.styleAndLayoutStart,
        firstUIEventTimestamp: entry.firstUIEventTimestamp,
        scripts: Array.from(entry.scripts ?? [], script => ({ startTime: script.startTime, duration: script.duration,
          forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration, invoker: invoker(script.invoker),
          invokerType: script.invokerType, sourceFunctionName: script.sourceFunctionName,
          sourceURL: sourceUrl(script.sourceURL), sourceCharPosition: script.sourceCharPosition })),
      });
    });
    // Register before app startup: its React cleanup clears U+200B measures
    // after observer delivery. Keep scalar track metadata, never prop diffs.
    observe('measure', entries => {
      for (const entry of entries) {
        const devtools = entry.detail?.devtools;
        const track = typeof devtools?.track === 'string' ? devtools.track : null;
        const trackGroup = typeof devtools?.trackGroup === 'string' ? devtools.trackGroup : null;
        if (!entry.name.startsWith('\u200b') && !track && !trackGroup) continue;
        data.diagnostics.reactMeasures.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration, track, trackGroup });
      }
    });
  }
  const finishObservations = () => {
    if (!recording) return;
    for (const { observer, consume } of observers) {
      consume(observer.takeRecords?.() ?? []);
      observer.disconnect();
    }
    recording = false;
    unsubscribeStore?.();
    unsubscribeStore = undefined;
    unsubscribeScopedSetup?.();
    unsubscribeScopedSetup = undefined;
    if (diagnostics) data.diagnostics.storeNotificationsAvailable = globalThis.__HAPPIER_SYNC_PERFORMANCE__?.storeNotificationsAvailable?.() ?? false;
    if (diagnostics) data.diagnostics.scopedRpcSetupAvailable = !setupDeliveryFailed
      && globalThis.__HAPPIER_SYNC_PERFORMANCE__?.scopedRpcSetupAvailable?.() === true
      && typeof globalThis.__happierPerfTelemetry === 'function';
  };
  const storageKey = 'HAPPIER_SYNC_TUNING_JSON';
  const savedKey = '__HAPPIER_PERF_TUNING_ORIGINAL__';
  let original;
  try {
    if (sessionStorage.getItem(savedKey) === null) sessionStorage.setItem(savedKey, JSON.stringify(localStorage.getItem(storageKey)));
    original = JSON.parse(sessionStorage.getItem(savedKey));
    localStorage.setItem(storageKey, JSON.stringify({ ...JSON.parse(original || '{}'), syncPerformanceTelemetryEnabled: counts }));
  } catch { /* Availability is reported by the collector, never inferred. */ }
  globalThis.__happierPerfProbe = {
    reset() {
      for (const { observer, type } of observers) { observer.takeRecords?.(); if (!recording) observer.observe({ type, buffered: false }); }
      data = empty(); recording = true; setupDeliveryFailed = false; attachTelemetry(); globalThis.__HAPPIER_SYNC_PERFORMANCE__?.reset();
    },
    collect() { finishObservations(); globalThis.__HAPPIER_SYNC_PERFORMANCE__?.markScenario?.('perf-capture-end'); return { ...data, timeOrigin: performance.timeOrigin,
      renderers: counts ? [...hook.renderers.values()].map(renderer => ({ version: renderer.version, package: renderer.rendererPackageName })) : [],
      instrumentation: { fiberHook: counts || Boolean(previous), storeTelemetry: globalThis.__HAPPIER_SYNC_PERFORMANCE__?.isEnabled?.() ?? null },
      telemetryAvailable: Boolean(globalThis.__HAPPIER_SYNC_PERFORMANCE__),
      telemetry: globalThis.__HAPPIER_SYNC_PERFORMANCE__?.flush() }; },
    stop() {
      finishObservations();
      if (diagnostics) globalThis.removeEventListener?.('happier:sync-performance-ready', attachTelemetry);
      if (counts) hook.onCommitFiberRoot = commit;
      if (counts && !previous) delete globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (counts && typeof globalThis.__happierPerfTelemetry === 'function') {
        if (previousLoggingHook === undefined) delete globalThis.nativeLoggingHook;
        else globalThis.nativeLoggingHook = previousLoggingHook;
      }
      try { if (original === null) localStorage.removeItem(storageKey); else if (original !== undefined) localStorage.setItem(storageKey, original); sessionStorage.removeItem(savedKey); } catch {}
      delete globalThis.__happierPerfProbe;
    },
  };
})();
