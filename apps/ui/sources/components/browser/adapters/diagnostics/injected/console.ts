export const INJECTED_CONSOLE_RUNTIME = `
  function renderConsoleArg(value) {
    if (typeof value === 'string') return value;
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    if (typeof value === 'symbol' || typeof value === 'function') {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return Object.prototype.toString.call(value);
    }
  }

  function cappedConsoleText(args) {
    var cap = typeof config.consoleTextMaxLength === 'number' ? config.consoleTextMaxLength : 4096;
    var rendered = '';
    for (var index = 0; index < args.length; index += 1) {
      if (index > 0) rendered += ' ';
      rendered += renderConsoleArg(args[index]);
      if (rendered.length > cap) break;
    }
    var truncated = rendered.length > cap;
    return { text: truncated ? rendered.slice(0, cap) : rendered, truncated: truncated };
  }

  ['debug', 'error', 'info', 'log', 'warn'].forEach(function (level) {
    originalConsole[level] = console[level];
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      var data = {
        level: level,
        argCount: args.length,
        textAvailable: args.length > 0
      };
      // DEV-2: the LOCAL owner's value-capture policy surfaces a length-capped text rendering at full
      // fidelity. The fail-closed default emits metadata only and stays valuesRedacted. The egress
      // classifier strips the owner-only text field for any agent/remote destination regardless.
      var ownerCapture = config.ownerConsoleValueCapture === true && args.length > 0;
      var capped = ownerCapture ? cappedConsoleText(args) : null;
      if (capped) {
        data.text = capped.text;
      }
      var event = baseEvent('console', 'console.entry', data);
      if (capped) {
        event.redaction.level = 'none';
        event.redaction.truncated = capped.truncated;
      } else {
        event.redaction.level = 'valuesRedacted';
      }
      postEvents([event]);
      return originalConsole[level].apply(console, arguments);
    };
  });

  function handleError(event) {
    var errorEvent = baseEvent('pageError', 'pageError.thrown', {
      textAvailable: Boolean(event.error || event.message)
    });
    errorEvent.redaction.level = 'valuesRedacted';
    postEvents([errorEvent]);
  }

`;
