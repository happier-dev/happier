const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { performance, PerformanceObserver } = require('node:perf_hooks');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { context, trace, metrics, SpanKind, SpanStatusCode } = require('@opentelemetry/api');
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-proto');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { Pool } = require('pg');
const resourceAttributes = (process.env.OTEL_RESOURCE_ATTRIBUTES ?? '').split(',').filter(Boolean);
if (!resourceAttributes.some(value => value.startsWith('service.instance.id='))) resourceAttributes.push(`service.instance.id=${randomUUID()}`);
process.env.OTEL_RESOURCE_ATTRIBUTES = resourceAttributes.join(',');
const resources = Object.fromEntries(resourceAttributes.map(value => {
    const separator = value.indexOf('=');
    return [value.slice(0, separator), decodeURIComponent(value.slice(separator + 1))];
}));
const producer = { serviceName: process.env.OTEL_SERVICE_NAME ?? resources['service.name'] ?? 'unknown_service:node',
    serviceVersion: resources['service.version'], serviceInstanceId: resources['service.instance.id'] };
const sdkVersions = { node: process.versions.node,
    sdkNode: require('@opentelemetry/sdk-node/package.json').version,
    sdkTraceBase: require('@opentelemetry/sdk-trace-base/package.json').version,
    exporter: require('@opentelemetry/exporter-trace-otlp-proto/package.json').version };

const exportStatus = { successfulBatches: 0, failedBatches: 0, exportedRecords: 0 };
// Observe the real export callback without replacing SDK encoding or HTTP.
class ObservedTraceExporter extends OTLPTraceExporter {
    export(records, callback) {
        super.export(records, result => {
            if (result.code === 0) {
                exportStatus.successfulBatches += 1;
                exportStatus.exportedRecords += records.length;
            } else exportStatus.failedBatches += 1;
            callback(result);
        });
    }
}
// SDK exporter configuration comes from the real deployment's OTel bindings.
const processor = new BatchSpanProcessor(new ObservedTraceExporter());
const logProcessor = new BatchLogRecordProcessor(new OTLPLogExporter());
const sdk = new NodeSDK({ spanProcessors: [processor], logRecordProcessors: [logProcessor] });
sdk.start();
const tracer = trace.getTracer('happier-f14-fixture', '1');
const logger = logs.getLogger('happier-f14-fixture', '1');
const meter = metrics.getMeter('happier-f15-fixture', '1');
const duration = meter.createHistogram('http.server.request.duration', { unit: 's' });
const activeRequests = meter.createUpDownCounter('http.server.active_requests', { unit: '{request}' });
meter.createObservableGauge('v8js.memory.heap.used', { unit: 'By' }).addCallback(result => result.observe(process.memoryUsage().heapUsed));
const gcDuration = meter.createHistogram('v8js.gc.duration', { unit: 's' });
const gc = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) gcDuration.record(entry.duration / 1000, { 'v8js.gc.type': String(entry.detail.kind) });
});
gc.observe({ entryTypes: ['gc'] });
const database = new Pool({ connectionString: process.env.DATABASE_URL });
const work = { requests: 0, queries: 0 };
let continueCapture;
const server = createServer(async (request, response) => {
    if (request.url === '/health') { response.end('ready'); return; }
    if (request.url === '/f7/continue' && request.method === 'POST') {
        const resume = continueCapture;
        continueCapture = undefined;
        response.statusCode = resume ? 204 : 409;
        response.end();
        resume?.();
        return;
    }
    if (request.url === '/measurement') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ cpu: process.cpuUsage(), heapUsed: process.memoryUsage().heapUsed, sdkVersions, ...work }));
        return;
    }
    if (request.url === '/export-status') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(exportStatus));
        return;
    }
    if (request.url === '/flush') {
        try {
            await processor.forceFlush();
            await logProcessor.forceFlush();
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(exportStatus));
        } catch {
            response.statusCode = 503;
            response.end('export failed');
        }
        return;
    }
    if (request.url === '/metrics-flush') {
        // Exercise real V8 collection and SDK encoding/HTTP, rather than forging
        // a metric payload. The SDK owns its ordinary export cadence.
        global.gc();
        await nextTurn();
        await nextTurn();
        const provider = metrics.getMeterProvider();
        if (typeof provider.forceFlush !== 'function') {
            response.statusCode = 409;
            response.end('metrics disabled');
            return;
        }
        await provider.forceFlush();
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ enabled: true, heapUsed: process.memoryUsage().heapUsed, sdkVersions, producer }));
        return;
    }
    if (request.url === '/llm') {
        const measured = { 'gen_ai.provider.name': 'openai', 'gen_ai.operation.name': 'chat',
            'gen_ai.request.model': 'dbw-f17-priced', 'gen_ai.response.model': 'dbw-f17-priced',
            'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 50,
            'gen_ai.usage.cache_read.input_tokens': 0, 'gen_ai.usage.cache_creation.input_tokens': 0,
            'gen_ai.usage.reasoning.output_tokens': 0,
            'gen_ai.input.messages': 'f17-private-prompt', 'gen_ai.output.messages': 'f17-private-completion',
            'gen_ai.tool.call.arguments': 'f17-private-tool' };
        const attempts = [measured,
            { ...measured, 'gen_ai.usage.cost': 0.02, 'gen_ai.usage.cost.currency': 'USD' },
            { ...measured, 'gen_ai.usage.cache_read.input_tokens': 20, 'gen_ai.usage.reasoning.output_tokens': 10 },
            { ...measured, 'gen_ai.request.model': 'dbw-f17-unpriced', 'gen_ai.response.model': 'dbw-f17-unpriced',
                'gen_ai.usage.input_tokens': 50, 'gen_ai.usage.output_tokens': 10 }];
        await tracer.startActiveSpan('invoke_agent', { attributes: { 'gen_ai.operation.name': 'invoke_agent' } }, async parent => {
            try {
                for (const attributes of attempts) {
                    tracer.startActiveSpan('chat', { kind: SpanKind.CLIENT, attributes }, span => span.end());
                }
            } finally { parent.end(); }
        });
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ attempts: attempts.length, producer }));
        return;
    }
    const started = performance.now();
    const checkout = request.url.startsWith('/checkout');
    const route = checkout ? '/checkout' : '/orders';
    const pacedCapture = request.url === '/orders?paceCapture=1';
    const pendingCaptureSpans = [];
    const dimensions = { 'http.request.method': 'GET', 'http.route': route };
    activeRequests.add(1, dimensions);
    await tracer.startActiveSpan(`GET ${route}`, {
        kind: SpanKind.SERVER,
        attributes: { ...dimensions, 'url.query': 'secret=must-be-masked' },
    }, async span => {
        try {
            work.requests += 1;
            if (request.url.endsWith('?fail=1')) throw new Error('controlled F15 application failure');
            if (checkout) await database.query('SELECT 1');
            for (const id of checkout ? [] : [1, 2, 3]) {
                // Let the F7 control witness each committed wire query before releasing the next one.
                const captureStep = pacedCapture ? new Promise(resolve => { continueCapture = resolve; }) : null;
                await tracer.startActiveSpan('SELECT order', {
                    kind: SpanKind.CLIENT,
                    attributes: { 'db.system': 'postgresql', 'db.query.text': 'SELECT $1::integer AS id',
                        'db.query.parameter.1': 'must-be-masked' },
                }, async query => {
                    if (pacedCapture) pendingCaptureSpans.push(query);
                    const executionId = randomUUID();
                    const { traceId, spanId, traceFlags } = query.spanContext();
                    const traceparent = `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, '0')}`;
                    query.setAttribute('happier.db.execution_id', executionId);
                    try {
                        // SQLCommenter gives the independent wire recorder the SDK's exact execution identity.
                        await database.query(`SELECT $1::integer AS id /*traceparent='${traceparent}',happier.db.execution_id='${executionId}'*/`, [id]);
                        work.queries += 1;
                    }
                    finally { if (!pacedCapture) query.end(); }
                });
                if (captureStep) await captureStep;
            }
            if (pacedCapture || request.url === '/orders?captureLog=1') {
                logger.emit({ context: context.active(), severityNumber: SeverityNumber.INFO, body: 'Orders query completed' });
            }
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ ok: true }));
        } catch (error) {
            span.recordException(error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            response.statusCode = 500;
            response.end('database unavailable');
        } finally {
            // F7 releases the complete SDK trace only after the three independent wire writes committed.
            for (const query of pendingCaptureSpans) query.end();
            span.setAttribute('http.response.status_code', response.statusCode);
            span.end();
            activeRequests.add(-1, dimensions);
            duration.record((performance.now() - started) / 1000, { ...dimensions, 'http.response.status_code': response.statusCode });
        }
    });
});
server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
async function stop() {
    server.close();
    gc.disconnect();
    await database.end();
    await sdk.shutdown();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
