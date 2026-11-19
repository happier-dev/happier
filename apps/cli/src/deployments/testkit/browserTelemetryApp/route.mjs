// Server adapter from the DBW U4b setup reference (9dd6c872a29).
// Install only in a server/edge module. Bind POST /api/telemetry to this
// Web Request handler using the app's ordinary request/body/abuse boundaries.
// Resolve endpoint/token from the existing server-side P6 collector settings.
// serviceVersion must identify the browser build served by this deployment.
export function createBrowserTelemetryRoute({ endpoint, token, serviceName, serviceVersion, environment }) {
  const stringValue = value => ({ stringValue: value });
  return async function handleBrowserTelemetry(request) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response(null, { status: 403 });
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return new Response(null, { status: 415 });
    let event;
    try { event = await request.json(); } catch { return new Response(null, { status: 400 }); }
    if (!event || typeof event.id !== 'string' || !event.id || typeof event.type !== 'string' ||
        typeof event.message !== 'string' || !event.message ||
        (event.stacktrace !== undefined && typeof event.stacktrace !== 'string')) return new Response(null, { status: 400 });
    const attributes = [
      { key: 'log.record.uid', value: stringValue(event.id) },
      { key: 'exception.type', value: stringValue(event.type) },
      { key: 'exception.message', value: stringValue(event.message) },
      { key: 'exception.escaped', value: { boolValue: true } }
    ];
    if (event.stacktrace) attributes.push({ key: 'exception.stacktrace', value: stringValue(event.stacktrace) });
    // Ignore client-supplied OTLP resources, fingerprints, destinations and headers.
    // Ingest owns secret redaction and type/message/top-frame grouping once.
    const body = { resourceLogs: [{ resource: { attributes: [
      { key: 'service.name', value: stringValue(serviceName) },
      { key: 'service.version', value: stringValue(serviceVersion) },
      { key: 'deployment.environment.name', value: stringValue(environment) }
    ] }, scopeLogs: [{ scope: { name: 'app.browser.errors' }, logRecords: [{
      timeUnixNano: String(BigInt(Date.now()) * 1000000n), severityNumber: 17,
      attributes,
      ...(typeof event.traceId === 'string' && /^[0-9a-f]{32}$/i.test(event.traceId) && !/^0+$/.test(event.traceId) ? { traceId: event.traceId } : {}),
      ...(typeof event.spanId === 'string' && /^[0-9a-f]{16}$/i.test(event.spanId) && !/^0+$/.test(event.spanId) ? { spanId: event.spanId } : {})
    }] }] }] };
    try {
      const response = await fetch(endpoint.replace(/\/$/, '') + '/v1/logs', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify(body)
      });
      // Never return collector response bodies or authentication to a visitor.
      return new Response(null, { status: response.ok ? 204 : 502 });
    } catch { return new Response(null, { status: 502 }); }
  };
}
