export const INJECTED_LIFECYCLE_BOOTSTRAP = `
  var maxBatchBytes = 256 * 1024;
  var previousRuntime = window.__happierBrowserRuntime;
  if (previousRuntime && typeof previousRuntime.teardown === 'function') {
    previousRuntime.teardown();
  } else if (window.__happierBrowserDiagnostics && typeof window.__happierBrowserDiagnostics.teardown === 'function') {
    window.__happierBrowserDiagnostics.teardown();
  }
  var runtime = {
    runtimeId: config.browserSessionId + ':' + config.viewId + ':' + config.navigationGeneration,
    browserSessionId: config.browserSessionId,
    viewId: config.viewId,
    navigationGeneration: config.navigationGeneration,
    modules: {},
    teardown: function () {
      Object.keys(runtime.modules).forEach(function (moduleName) {
        var module = runtime.modules[moduleName];
        if (module && typeof module.teardown === 'function') {
          module.teardown();
        }
      });
      runtime.modules = {};
      if (window.__happierBrowserRuntime === runtime) {
        window.__happierBrowserRuntime = undefined;
      }
    }
  };
  window.__happierBrowserRuntime = runtime;

  var restored = false;
  var originalConsole = {};
  var eventSeq = 0;

  function now() {
    return Date.now();
  }

  function eventId(kind) {
    eventSeq += 1;
    return config.collector.collectorId + ':' + config.navigationGeneration + ':' + kind + ':' + eventSeq;
  }

  function baseEvent(family, kind, data) {
    return {
      v: 1,
      eventId: eventId(kind),
      browserSessionId: config.browserSessionId,
      viewId: config.viewId,
      navigationGeneration: config.navigationGeneration,
      capturedAtMs: now(),
      family: family,
      kind: kind,
      fidelity: 'injectedPage',
      trusted: false,
      collector: config.collector,
      data: data || {},
      redaction: { level: 'metadataOnly', truncated: false }
    };
  }

  function postEnvelope(envelope) {
    var serialized = JSON.stringify(envelope);
    if (config.desktopIpcDelivery && window.ipc && typeof window.ipc.postMessage === 'function') {
      window.ipc.postMessage(serialized);
    } else if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(serialized);
    } else if (config.webPostMessageTargetOrigin && window.parent && typeof window.parent.postMessage === 'function') {
      window.parent.postMessage(serialized, config.webPostMessageTargetOrigin);
    }
  }

  function postEvents(events) {
    if (!events.length) return;
    var batch = {
      v: 1,
      kind: 'browser.diagnostics.events',
      browserSessionId: config.browserSessionId,
      viewId: config.viewId,
      navigationGeneration: config.navigationGeneration,
      collector: config.collector,
      events: events
    };
    var serialized = JSON.stringify(batch);
    if (serialized.length > maxBatchBytes) {
      serialized = JSON.stringify(Object.assign({}, batch, {
        events: [baseEvent('pageInfo', 'collector.degraded', { reasonCode: 'batch_truncated' })]
      }));
    }
    postEnvelope(JSON.parse(serialized));
  }

  function preview(value) {
    try {
      if (typeof value === 'string') return value.slice(0, 1024);
      if (value == null) return String(value);
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (value instanceof Error) return (value.name || 'Error') + ': ' + (value.message || '');
      return Object.prototype.toString.call(value);
    } catch (_error) {
      return '[unavailable]';
    }
  }

`;

export const INJECTED_LIFECYCLE_COMMANDS = `
  function handleCommandMessage(event) {
    var message = event && event.data;
    if (typeof message === 'string') {
      try {
        message = JSON.parse(message);
      } catch (_error) {
        return;
      }
    }
    handleEvalCommand(message);
    handleGetPropertiesCommand(message);
    handleReleaseCommand(message);
    handleElementPickerCommand(message);
    handleAutomationCommand(message);
  }

  function handleLoad() {
    emitPageInfo();
    emitResourceSnapshot();
    emitElementsSnapshot();
    emitStorageAvailability();
    emitStorageKeyInventory();
    emitDomSnapshot();
    emitPerformanceVitals();
  }

`;

export const INJECTED_LIFECYCLE_PAGE_RUNTIME = `
  function emitPageInfo() {
    postEvents([baseEvent('pageInfo', 'pageInfo.snapshot', {
      url: sanitizeUrl(window.location.href || ''),
      titleAvailable: Boolean(document.title || ''),
      readyState: String(document.readyState || '')
    })]);
  }

  function probeCapability(probe) {
    try {
      return Boolean(probe());
    } catch (_error) {
      return false;
    }
  }

  function emitPageCapabilities() {
    var capabilities = {
      serviceWorker: probeCapability(function () { return 'serviceWorker' in navigator; }),
      webgl: probeCapability(function () {
        var canvas = document.createElement('canvas');
        return Boolean(canvas.getContext && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
      }),
      webrtc: probeCapability(function () { return typeof window.RTCPeerConnection === 'function'; }),
      clipboard: probeCapability(function () { return Boolean(navigator.clipboard); }),
      webShare: probeCapability(function () { return typeof navigator.share === 'function'; }),
      indexedDbApi: probeCapability(function () { return 'indexedDB' in window; }),
      notifications: probeCapability(function () { return typeof window.Notification === 'function'; }),
      geolocation: probeCapability(function () { return Boolean(navigator.geolocation); }),
      mediaDevices: probeCapability(function () { return Boolean(navigator.mediaDevices); }),
      webAuthn: probeCapability(function () { return typeof window.PublicKeyCredential === 'function'; }),
      storage: probeCapability(function () { return Boolean(navigator.storage); }),
      pushManager: probeCapability(function () { return typeof window.PushManager === 'function'; }),
      webgpu: probeCapability(function () { return Boolean(navigator.gpu); })
    };
    postEvents([baseEvent('pageInfo', 'pageInfo.capabilities', capabilities)]);
  }

  var performanceVitals = {
    lcpMs: undefined,
    clsScore: undefined,
    inpMs: undefined,
    fcpMs: undefined,
    longTaskCount: 0,
    longTaskTotalMs: 0
  };
  var performanceObservers = [];

  function numericVitalsPayload() {
    var payload = {};
    if (typeof performanceVitals.lcpMs === 'number') payload.lcpMs = Math.round(performanceVitals.lcpMs);
    if (typeof performanceVitals.clsScore === 'number') payload.clsScore = Number(performanceVitals.clsScore.toFixed(4));
    if (typeof performanceVitals.inpMs === 'number') payload.inpMs = Math.round(performanceVitals.inpMs);
    if (typeof performanceVitals.fcpMs === 'number') payload.fcpMs = Math.round(performanceVitals.fcpMs);
    if (performanceVitals.longTaskCount > 0) {
      payload.longTaskCount = performanceVitals.longTaskCount;
      payload.longTaskTotalMs = Math.round(performanceVitals.longTaskTotalMs);
    }
    try {
      var navigationEntries = (performance.getEntriesByType && performance.getEntriesByType('navigation')) || [];
      var navigation = navigationEntries[0];
      if (navigation) {
        if (typeof navigation.responseEnd === 'number') payload.navResponseEndMs = Math.round(navigation.responseEnd);
        if (typeof navigation.domContentLoadedEventEnd === 'number') payload.navDomContentLoadedMs = Math.round(navigation.domContentLoadedEventEnd);
        if (typeof navigation.loadEventEnd === 'number') payload.navLoadEventEndMs = Math.round(navigation.loadEventEnd);
      }
    } catch (_error) {
      // Navigation timing is best-effort numeric metadata only.
    }
    return payload;
  }

  function emitPerformanceVitals() {
    var payload = numericVitalsPayload();
    if (Object.keys(payload).length === 0) return;
    postEvents([baseEvent('performance', 'performance.vitals', payload)]);
  }

  function observePerformance(type, callback) {
    var PerformanceObserverCtor = window.PerformanceObserver;
    if (typeof PerformanceObserverCtor !== 'function') return;
    try {
      var observer = new PerformanceObserverCtor(function (list) {
        try {
          callback(list.getEntries());
        } catch (_error) {
          // Ignore page-owned performance entry shapes we cannot read.
        }
      });
      observer.observe({ type: type, buffered: true });
      performanceObservers.push(observer);
    } catch (_error) {
      // Some entry types are unsupported; skip them quietly.
    }
  }

  function installPerformanceObservers() {
    observePerformance('largest-contentful-paint', function (entries) {
      var last = entries[entries.length - 1];
      if (last && typeof last.startTime === 'number') {
        performanceVitals.lcpMs = last.startTime;
        emitPerformanceVitals();
      }
    });
    observePerformance('layout-shift', function (entries) {
      var changed = false;
      entries.forEach(function (entry) {
        if (entry && entry.hadRecentInput) return;
        if (entry && typeof entry.value === 'number') {
          performanceVitals.clsScore = (performanceVitals.clsScore || 0) + entry.value;
          changed = true;
        }
      });
      if (changed) emitPerformanceVitals();
    });
    observePerformance('event', function (entries) {
      var maxDuration = performanceVitals.inpMs || 0;
      entries.forEach(function (entry) {
        if (entry && typeof entry.duration === 'number' && entry.duration > maxDuration) {
          maxDuration = entry.duration;
        }
      });
      if (maxDuration > (performanceVitals.inpMs || 0)) {
        performanceVitals.inpMs = maxDuration;
        emitPerformanceVitals();
      }
    });
    observePerformance('paint', function (entries) {
      entries.forEach(function (entry) {
        if (entry && entry.name === 'first-contentful-paint' && typeof entry.startTime === 'number') {
          performanceVitals.fcpMs = entry.startTime;
        }
      });
      emitPerformanceVitals();
    });
    observePerformance('longtask', function (entries) {
      entries.forEach(function (entry) {
        if (entry && typeof entry.duration === 'number') {
          performanceVitals.longTaskCount += 1;
          performanceVitals.longTaskTotalMs += entry.duration;
        }
      });
      emitPerformanceVitals();
    });
  }

  function teardownPerformanceObservers() {
    performanceObservers.forEach(function (observer) {
      try {
        observer.disconnect();
      } catch (_error) {
        // Best-effort disconnect on teardown.
      }
    });
    performanceObservers = [];
  }

  function emitResourceSnapshot() {
    var entries = [];
    try {
      entries = (performance.getEntriesByType && performance.getEntriesByType('resource') || [])
        .slice(-50)
        .map(function (entry) {
          return {
            name: sanitizeUrl(entry.name || '').slice(0, 2048),
            initiatorType: String(entry.initiatorType || ''),
            durationMs: Math.round(Number(entry.duration || 0))
          };
        });
    } catch (_error) {
      entries = [];
    }
    postEvents([baseEvent('resources', 'resources.snapshot', { entries: entries })]);
  }

  function unavailableEvent(family, reasonCode) {
    var event = baseEvent(family, 'diagnostics.unavailable', {});
    event.redaction.level = 'unavailable';
    event.unavailableReason = reasonCode;
    return event;
  }

  function emitElementsSnapshot() {
    var hasDocumentRoot = false;
    try {
      hasDocumentRoot = Boolean(document && document.documentElement);
    } catch (_error) {
      hasDocumentRoot = false;
    }
    postEvents([
      hasDocumentRoot
        ? baseEvent('elements', 'elements.snapshot', {})
        : unavailableEvent('elements', 'collector_unavailable')
    ]);
  }

`;

export const INJECTED_LIFECYCLE_FOOTER = `
  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleError);
  window.addEventListener('message', handleCommandMessage);
  window.addEventListener('load', handleLoad);

  var automationModule = {
    teardown: function () {
      automationTimers.forEach(function (timer) {
        clearTimeout(timer);
      });
      automationTimers = [];
    },
    execute: function (message) {
      handleAutomationCommand(message);
    }
  };
  runtime.modules.automation = automationModule;

  var diagnosticsModule = {
    teardown: function () {
      if (restored) return;
      restored = true;
      teardownElementPicker();
      Object.keys(originalConsole).forEach(function (level) {
        console[level] = originalConsole[level];
      });
      teardownPerformanceObservers();
      if (originalFetch) {
        window.fetch = originalFetch;
      }
      if (originalXMLHttpRequest) {
        window.XMLHttpRequest = originalXMLHttpRequest;
      }
      if (originalWebSocket) {
        window.WebSocket = originalWebSocket;
      }
      if (originalEventSource) {
        window.EventSource = originalEventSource;
      }
      if (originalSendBeacon && beaconNavigator) {
        beaconNavigator.sendBeacon = originalSendBeacon;
      }
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleError);
      window.removeEventListener('message', handleCommandMessage);
      window.removeEventListener('load', handleLoad);
      if (window.__happierBrowserDiagnostics === diagnosticsModule) {
        window.__happierBrowserDiagnostics = undefined;
      }
    },
    evaluate: function (message) {
      handleEvalCommand(message);
    },
    getProperties: function (message) {
      handleGetPropertiesCommand(message);
    },
    releaseObjectGroup: function (message) {
      handleReleaseCommand(message);
    },
    elementPicker: function (message) {
      handleElementPickerCommand(message);
    }
  };
  runtime.modules.diagnostics = diagnosticsModule;
  window.__happierBrowserDiagnostics = diagnosticsModule;

  installPerformanceObservers();

  emitPageInfo();
  emitElementsSnapshot();
  emitStorageAvailability();
  emitStorageKeyInventory();
  emitDomSnapshot();
  emitPageCapabilities();
`;
