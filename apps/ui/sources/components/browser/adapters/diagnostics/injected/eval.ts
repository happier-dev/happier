export const INJECTED_EVAL_RUNTIME = `
  function handleEvalCommand(message) {
    if (!isCurrentEvalCommand(message)) return;
    var request = message.request;
    var timeoutMs = Math.max(1, Math.min(Number(request.timeoutMs || 2000), 10000));

    if (evalSuppressed) {
      postEvalResult(request, 'collectorDegraded', undefined, 'collector_degraded');
      return;
    }

    if (request.diagnosticsInteractionEnabled !== true) {
      emitEvalAudit('eval.failed', {
        evalRequestId: request.evalRequestId,
        errorAvailable: false
      });
      postEvalResult(request, 'blocked', undefined, 'collector_denied');
      return;
    }

    var expression = String(request.expression || '');
    emitEvalAudit('eval.requested', {
      evalRequestId: request.evalRequestId,
      expressionPreview: expression.slice(0, 4096),
      expressionTruncated: expression.length > 4096,
      timeoutMs: timeoutMs,
      objectGroupId: request.objectGroupId
    });

    var settled = false;
    var startedAt = now();
    var timeoutId = setTimeout(function () {
      if (settled) return;
      settled = true;
      markEvalDegraded(request, timeoutMs);
      postEvalResult(request, 'timedOut', undefined, 'collector_degraded');
    }, timeoutMs);

    function complete(value) {
      if (settled) return;
      if (now() - startedAt > timeoutMs) {
        settled = true;
        clearTimeout(timeoutId);
        markEvalDegraded(request, timeoutMs);
        postEvalResult(request, 'timedOut', undefined, 'collector_degraded');
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      var result = toRemoteObject(value, request.objectGroupId);
      emitEvalAudit('eval.completed', {
        evalRequestId: request.evalRequestId,
        resultType: result.type,
        resultDescriptionAvailable: Boolean(result.description),
        resultPreviewTruncated: Array.isArray(result.preview) && result.preview.some(function (item) { return item.truncated === true; })
      });
      postEvalResult(request, 'completed', result);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      emitEvalAudit('eval.failed', {
        evalRequestId: request.evalRequestId,
        errorAvailable: Boolean(error)
      });
      postEvalResult(request, 'failed');
    }

    try {
      var output = (0, eval)(expression);
      if (output && typeof output.then === 'function') {
        Promise.resolve(output).then(complete, fail);
      } else {
        complete(output);
      }
    } catch (error) {
      fail(error);
    }
  }

  function handleGetPropertiesCommand(message) {
    if (!isCurrentGetPropertiesCommand(message)) return;
    var request = message.request;

    if (evalSuppressed) {
      postPropertiesResult(request, 'collectorDegraded', [], 'collector_degraded');
      return;
    }
    if (request.diagnosticsInteractionEnabled !== true) {
      postPropertiesResult(request, 'blocked', [], 'collector_denied');
      return;
    }

    var group = objectGroups[String(request.objectGroupId || '')];
    var objectValue = group && group[request.objectId];
    if (!group || !(request.objectId in group)) {
      postPropertiesResult(request, 'failed', [], 'target_detached');
      return;
    }

    try {
      var objectRef = Object(objectValue);
      var properties = Object.keys(objectRef).slice(0, 100).map(function (name) {
        var propertyValue;
        try {
          propertyValue = objectRef[name];
        } catch (_error) {
          propertyValue = undefined;
        }
        return {
          name: String(name).slice(0, 256) || '[property]',
          value: toExpandedRemoteObject(propertyValue, request.objectGroupId),
          enumerable: Object.prototype.propertyIsEnumerable.call(objectRef, name)
        };
      });
      postPropertiesResult(request, 'completed', properties);
    } catch (_error) {
      postPropertiesResult(request, 'failed', [], 'collector_unavailable');
    }
  }

  function handleReleaseCommand(message) {
    if (!isCurrentReleaseCommand(message)) return;
    var request = message.request;

    if (evalSuppressed) {
      postReleaseResult(request, 'collectorDegraded', 'collector_degraded');
      return;
    }
    if (request.diagnosticsInteractionEnabled !== true) {
      postReleaseResult(request, 'blocked', 'collector_denied');
      return;
    }

    delete objectGroups[String(request.objectGroupId || '')];
    postReleaseResult(request, 'completed');
  }

`;
