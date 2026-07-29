export const INJECTED_OBJECT_INSPECTOR_RUNTIME = `
	  var evalSuppressed = false;
  var objectSeq = 0;
  var objectGroups = {};
  var pickerSeq = 0;
  var pickerNodeRefs = typeof WeakMap === 'function' ? new WeakMap() : null;
  var activePicker = null;
  var highlightedPickerNode = null;
  var highlightedPickerOutline = '';

  function objectGroup(name) {
    var groupName = String(name || 'default').slice(0, 256);
    objectGroups[groupName] = objectGroups[groupName] || {};
    return {
      name: groupName,
      values: objectGroups[groupName]
    };
  }

  function describeValue(value) {
    try {
      if (value === null) return 'null';
      if (value === undefined) return 'undefined';
      if (typeof value === 'function') return 'function';
      if (typeof value === 'object' && value && value.constructor && value.constructor.name) return String(value.constructor.name).slice(0, 256);
      return typeof value;
    } catch (_error) {
      return 'unavailable';
    }
  }

  function previewProperties(value) {
    try {
      return Object.keys(Object(value)).slice(0, 10).map(function (name) {
        var propertyValue;
        var propertyPreview;
        var truncated = false;
        try {
          propertyValue = value[name];
          propertyPreview = preview(propertyValue);
          truncated = typeof propertyPreview === 'string' && propertyPreview.length >= 1024;
        } catch (_error) {
          propertyPreview = '[unavailable]';
        }
        return {
          name: String(name).slice(0, 256) || '[property]',
          valuePreview: String(propertyPreview || '').slice(0, 1024),
          truncated: truncated
        };
      });
    } catch (_error) {
      return [];
    }
  }

  function toRemoteObject(value, objectGroupId) {
    if (value === undefined) return { type: 'undefined' };
    if (value === null) return { type: 'null', value: null };
    if (typeof value === 'string') return { type: 'string', value: value.slice(0, 1024) };
    if (typeof value === 'number') return { type: 'number', value: value };
    if (typeof value === 'boolean') return { type: 'boolean', value: value };
    if (typeof value === 'bigint') return { type: 'bigint', description: String(value).slice(0, 1024) };
    if (typeof value === 'symbol') return { type: 'symbol', description: String(value).slice(0, 1024) };

    var group = objectGroup(objectGroupId);
    objectSeq += 1;
    var objectId = config.viewId + ':' + config.navigationGeneration + ':' + group.name + ':' + objectSeq;
    group.values[objectId] = value;
    return {
      type: typeof value === 'function' ? 'function' : 'object',
      objectId: objectId,
      className: describeValue(value),
      description: describeValue(value),
      preview: previewProperties(value)
    };
  }

  function toExpandedRemoteObject(value, objectGroupId) {
    if (value === undefined) return { type: 'undefined' };
    if (value === null) return { type: 'null', value: null };
    if (typeof value === 'string') return { type: 'string', value: value.slice(0, 65536) };
    if (typeof value === 'number') return { type: 'number', value: value };
    if (typeof value === 'boolean') return { type: 'boolean', value: value };
    if (typeof value === 'bigint') return { type: 'bigint', description: String(value).slice(0, 1024) };
    if (typeof value === 'symbol') return { type: 'symbol', description: String(value).slice(0, 1024) };
    return toRemoteObject(value, objectGroupId);
  }

  function postEvalResult(request, status, result, errorCode) {
    postEnvelope({
      v: 1,
      kind: 'browser.diagnostics.evalResult',
      browserSessionId: config.browserSessionId,
      viewId: config.viewId,
      navigationGeneration: config.navigationGeneration,
      collector: config.collector,
      result: {
        v: 1,
        evalRequestId: request.evalRequestId,
        viewId: config.viewId,
        navigationGeneration: config.navigationGeneration,
        status: status,
        tier: 'injectedPage',
        audited: true,
        ...(result ? { result: result } : {}),
        ...(errorCode ? { errorCode: errorCode } : {})
      }
    });
  }

  function postPropertiesResult(request, status, properties, errorCode) {
    postEnvelope({
      v: 1,
      kind: 'browser.diagnostics.getPropertiesResult',
      browserSessionId: config.browserSessionId,
      viewId: config.viewId,
      navigationGeneration: config.navigationGeneration,
      collector: config.collector,
      result: {
        v: 1,
        propertyRequestId: request.propertyRequestId,
        viewId: config.viewId,
        navigationGeneration: config.navigationGeneration,
        tier: 'injectedPage',
        status: status,
        audited: true,
        objectId: request.objectId,
        properties: properties || [],
        ...(errorCode ? { errorCode: errorCode } : {})
      }
    });
  }

  function postReleaseResult(request, status, errorCode) {
    postEnvelope({
      v: 1,
      kind: 'browser.diagnostics.releaseObjectGroupResult',
      browserSessionId: config.browserSessionId,
      viewId: config.viewId,
      navigationGeneration: config.navigationGeneration,
      collector: config.collector,
      result: {
        v: 1,
        releaseRequestId: request.releaseRequestId,
        viewId: config.viewId,
        navigationGeneration: config.navigationGeneration,
        tier: 'injectedPage',
        status: status,
        audited: true,
        objectGroupId: request.objectGroupId,
        ...(errorCode ? { errorCode: errorCode } : {})
      }
    });
  }

  function emitEvalAudit(kind, data) {
    var event = baseEvent('console', kind, Object.assign({ tier: 'injectedPage' }, data));
    event.redaction.level = 'valuesRedacted';
    postEvents([event]);
  }

  function markEvalDegraded(request, timeoutMs) {
    evalSuppressed = true;
    postEvents([
      baseEvent('pageInfo', 'collector.degraded', { reasonCode: 'eval_timeout' })
    ]);
    emitEvalAudit('eval.timedOut', {
      evalRequestId: request.evalRequestId,
      timeoutMs: timeoutMs
    });
  }

  function isCurrentEvalCommand(message) {
    return message
      && message.kind === 'browser.diagnostics.evalRequest'
      && message.browserSessionId === config.browserSessionId
      && message.viewId === config.viewId
      && message.navigationGeneration === config.navigationGeneration
      && message.collector
      && message.collector.collectorId === config.collector.collectorId
      && message.collector.nonce === config.collector.nonce
      && message.request
      && message.request.viewId === config.viewId
      && message.request.navigationGeneration === config.navigationGeneration
      && message.request.tier === 'injectedPage';
  }

  function isCurrentGetPropertiesCommand(message) {
    return message
      && message.kind === 'browser.diagnostics.getPropertiesRequest'
      && message.browserSessionId === config.browserSessionId
      && message.viewId === config.viewId
      && message.navigationGeneration === config.navigationGeneration
      && message.collector
      && message.collector.collectorId === config.collector.collectorId
      && message.collector.nonce === config.collector.nonce
      && message.request
      && message.request.viewId === config.viewId
      && message.request.navigationGeneration === config.navigationGeneration
      && message.request.tier === 'injectedPage';
  }

  function isCurrentReleaseCommand(message) {
    return message
      && message.kind === 'browser.diagnostics.releaseObjectGroupRequest'
      && message.browserSessionId === config.browserSessionId
      && message.viewId === config.viewId
      && message.navigationGeneration === config.navigationGeneration
      && message.collector
      && message.collector.collectorId === config.collector.collectorId
      && message.collector.nonce === config.collector.nonce
      && message.request
      && message.request.viewId === config.viewId
      && message.request.navigationGeneration === config.navigationGeneration
      && message.request.tier === 'injectedPage';
  }

  function isCurrentElementPickerCommand(message) {
    return message
      && message.kind === 'browser.diagnostics.elementPickerRequest'
      && message.browserSessionId === config.browserSessionId
      && message.viewId === config.viewId
      && message.navigationGeneration === config.navigationGeneration
      && message.collector
      && message.collector.collectorId === config.collector.collectorId
      && message.collector.nonce === config.collector.nonce
      && message.request
      && message.request.viewId === config.viewId
      && message.request.navigationGeneration === config.navigationGeneration
      && message.request.tier === 'injectedPage';
  }

`;
