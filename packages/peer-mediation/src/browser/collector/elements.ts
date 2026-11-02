import { INJECTED_PAGE_AUTOMATION_ACTIONS } from './actions.js';
import { INJECTED_REACT_CONTEXT_RUNTIME } from './react.js';
import { INJECTED_AUTOMATION_DIALOG_RUNTIME } from './dialogs.js';
import { isBrowserAutomationMutatingActionKind } from '@happier-dev/protocol/browser/automation/v1';
import { normalizeBrowserActiveTargetRect, readBrowserActiveTargetLabel } from '@happier-dev/protocol/browser/events/activeTarget';
import { normalizeBrowserAutomationLocator, parseLocator, resolveBrowserLocatorElements } from '@happier-dev/protocol/browser/automation/locators';

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

  ${INJECTED_REACT_CONTEXT_RUNTIME}

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
  ${INJECTED_AUTOMATION_DIALOG_RUNTIME}

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

  function postAutomationResult(command, startedAt, ok, data, errorCode, stale, activeTarget) {
    postEnvelope({
      v: 1,
      kind: 'browser.injectedRuntime.result',
      ...(activeTarget ? { phase: 'target', activeTarget: activeTarget } : {}),
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

  var parseLocator = ${parseLocator.toString()};
  var normalizeBrowserAutomationLocator = ${normalizeBrowserAutomationLocator.toString()};
  var resolveBrowserLocatorElements = ${resolveBrowserLocatorElements.toString()};

  function queryAutomationElements(payload) {
    var locator = normalizeBrowserAutomationLocator(payload || {});
    return locator ? resolveBrowserLocatorElements(locator, document) : [];
  }

  function firstAutomationElement(payload) {
    return queryAutomationElements(payload)[0];
  }

  // Returns whether the event actually reached the page. The construction/dispatch failure used to
  // be swallowed here while the calling verb still posted 'ok: true, matched: true' — an agent told
  // a click succeeded when nothing was dispatched. The page's own reaction stays untrusted (a
  // handler that throws is the page's business), but whether WE dispatched is a fact the caller
  // needs, so this reports it the same way 'dispatchAutomationKeyEvent' already does.
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
      if (!event || !node || typeof node.dispatchEvent !== 'function') return false;
      node.dispatchEvent(event);
      return true;
    } catch (_error) {
      return false;
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
      // The assignment alone is not a successful 'type': a framework-controlled field only learns
      // about it from these two events, so a refused dispatch is a failed verb, not a partial one.
      var notified = dispatchAutomationEvent(node, 'input');
      notified = dispatchAutomationEvent(node, 'change') && notified;
      return notified;
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
      elements: elements.map(summarizeAutomationElement)
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
      var dispatched = dispatchAutomationEvent(node, 'mousedown');
      dispatched = dispatchAutomationEvent(node, 'mouseup') && dispatched;
      dispatched = dispatchAutomationEvent(node, 'click') && dispatched;
      if (!dispatched) {
        postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
        return;
      }
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
    var append = command.commandName !== 'setValue' && payload.append !== false;
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
    if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.name !== 'string'
        || !descriptor.name || descriptor.name === '.' || descriptor.name === '..'
        || /[\\\\/\u0000]/.test(descriptor.name) || typeof descriptor.text !== 'string') return null;
    var name = descriptor.name;
    var mimeType = typeof descriptor.mimeType === 'string' ? descriptor.mimeType : 'application/octet-stream';
    // 'text' is the only content field: the egress redactor already reduces that key to a length,
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
    var descriptors = Array.isArray(payload.files) ? payload.files : [];
    if (descriptors.length < 1 || (descriptors.length > 1 && !node.multiple)) {
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
        if (!file) {
          postAutomationResult(command, startedAt, false, {}, 'unsupported_action');
          return;
        }
        transfer.items.add(file);
        attached += 1;
      }
      if (attached < 1) {
        postAutomationResult(command, startedAt, false, {}, 'unsupported_action');
        return;
      }
      node.files = transfer.files;
      if (!node.files || node.files.length !== descriptors.length) {
        postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
        return;
      }
      var notified = dispatchAutomationEvent(node, 'input');
      notified = dispatchAutomationEvent(node, 'change') && notified;
      if (!notified) {
        postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
        return;
      }
      postAutomationResult(command, startedAt, true, {
        matched: true,
        fileCount: attached,
        element: summarizeAutomationElement(node)
      });
    } catch (_error) {
      postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
    }
  }

  // Same contract as 'dispatchAutomationEvent': the return value is whether we dispatched.
  function dispatchAutomationDragEvent(node, type, transfer) {
    try {
      var event;
      if (typeof DragEvent === 'function') {
        event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
      } else if (typeof MouseEvent === 'function') {
        event = new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
        try { event.dataTransfer = transfer; } catch (_assignError) { /* read-only in old engines */ }
      }
      if (!event || !node || typeof node.dispatchEvent !== 'function') return false;
      node.dispatchEvent(event);
      return true;
    } catch (_error) {
      return false;
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
      var dragged = dispatchAutomationDragEvent(source, 'dragstart', transfer);
      dragged = dispatchAutomationDragEvent(target, 'dragenter', transfer) && dragged;
      dragged = dispatchAutomationDragEvent(target, 'dragover', transfer) && dragged;
      dragged = dispatchAutomationDragEvent(target, 'drop', transfer) && dragged;
      dragged = dispatchAutomationDragEvent(source, 'dragend', transfer) && dragged;
      if (!dragged) {
        postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
        return;
      }
      postAutomationResult(command, startedAt, true, {
        matched: true,
        source: summarizeAutomationElement(source),
        target: summarizeAutomationElement(target)
      });
    } catch (_error) {
      postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
    }
  }

  // 'hover', 'press' and 'focus' were advertised as available by the capability matrix while the
  // command router had no case for them, so each one round-tripped to 'unsupported_action' at the
  // engine. Found by the UB-1 matrix pass; these are the missing halves of that promise.
  function handleAutomationHover(command, startedAt) {
    var node = firstAutomationElement(command.payload || {});
    if (!node) {
      postAutomationResult(command, startedAt, false, {}, 'selector_not_found');
      return;
    }
    try {
      var hovered = dispatchAutomationEvent(node, 'mouseover');
      hovered = dispatchAutomationEvent(node, 'mousemove') && hovered;
      if (!hovered) {
        postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
        return;
      }
      postAutomationResult(command, startedAt, true, {
        matched: true,
        element: summarizeAutomationElement(node)
      });
    } catch (_error) {
      postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
    }
  }

  function handleAutomationFocus(command, startedAt) {
    var node = firstAutomationElement(command.payload || {});
    if (!node) {
      postAutomationResult(command, startedAt, false, {}, 'selector_not_found');
      return;
    }
    try {
      if (typeof node.focus !== 'function') {
        postAutomationResult(command, startedAt, false, {}, 'unsupported_action');
        return;
      }
      node.focus();
      // Deliberately NOT fail-closed on this one, unlike click/hover/drag/type/upload above:
      // 'node.focus()' is the whole effect and the engine fires its own focus event as a result,
      // so the synthetic one is a belt-and-braces duplicate. Failing the verb because a redundant
      // event was refused would report a false negative for a focus that did happen.
      dispatchAutomationEvent(node, 'focus');
      postAutomationResult(command, startedAt, true, {
        matched: true,
        element: summarizeAutomationElement(node)
      });
    } catch (_error) {
      postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
    }
  }

  function dispatchAutomationKeyEvent(node, type, payload) {
    try {
      if (typeof KeyboardEvent !== 'function') return false;
      var event = new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        key: String(payload.key || ''),
        code: String(payload.code || payload.key || ''),
        altKey: payload.altKey === true,
        ctrlKey: payload.ctrlKey === true,
        metaKey: payload.metaKey === true,
        shiftKey: payload.shiftKey === true
      });
      var target = node || document.activeElement || document.body;
      if (!target || typeof target.dispatchEvent !== 'function') return false;
      target.dispatchEvent(event);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function handleAutomationPress(command, startedAt) {
    var payload = command.payload || {};
    var key = String(payload.key || '');
    if (!key) {
      postAutomationResult(command, startedAt, false, {}, 'unsupported_action');
      return;
    }
    // A locator is optional: with none, the key goes to whatever currently holds focus, which is
    // how a caller follows 'type' with Enter.
    var node = payload.locator || payload.selector ? firstAutomationElement(payload) : null;
    if ((payload.locator || payload.selector) && !node) {
      postAutomationResult(command, startedAt, false, {}, 'selector_not_found');
      return;
    }
    if (node && typeof node.focus === 'function') {
      try { node.focus(); } catch (_error) { /* page may refuse focus */ }
    }
    var down = dispatchAutomationKeyEvent(node, 'keydown', payload);
    dispatchAutomationKeyEvent(node, 'keyup', payload);
    if (!down) {
      postAutomationResult(command, startedAt, false, {}, 'runtime_unavailable');
      return;
    }
    postAutomationResult(command, startedAt, true, {
      matched: true,
      keyLength: key.length,
      target: node ? 'element' : 'activeElement'
    });
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
    var pollMs = Math.max(25, Math.min(Number(payload.pollMs || 100), 1000));
    // The containing Action chooses expiry. Poll cadence is not another operation budget.
    var expiresAt = typeof payload.deadlineMs === 'number' ? payload.deadlineMs : undefined;
    var settled = false;
    var pending = { commandId: command.commandId, cancel: function () { finish(false, 'user_canceled'); } };
    automationTimers.push(pending);

    function finish(ok, errorCode) {
      if (settled) return;
      settled = true;
      if (timerId) {
        clearTimeout(timerId);
      }
      automationTimers = automationTimers.filter(function (wait) { return wait !== pending; });
      postAutomationResult(command, startedAt, ok, ok ? { matched: true } : {}, errorCode);
    }

    function check() {
      if (settled) return;
      if (expiresAt !== undefined && now() >= expiresAt) {
        finish(false, 'timed_out');
        return;
      }
      if (queryAutomationElements(payload).length > 0) {
        finish(true);
        return;
      }
      timerId = setTimeout(function () {
        timerId = null;
        check();
      }, expiresAt === undefined ? pollMs : Math.min(pollMs, Math.max(0, expiresAt - now())));
    }

    var timerId = null;
    check();
  }

  function handleAutomationCommand(message) {
    if (!isCurrentAutomationCommand(message)) return;
    if (message.commandName === 'cancel') {
      automationTimers.slice().forEach(function (wait) {
        if (wait.commandId === message.commandId) wait.cancel();
      });
      return;
    }
    var startedAt = now();
    var restoreDialogGuard = installAutomationDialogGuard(message.payload && message.payload.dialogResponse);
    try {
      if (${JSON.stringify(INJECTED_PAGE_AUTOMATION_ACTIONS.filter(({ action }) => isBrowserAutomationMutatingActionKind(action)).map(({ action }) => action))}.indexOf(message.commandName) !== -1) {
        var node = firstAutomationElement(message.payload || {});
        var rect = node && rectFor(node);
        var activeTarget = rect && (${normalizeBrowserActiveTargetRect.toString()})(rect, { width: window.innerWidth, height: window.innerHeight });
        var targetLabel = node && (${readBrowserActiveTargetLabel.toString()})(node, 512);
        if (activeTarget && targetLabel) activeTarget.label = targetLabel;
        if (activeTarget) postAutomationResult(message, startedAt, true, {}, undefined, false, activeTarget);
      }
      routeAutomationCommand(message, startedAt);
    } finally {
      restoreDialogGuard();
    }
  }

  function routeAutomationCommand(message, startedAt) {
    switch (message.commandName) {
      ${INJECTED_PAGE_AUTOMATION_ACTIONS.map(({ action, handler }) => `case '${action}': ${handler}(message, startedAt); break;`).join('\n      ')}
      // Retained guest command alias; public admission uses queryElements.
      case 'locatorQuery':
        handleAutomationQuery(message, startedAt);
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
