// App-owned listener from the DBW U4b setup reference (9dd6c872a29).
(() => {
  function send(error, fallbackType, fallbackMessage, fallbackStack) {
    const text = value => typeof value === 'string' ? value : undefined;
    const message = text(error && error.message) || fallbackMessage;
    if (!message) return;
    const body = {
      id: crypto.randomUUID(),
      type: text(error && error.name) || fallbackType,
      message,
      stacktrace: text(error && error.stack) || fallbackStack,
      escaped: true
    };
    // Best effort; reporting failure must not become another unhandled rejection.
    void fetch('/api/telemetry', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), keepalive: true
    }).catch(() => {});
  }
  window.addEventListener('error', event => {
    send(event.error, 'Error', event.message,
      event.filename ? 'at ' + event.filename + ':' + event.lineno + ':' + event.colno : undefined);
  });
  window.addEventListener('unhandledrejection', event => {
    send(event.reason, 'UnhandledRejection', String(event.reason));
  });
})();
