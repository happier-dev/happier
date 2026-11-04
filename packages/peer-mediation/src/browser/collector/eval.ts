export const INJECTED_EVAL_RUNTIME = `
  var pendingEvals = new Map();

  function cancelPendingEvals() {
    pendingEvals.forEach(function (pending) { pending.cancel(); });
  }

  function handleEvalCommand(message) {
    if (!isCurrentEvalCommand(message)) return;
    var request = message.request;
    if (request.action === 'cancel') {
      var pending = pendingEvals.get(request.evalRequestId);
      if (pending) pending.cancel();
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
      expressionPreview: expression,
      expressionTruncated: false,
      objectGroupId: request.objectGroupId
    });

    var settled = false;
    pendingEvals.set(request.evalRequestId, { cancel: function () {
      if (settled) return;
      settled = true;
      pendingEvals.delete(request.evalRequestId);
      postEvalResult(request, 'cancelled');
    } });

    function complete(value) {
      if (settled) return;
      settled = true;
      pendingEvals.delete(request.evalRequestId);
      var result = toRemoteObject(value, request.objectGroupId);
      emitEvalAudit('eval.completed', {
        evalRequestId: request.evalRequestId,
        resultType: result.type,
        resultDescriptionAvailable: Boolean(result.description),
        resultPreviewTruncated: result.previewTruncated === true || Array.isArray(result.preview) && result.preview.some(function (item) { return item.truncated === true; })
      });
      postEvalResult(request, 'completed', result);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      pendingEvals.delete(request.evalRequestId);
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
      var properties = Object.getOwnPropertyNames(objectRef).map(function (name) {
        var propertyValue;
        try {
          propertyValue = objectRef[name];
        } catch (_error) {
          propertyValue = undefined;
        }
        return {
          name: String(name),
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

    if (request.diagnosticsInteractionEnabled !== true) {
      postReleaseResult(request, 'blocked', 'collector_denied');
      return;
    }

    delete objectGroups[String(request.objectGroupId || '')];
    postReleaseResult(request, 'completed');
  }

`;
