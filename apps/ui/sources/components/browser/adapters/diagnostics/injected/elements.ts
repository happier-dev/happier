export const INJECTED_ELEMENTS_RUNTIME = `
  function backendNodeRefFor(node) {
    if (!pickerNodeRefs || !node) return undefined;
    var existing = pickerNodeRefs.get(node);
    if (existing) return existing;
    pickerSeq += 1;
    var next = config.viewId + ':' + config.navigationGeneration + ':node:' + pickerSeq;
    pickerNodeRefs.set(node, next);
    return next;
  }

  function selectorPathFor(node) {
    var parts = [];
    var current = node;
    while (current && current.nodeType === 1 && parts.length < 8) {
      var tagName = String(current.tagName || '').toLowerCase();
      if (!tagName) break;
      var index = 1;
      var sibling = current;
      while ((sibling = sibling.previousElementSibling)) {
        if (String(sibling.tagName || '').toLowerCase() === tagName) index += 1;
      }
      parts.unshift(tagName + ':nth-of-type(' + index + ')');
      if (tagName === 'html') break;
      current = current.parentElement;
    }
    return parts.join(' > ').slice(0, 2048);
  }

  function accessibleNameFor(node) {
    try {
      var raw = node.getAttribute('aria-label')
        || node.getAttribute('alt')
        || node.getAttribute('title')
        || node.textContent
        || '';
      return String(raw).replace(/\\s+/g, ' ').trim().slice(0, 512);
    } catch (_error) {
      return '';
    }
  }

  function rectFor(node) {
    try {
      var rect = node.getBoundingClientRect();
      return {
        x: Number(rect.x || rect.left || 0),
        y: Number(rect.y || rect.top || 0),
        width: Math.max(0, Number(rect.width || 0)),
        height: Math.max(0, Number(rect.height || 0))
      };
    } catch (_error) {
      return undefined;
    }
  }

  function emitPickerState(request, state, selected) {
    var event = baseEvent('elements', 'elements.pickerState', {
      pickerRequestId: request.pickerRequestId,
      state: state,
      ...(selected && selected.backendNodeRef ? { backendNodeRef: selected.backendNodeRef } : {}),
      ...(selected && selected.selectorPath ? { selectorPath: selected.selectorPath } : {}),
      rectAvailable: Boolean(selected && selected.rect),
      accessibleNameAvailable: Boolean(selected && selected.accessibleName)
    });
    event.redaction.level = 'metadataOnly';
    postEvents([event]);
  }

  function postElementPickerResult(request, status, selected, errorCode) {
    postEnvelope({
      v: 1,
      kind: 'browser.diagnostics.elementPickerResult',
      browserSessionId: config.browserSessionId,
      viewId: config.viewId,
      navigationGeneration: config.navigationGeneration,
      collector: config.collector,
      result: {
        v: 1,
        pickerRequestId: request.pickerRequestId,
        viewId: config.viewId,
        navigationGeneration: config.navigationGeneration,
        tier: 'injectedPage',
        status: status,
        audited: true,
        ...(selected && selected.backendNodeRef ? { backendNodeRef: selected.backendNodeRef } : {}),
        ...(selected && selected.selectorPath ? { selectorPath: selected.selectorPath } : {}),
        ...(selected && selected.rect ? { rect: selected.rect } : {}),
        ...(selected && selected.accessibleName ? { accessibleName: selected.accessibleName } : {}),
        ...(selected && selected.componentName ? { componentName: selected.componentName } : {}),
        ...(selected && selected.sourceLocation ? { sourceLocation: selected.sourceLocation } : {}),
        ...(errorCode ? { errorCode: errorCode } : {})
      }
    });
  }

  function clearPickerHighlight() {
    if (!highlightedPickerNode) return;
    try {
      highlightedPickerNode.style.outline = highlightedPickerOutline;
    } catch (_error) {
      // Ignore highlight cleanup failures in page-owned DOM.
    }
    highlightedPickerNode = null;
    highlightedPickerOutline = '';
  }

  function setPickerHighlight(node) {
    if (node === highlightedPickerNode) return;
    clearPickerHighlight();
    highlightedPickerNode = node;
    try {
      highlightedPickerOutline = node.style.outline || '';
      node.style.outline = '2px solid Highlight';
    } catch (_error) {
      highlightedPickerNode = null;
      highlightedPickerOutline = '';
    }
  }

  function teardownElementPicker() {
    if (!activePicker) return;
    window.removeEventListener('mouseover', activePicker.handleMouseOver, true);
    window.removeEventListener('click', activePicker.handleClick, true);
    window.removeEventListener('keydown', activePicker.handleKeyDown, true);
    clearPickerHighlight();
    activePicker = null;
  }

  // UB-7. A selector path tells an agent where the node is on screen; the component that rendered
  // it and the file it came from tell the agent where to make the edit. Both are read from the
  // React fiber the host framework already hangs off the DOM node — nothing is injected into the
  // page to obtain them, and both are simply absent when the page is not a dev-build React tree.
  function reactFiberFor(node) {
    try {
      var keys = Object.keys(node);
      for (var index = 0; index < keys.length; index += 1) {
        var key = keys[index];
        if (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0) {
          return node[key];
        }
      }
    } catch (_error) {
      // Proxied or frozen nodes: no component context available.
    }
    return null;
  }

  function componentNameForFiber(fiber) {
    var type = fiber && fiber.type;
    if (typeof type === 'function') {
      return String(type.displayName || type.name || '').slice(0, 128);
    }
    if (type && typeof type === 'object') {
      var render = type.render;
      var name = type.displayName
        || (render && (render.displayName || render.name))
        || '';
      return String(name).slice(0, 128);
    }
    return '';
  }

  function sourceLocationForFiber(fiber) {
    var source = fiber && (fiber._debugSource || (fiber._debugOwner && fiber._debugOwner._debugSource));
    if (!source || typeof source.fileName !== 'string' || source.fileName.length < 1) return undefined;
    var line = Number(source.lineNumber || 0);
    var column = Number(source.columnNumber || 0);
    return {
      file: source.fileName.slice(0, 1024),
      ...(line > 0 ? { line: line } : {}),
      ...(column > 0 ? { column: column } : {})
    };
  }

  function componentContextFor(node) {
    var fiber = reactFiberFor(node);
    var depth = 0;
    while (fiber && depth < 12) {
      var componentName = componentNameForFiber(fiber);
      if (componentName) {
        var sourceLocation = sourceLocationForFiber(fiber);
        return {
          componentName: componentName,
          ...(sourceLocation ? { sourceLocation: sourceLocation } : {})
        };
      }
      fiber = fiber.return;
      depth += 1;
    }
    return {};
  }

  function selectedElementPayload(node) {
    var accessibleName = accessibleNameFor(node);
    var componentContext = componentContextFor(node);
    return {
      backendNodeRef: backendNodeRefFor(node),
      selectorPath: selectorPathFor(node),
      rect: rectFor(node),
      ...(accessibleName ? { accessibleName: accessibleName } : {}),
      ...componentContext
    };
  }

  function startElementPicker(request) {
    teardownElementPicker();
    if (request.diagnosticsInteractionEnabled !== true) {
      postElementPickerResult(request, 'blocked', undefined, 'collector_denied');
      return;
    }

    function handleMouseOver(event) {
      if (!event || !event.target || event.target === document.documentElement) return;
      setPickerHighlight(event.target);
    }

    function handleClick(event) {
      if (!event || !event.target) return;
      event.preventDefault();
      event.stopPropagation();
      var selected = selectedElementPayload(event.target);
      emitPickerState(request, 'selected', selected);
      postElementPickerResult(request, 'selected', selected);
      teardownElementPicker();
    }

    function handleKeyDown(event) {
      if (!event || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      emitPickerState(request, 'cancelled');
      postElementPickerResult(request, 'cancelled');
      teardownElementPicker();
    }

    activePicker = {
      request: request,
      handleMouseOver: handleMouseOver,
      handleClick: handleClick,
      handleKeyDown: handleKeyDown
    };
    window.addEventListener('mouseover', handleMouseOver, true);
    window.addEventListener('click', handleClick, true);
    window.addEventListener('keydown', handleKeyDown, true);
    emitPickerState(request, 'active');
  }

  function handleElementPickerCommand(message) {
    if (!isCurrentElementPickerCommand(message)) return;
    var request = message.request;
    if (evalSuppressed) {
      postElementPickerResult(request, 'collectorDegraded', undefined, 'collector_degraded');
      return;
    }
    if (request.action === 'cancel') {
      teardownElementPicker();
      emitPickerState(request, 'cancelled');
      postElementPickerResult(request, 'cancelled');
      return;
    }
    startElementPicker(request);
  }

  var automationTimers = [];
  var automationDialogLog = null;

  // UB-5. A page modal blocks the page thread, so an automation action that trips one used to hang
  // until the host timeout with no explanation. For the duration of one command we replace the
  // three dialog entry points with auto-dismissing stubs and count what they caught; the summary
  // rides out on the action result. Metadata only — dialog text is page content and never leaves.
  // The originals are restored as soon as the command returns, so a page-driven dialog outside an
  // automation action still behaves normally.
  function installAutomationDialogGuard() {
    var log = { count: 0, kinds: [] };
    var originals = [];
    var dismissals = { alert: undefined, confirm: false, prompt: null };
    var kinds = ['alert', 'confirm', 'prompt'];
    for (var index = 0; index < kinds.length; index += 1) {
      installOneAutomationDialogStub(kinds[index], log, originals, dismissals);
    }
    automationDialogLog = log;
    return function restoreAutomationDialogGuard() {
      for (var restoreIndex = 0; restoreIndex < originals.length; restoreIndex += 1) {
        try {
          window[originals[restoreIndex].kind] = originals[restoreIndex].original;
        } catch (_error) {
          // A page that froze `window.alert` keeps our stub; nothing else we can do.
        }
      }
      automationDialogLog = null;
    };
  }

  function installOneAutomationDialogStub(kind, log, originals, dismissals) {
    try {
      if (typeof window[kind] !== 'function') return;
      originals.push({ kind: kind, original: window[kind] });
      window[kind] = function () {
        log.count += 1;
        if (log.kinds.indexOf(kind) < 0) log.kinds.push(kind);
        return dismissals[kind];
      };
    } catch (_error) {
      // Page-owned globals may be non-writable; leave the real dialog in place.
    }
  }

  function automationDialogSummary() {
    if (!automationDialogLog || automationDialogLog.count < 1) return undefined;
    return {
      count: Math.min(automationDialogLog.count, 50),
      kinds: automationDialogLog.kinds.slice(0, 3),
      handling: 'dismissed'
    };
  }

  function isCurrentAutomationCommand(message) {
    return message
      && message.kind === 'browser.injectedRuntime.command'
      && message.module === 'automation'
      && message.runtimeId === runtime.runtimeId
      && message.browserSessionId === config.browserSessionId
      && message.viewId === config.viewId
      && message.navigationGeneration === config.navigationGeneration
      && message.collectorId === config.collector.collectorId
      && message.nonce === config.collector.nonce;
  }

  function postAutomationResult(command, startedAt, ok, data, errorCode, stale) {
    postEnvelope({
      v: 1,
      kind: 'browser.injectedRuntime.result',
      runtimeId: runtime.runtimeId,
      collectorId: config.collector.collectorId,
      nonce: config.collector.nonce,
      browserSessionId: config.browserSessionId,
      viewId: config.viewId,
      navigationGeneration: config.navigationGeneration,
      ...(command.frameId ? { frameId: command.frameId } : {}),
      commandId: command.commandId,
      capabilityVersion: command.capabilityVersion || config.collector.version,
      module: 'automation',
      ok: ok === true,
      fidelity: 'injectedPage',
      trusted: false,
      stale: stale === true,
      durationMs: Math.max(0, now() - startedAt),
      ...(errorCode ? { errorCode: errorCode } : {}),
      data: withAutomationDialogSummary(data || {})
    });
  }

  function withAutomationDialogSummary(data) {
    var dialogs = automationDialogSummary();
    return dialogs ? Object.assign({}, data, { javascriptDialogs: dialogs }) : data;
  }

  function summarizeAutomationRect(node) {
    var rect = rectFor(node);
    if (!rect) return undefined;
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function summarizeAutomationElement(node) {
    var accessibleName = accessibleNameFor(node);
    var rect = summarizeAutomationRect(node);
    return {
      tagName: String(node && node.tagName || '').toLowerCase().slice(0, 64),
      ...(node && typeof node.getAttribute === 'function' && node.getAttribute('role') ? {
        role: String(node.getAttribute('role')).slice(0, 64)
      } : {}),
      ...(node && typeof node.getAttribute === 'function' && node.getAttribute('data-testid') ? {
        testIdAvailable: true
      } : {}),
      accessibleNameAvailable: accessibleName.length > 0,
      rectAvailable: Boolean(rect),
      ...(rect ? { rect: rect } : {})
    };
  }

  function automationLocatorPayload(payload) {
    if (!payload || typeof payload !== 'object') return {};
    var locator = payload.locator;
    if (locator && typeof locator === 'object') return locator;
    return payload;
  }

  function queryAutomationElements(payload) {
    var locator = automationLocatorPayload(payload);
    var kind = String(locator.kind || locator.type || '').trim();
    var value = String(locator.value || locator.selector || locator.text || locator.testId || '').trim();
    var elements = [];

    try {
      if ((kind === 'css' || kind === 'selector' || (!kind && value.charAt(0) === '#')) && value && typeof document.querySelectorAll === 'function') {
        elements = Array.prototype.slice.call(document.querySelectorAll(value));
      } else if ((kind === 'testId' || kind === 'testid') && value && typeof document.querySelectorAll === 'function') {
        elements = Array.prototype.slice.call(document.querySelectorAll('[data-testid="' + String(value).replace(/"/g, '\\\\"') + '"]'));
      } else if ((kind === 'text' || !kind) && value && typeof document.querySelectorAll === 'function') {
        var candidates = Array.prototype.slice.call(document.querySelectorAll('button,input,textarea,select,a,[role],label,[tabindex]'));
        elements = candidates.filter(function (candidate) {
          return accessibleNameFor(candidate).toLowerCase().indexOf(value.toLowerCase()) >= 0;
        });
      }
    } catch (_error) {
      elements = [];
    }

    return elements.filter(Boolean);
  }

  function firstAutomationElement(payload) {
    return queryAutomationElements(payload)[0];
  }

  function dispatchAutomationEvent(node, type) {
    try {
      var event;
      if (typeof MouseEvent === 'function' && (type === 'click' || type === 'mousedown' || type === 'mouseup' || type === 'mouseover')) {
        event = new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
      } else if (typeof Event === 'function') {
        event = new Event(type, { bubbles: true, cancelable: true });
      } else if (document.createEvent) {
        event = document.createEvent('Event');
        event.initEvent(type, true, true);
      }
      if (event && node && typeof node.dispatchEvent === 'function') {
        node.dispatchEvent(event);
      }
    } catch (_error) {
      // Synthetic page events are best-effort and intentionally untrusted.
    }
  }

  function setAutomationValue(node, value, append) {
    var nextText = String(value || '');
    try {
      if ('value' in node) {
        var currentValue = append ? String(node.value || '') : '';
        node.value = currentValue + nextText;
      } else {
        node.textContent = append ? String(node.textContent || '') + nextText : nextText;
      }
      dispatchAutomationEvent(node, 'input');
      dispatchAutomationEvent(node, 'change');
      return true;
    } catch (_error) {
      return false;
    }
  }

  function handleAutomationSnapshot(command, startedAt) {
    postAutomationResult(command, startedAt, true, {
      url: sanitizeUrl(window.location.href || ''),
      readyState: String(document.readyState || ''),
      titleAvailable: Boolean(document.title || ''),
      viewport: {
        width: Number(window.innerWidth || 0),
        height: Number(window.innerHeight || 0)
      }
    });
  }

  function handleAutomationQuery(command, startedAt) {
    var elements = queryAutomationElements(command.payload || {});
    postAutomationResult(command, startedAt, true, {
      elementCount: elements.length,
      elements: elements.slice(0, 25).map(summarizeAutomationElement)
    });
  }

  function handleAutomationClick(command, startedAt) {
    var node = firstAutomationElement(command.payload || {});
    if (!node) {
      postAutomationResult(command, startedAt, false, {}, 'selector_not_found');
      return;
    }
    try {
      if (typeof node.focus === 'function') node.focus();
      dispatchAutomationEvent(node, 'mousedown');
      dispatchAutomationEvent(node, 'mouseup');
      dispatchAutomationEvent(node, 'click');
      postAutomationResult(command, startedAt, true, {
        matched: true,
        element: summarizeAutomationElement(node)
      });
    } catch (_error) {
      postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
    }
  }

  function handleAutomationType(command, startedAt) {
    var node = firstAutomationElement(command.payload || {});
    if (!node) {
      postAutomationResult(command, startedAt, false, {}, 'selector_not_found');
      return;
    }
    var payload = command.payload || {};
    var text = typeof payload.text === 'string' ? payload.text : String(payload.value || '');
    var append = payload.append !== false;
    try {
      if (typeof node.focus === 'function') node.focus();
      if (!setAutomationValue(node, text, append)) {
        postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
        return;
      }
      postAutomationResult(command, startedAt, true, {
        matched: true,
        textLength: text.length,
        element: summarizeAutomationElement(node)
      });
    } catch (_error) {
      postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
    }
  }

  function automationFileFrom(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') return null;
    var name = String(descriptor.name || 'upload.bin').slice(0, 255);
    var mimeType = String(descriptor.mimeType || 'application/octet-stream').slice(0, 128);
    // `text` is the only content field: the egress redactor already reduces that key to a length,
    // so uploaded content can never reach a timeline. Binary is carried base64-encoded in it.
    var text = typeof descriptor.text === 'string' ? descriptor.text : '';
    try {
      if (descriptor.base64 === true) {
        var binary = atob(text);
        var bytes = new Uint8Array(binary.length);
        for (var index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return new File([bytes], name, { type: mimeType });
      }
      return new File([text], name, { type: mimeType });
    } catch (_error) {
      return null;
    }
  }

  function handleAutomationUpload(command, startedAt) {
    var payload = command.payload || {};
    var node = firstAutomationElement(payload);
    if (!node) {
      postAutomationResult(command, startedAt, false, {}, 'selector_not_found');
      return;
    }
    if (String(node.tagName || '').toLowerCase() !== 'input' || String(node.type || '') !== 'file') {
      postAutomationResult(command, startedAt, false, {}, 'unsupported_action');
      return;
    }
    var descriptors = Array.isArray(payload.files) ? payload.files.slice(0, 10) : [];
    if (descriptors.length < 1) {
      postAutomationResult(command, startedAt, false, {}, 'unsupported_action');
      return;
    }
    if (typeof DataTransfer !== 'function' || typeof File !== 'function') {
      postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
      return;
    }
    try {
      var transfer = new DataTransfer();
      var attached = 0;
      for (var index = 0; index < descriptors.length; index += 1) {
        var file = automationFileFrom(descriptors[index]);
        if (!file) continue;
        transfer.items.add(file);
        attached += 1;
      }
      if (attached < 1) {
        postAutomationResult(command, startedAt, false, {}, 'unsupported_action');
        return;
      }
      node.files = transfer.files;
      dispatchAutomationEvent(node, 'input');
      dispatchAutomationEvent(node, 'change');
      postAutomationResult(command, startedAt, true, {
        matched: true,
        fileCount: attached,
        element: summarizeAutomationElement(node)
      });
    } catch (_error) {
      postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
    }
  }

  function dispatchAutomationDragEvent(node, type, transfer) {
    try {
      var event;
      if (typeof DragEvent === 'function') {
        event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
      } else if (typeof MouseEvent === 'function') {
        event = new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
        try { event.dataTransfer = transfer; } catch (_assignError) { /* read-only in old engines */ }
      }
      if (event && node && typeof node.dispatchEvent === 'function') {
        node.dispatchEvent(event);
      }
    } catch (_error) {
      // Synthetic drag events are best-effort and intentionally untrusted.
    }
  }

  function handleAutomationDrag(command, startedAt) {
    var payload = command.payload || {};
    var source = queryAutomationElements({ locator: payload.from || payload.locator || payload.source })[0];
    var target = queryAutomationElements({ locator: payload.to || payload.target || payload.destination })[0];
    if (!source || !target) {
      postAutomationResult(command, startedAt, false, {}, 'selector_not_found');
      return;
    }
    if (typeof DataTransfer !== 'function') {
      postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
      return;
    }
    try {
      var transfer = new DataTransfer();
      dispatchAutomationDragEvent(source, 'dragstart', transfer);
      dispatchAutomationDragEvent(target, 'dragenter', transfer);
      dispatchAutomationDragEvent(target, 'dragover', transfer);
      dispatchAutomationDragEvent(target, 'drop', transfer);
      dispatchAutomationDragEvent(source, 'dragend', transfer);
      postAutomationResult(command, startedAt, true, {
        matched: true,
        source: summarizeAutomationElement(source),
        target: summarizeAutomationElement(target)
      });
    } catch (_error) {
      postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
    }
  }

  function handleAutomationScroll(command, startedAt) {
    var payload = command.payload || {};
    var deltaX = Number(payload.deltaX || 0);
    var deltaY = Number(payload.deltaY || payload.y || 0);
    var node = firstAutomationElement(payload);
    try {
      if (node && typeof node.scrollBy === 'function') {
        node.scrollBy(deltaX, deltaY);
      } else if (node) {
        node.scrollLeft = Number(node.scrollLeft || 0) + deltaX;
        node.scrollTop = Number(node.scrollTop || 0) + deltaY;
      } else if (typeof window.scrollBy === 'function') {
        window.scrollBy(deltaX, deltaY);
      }
      postAutomationResult(command, startedAt, true, {
        deltaX: deltaX,
        deltaY: deltaY,
        target: node ? 'element' : 'window'
      });
    } catch (_error) {
      postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
    }
  }

  function handleAutomationWaitFor(command, startedAt) {
    var payload = command.payload || {};
    var timeoutMs = Math.max(1, Math.min(Number(payload.timeoutMs || 2000), 60000));
    var pollMs = Math.max(25, Math.min(Number(payload.pollMs || 100), 1000));
    var expiresAt = now() + timeoutMs;

    function finish(ok, errorCode) {
      if (timerId) {
        clearTimeout(timerId);
      }
      automationTimers = automationTimers.filter(function (timer) { return timer !== timerId; });
      postAutomationResult(command, startedAt, ok, ok ? { matched: true } : {}, errorCode);
    }

    function check() {
      if (queryAutomationElements(payload).length > 0) {
        finish(true);
        return;
      }
      if (now() >= expiresAt) {
        finish(false, 'timed_out');
        return;
      }
      var nextTimerId = setTimeout(function () {
        automationTimers = automationTimers.filter(function (timer) { return timer !== nextTimerId; });
        if (timerId === nextTimerId) {
          timerId = null;
        }
        check();
      }, pollMs);
      timerId = nextTimerId;
      automationTimers.push(nextTimerId);
    }

    var timerId = null;
    check();
  }

  function handleAutomationCommand(message) {
    if (!isCurrentAutomationCommand(message)) return;
    var startedAt = now();
    var restoreDialogGuard = installAutomationDialogGuard();
    try {
      routeAutomationCommand(message, startedAt);
    } finally {
      restoreDialogGuard();
    }
  }

  function routeAutomationCommand(message, startedAt) {
    switch (message.commandName) {
      case 'snapshot':
      case 'semanticSnapshot':
        handleAutomationSnapshot(message, startedAt);
        break;
      case 'queryElements':
      case 'locatorQuery':
        handleAutomationQuery(message, startedAt);
        break;
      case 'click':
      case 'tap':
        handleAutomationClick(message, startedAt);
        break;
      case 'type':
      case 'setValue':
        handleAutomationType(message, startedAt);
        break;
      case 'upload':
        handleAutomationUpload(message, startedAt);
        break;
      case 'drag':
        handleAutomationDrag(message, startedAt);
        break;
      case 'scroll':
        handleAutomationScroll(message, startedAt);
        break;
      case 'waitFor':
        handleAutomationWaitFor(message, startedAt);
        break;
      case 'evaluate':
      case 'startElementPicker':
      case 'cancelElementPicker':
        postAutomationResult(message, startedAt, false, {}, 'blocked_by_policy');
        break;
      default:
        postAutomationResult(message, startedAt, false, {}, 'unsupported_action');
        break;
    }
  }

`;

export const INJECTED_DOM_SNAPSHOT_RUNTIME = `
  function countDomNodes(root) {
    // Structural counts only: number of element nodes and the deepest element nesting.
    // We never read textContent, attributes, or serialize markup — only walk element children.
    var elementCount = 0;
    var maxDepth = 0;
    var nodeCount = 0;
    try {
      if (!root || root.nodeType !== 1) {
        return { elementCount: 0, maxDepth: 0, nodeCount: 0 };
      }
      var stack = [{ node: root, depth: 1 }];
      var visited = 0;
      var maxVisited = 20000;
      while (stack.length > 0 && visited < maxVisited) {
        var current = stack.pop();
        var node = current.node;
        if (!node || node.nodeType !== 1) continue;
        visited += 1;
        nodeCount += 1;
        elementCount += 1;
        if (current.depth > maxDepth) maxDepth = current.depth;
        var children = node.children;
        if (children && typeof children.length === 'number') {
          for (var index = 0; index < children.length; index += 1) {
            stack.push({ node: children[index], depth: current.depth + 1 });
          }
        }
      }
    } catch (_error) {
      // Best-effort structural walk only; never throws page content into diagnostics.
    }
    return { elementCount: elementCount, maxDepth: maxDepth, nodeCount: nodeCount };
  }

  function emitDomSnapshot() {
    var root;
    try {
      root = document && document.documentElement;
    } catch (_error) {
      root = null;
    }
    if (!root) {
      postEvents([unavailableEvent('pageInfo', 'collector_unavailable')]);
      return;
    }
    var counts = countDomNodes(root);
    var readyState;
    try {
      readyState = String(document.readyState || '');
    } catch (_error) {
      readyState = '';
    }
    postEvents([baseEvent('pageInfo', 'pageInfo.domSnapshot', {
      nodeCount: counts.nodeCount,
      elementCount: counts.elementCount,
      maxDepth: counts.maxDepth,
      ...(readyState ? { readyState: readyState } : {})
    })]);
  }

`;
