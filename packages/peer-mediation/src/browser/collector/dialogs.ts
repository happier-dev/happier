/** Dialog interception lasts for one injected command and never publishes page text or answers. */
export const INJECTED_AUTOMATION_DIALOG_RUNTIME = `
  var automationDialogLog = null;

  function installAutomationDialogGuard(response) {
    var log = { count: 0, kinds: [], accepted: false, dismissed: false, responseUsed: false };
    var originals = [];
    var kinds = ['alert', 'confirm', 'prompt'];
    for (var index = 0; index < kinds.length; index += 1) {
      installOneAutomationDialogStub(kinds[index], log, originals, response);
    }
    automationDialogLog = log;
    return function restoreAutomationDialogGuard() {
      for (var restoreIndex = 0; restoreIndex < originals.length; restoreIndex += 1) {
        try {
          window[originals[restoreIndex].kind] = originals[restoreIndex].original;
        } catch (_error) {
          // Page-owned globals may become non-writable during the command.
        }
      }
      automationDialogLog = null;
    };
  }

  function installOneAutomationDialogStub(kind, log, originals, response) {
    try {
      if (typeof window[kind] !== 'function') return;
      originals.push({ kind: kind, original: window[kind] });
      window[kind] = function (message, defaultValue) {
        log.count += 1;
        if (log.kinds.indexOf(kind) < 0) log.kinds.push(kind);
        var matches = !log.responseUsed && response && response.kind === kind
          && response.message === String(message === undefined ? '' : message);
        if (matches) log.responseUsed = true;
        var accept = matches && response.accept === true;
        if (accept) log.accepted = true;
        else log.dismissed = true;
        if (kind === 'confirm') return Boolean(accept);
        if (kind === 'prompt') return accept
          ? response.promptText === undefined ? String(defaultValue === undefined ? '' : defaultValue) : response.promptText
          : null;
        return undefined;
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
      handling: automationDialogLog.accepted
        ? automationDialogLog.dismissed ? 'mixed' : 'accepted'
        : 'dismissed'
    };
  }
`;
