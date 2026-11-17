import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import protobuf from 'protobufjs';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { createOtlpRequestHandler } from './receiver.js';
import { otlpSchema } from './schema.js';
import type { NormalizedTelemetryBatch } from './types.js';

const traceId = '1234567890abcdef1234567890abcdef';
const spanId = '1234567890abcdef';
const traceRequest = {
    resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] },
        scopeSpans: [{ spans: [{
            traceId, spanId, name: 'GET /users/:id', kind: 2,
            startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000000010000000',
            attributes: [
                { key: 'http.request.method', value: { stringValue: 'GET' } },
                { key: 'http.route', value: { stringValue: '/users/:id' } },
                { key: 'url.path', value: { stringValue: '/users/493' } },
            ],
        }] }],
    }],
};

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
    })));
});

async function listen(handler: ReturnType<typeof createOtlpRequestHandler>) {
    const server = createServer((request, response) => { void handler(request, response); });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    return `http://127.0.0.1:${address.port}`;
}

function receiver(onBatch: (batch: NormalizedTelemetryBatch) => void) {
    return createOtlpRequestHandler({
        context: { worktreeId: 'selected' },
        // No database statement is present in these transport fixtures.
        normalizeStatement: () => { throw new Error('Unexpected database statement'); },
        onBatch: batch => { onBatch(batch); return { accepted: true }; },
    });
}

describe('OTLP HTTP ingress', () => {
    it('accepts bodies at the ingress owner bound and rejects raw or decompressed overflow with permanent HTTP 413', async () => {
        const batches: NormalizedTelemetryBatch[] = [];
        const body = JSON.stringify(traceRequest);
        const url = await listen(createOtlpRequestHandler({ context: null,
            maximumRequestBytes: Buffer.byteLength(body),
            normalizeStatement: () => { throw new Error('No SQL in fixture'); },
            onBatch: batch => { batches.push(batch); return { accepted: true }; },
        }));
        for (const compressed of [false, true]) {
            const headers = { 'content-type': 'application/json', ...(compressed ? { 'content-encoding': 'gzip' } : {}) };
            const valid = await fetch(`${url}/v1/traces`, { method: 'POST', headers, body: compressed ? gzipSync(body) : body });
            expect(valid.status).toBe(200);
            const overflow = `${body} `;
            const rejected = await fetch(`${url}/v1/traces`, { method: 'POST', headers, body: compressed ? gzipSync(overflow) : overflow });
            expect(rejected.status).toBe(413);
            expect(await rejected.json()).toMatchObject({ code: 8 });
        }
        // A valid gzip filename header can overflow the wire bound even when decoded JSON fits.
        const gzip = gzipSync(body);
        const header = Buffer.from(gzip.subarray(0, 10));
        header[3] = (header[3] ?? 0) | 8;
        const oversizedWire = Buffer.concat([header, Buffer.alloc(Buffer.byteLength(body), 97), Buffer.from([0]), gzip.subarray(10)]);
        const wireRejected = await fetch(`${url}/v1/traces`, { method: 'POST', headers: {
            'content-type': 'application/json', 'content-encoding': 'gzip',
        }, body: oversizedWire });
        expect(wireRejected.status).toBe(413);
        expect(batches).toHaveLength(2);
    });

    it('retains timing and error classification for unparseable SQL without exporting its text', async () => {
        const batches: NormalizedTelemetryBatch[] = [];
        const url = await listen(createOtlpRequestHandler({ context: null,
            normalizeStatement: createPostgresqlObservationNormalizer(),
            onBatch: batch => { batches.push(batch); return { accepted: true }; },
        }));
        const sql = "SELECT 'unterminated-private-value";
        const response = await fetch(`${url}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId, spanId, kind: 3, name: sql,
                startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000000003000000', status: { code: 2 },
                attributes: [{ key: 'db.statement', value: { stringValue: sql } }],
            }] }] }] }),
        });
        expect(response.status).toBe(200);
        expect(batches[0]?.spans).toEqual([expect.objectContaining({ name: 'database', durationMs: 3, status: 'error',
            database: expect.objectContaining({ shape: null, maskedSql: null, statementKind: 'unknown' }),
        })]);
        expect(JSON.stringify(batches)).not.toContain('unterminated-private-value');
    });

    it('uses the real canonical SQL normalizer and never forwards raw SQL through the database span name or attributes', async () => {
        const batches: NormalizedTelemetryBatch[] = [];
        const url = await listen(createOtlpRequestHandler({ context: null,
            normalizeStatement: createPostgresqlObservationNormalizer(),
            onBatch: batch => { batches.push(batch); return { accepted: true }; },
        }));
        const sql = "SELECT * FROM users WHERE password = 'private-password'";
        const request = { resourceSpans: [{ resource: { attributes: [
            { key: 'db.connection_string', value: { stringValue: 'postgres://user:private-password@localhost/db' } },
        ] }, scopeSpans: [{ spans: [{
            traceId, spanId, name: sql, kind: 3,
            attributes: [
                { key: 'db.statement', value: { stringValue: sql } },
                { key: 'db.query.parameter.password', value: { stringValue: 'private-password' } },
            ],
        }] }] }] };
        const response = await fetch(`${url}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
        expect(response.status).toBe(200);
        expect(batches[0]?.spans[0]?.database?.shape).toContain('?');
        expect(batches[0]?.spans[0]?.name).toBe(batches[0]?.spans[0]?.database?.shape);
        expect(JSON.stringify(batches)).not.toContain('private-password');
        expect(JSON.stringify(batches)).not.toContain('postgres://');
    });

    it('returns permanent protobuf decoding errors as google.rpc.Status and distinguishes retryable ingestion failure', async () => {
        const url = await listen(createOtlpRequestHandler({
            context: null,
            normalizeStatement: () => { throw new Error('No database statement expected'); },
            onBatch: () => ({ accepted: false, retryable: true, message: 'Store unavailable' }),
        }));
        const malformed = await fetch(`${url}/v1/traces`, { method: 'POST',
            headers: { 'content-type': 'application/x-protobuf' }, body: Buffer.from([255]),
        });
        expect(malformed.status).toBe(400);
        expect(malformed.headers.get('content-type')).toBe('application/x-protobuf');
        const status = protobuf.Root.fromJSON(otlpSchema).lookupType('google.rpc.Status');
        expect(status.toObject(status.decode(new Uint8Array(await malformed.arrayBuffer())))).toMatchObject({ code: 3 });
        const unavailable = await fetch(`${url}/v1/logs`, { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: '{}',
        });
        expect(unavailable.status).toBe(503);
        expect(await unavailable.json()).toMatchObject({ code: 14 });
    });

    it('normalizes protobuf and compressed protobuf equivalently to JSON with the generated upstream schema', async () => {
        const batches: NormalizedTelemetryBatch[] = [];
        const url = await listen(receiver(batch => batches.push(batch)));
        const type = protobuf.Root.fromJSON(otlpSchema).lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest');
        const message = type.fromObject({ resourceSpans: traceRequest.resourceSpans.map(resource => ({
            ...resource, scopeSpans: resource.scopeSpans.map(scope => ({
                ...scope, spans: scope.spans.map(span => ({ ...span, traceId: Buffer.from(span.traceId, 'hex'), spanId: Buffer.from(span.spanId, 'hex') })),
            })),
        })) });
        const encoded = type.encode(message).finish();
        for (const compressed of [false, true]) {
            const response = await fetch(`${url}/v1/traces`, { method: 'POST',
                headers: { 'content-type': 'application/x-protobuf', ...(compressed ? { 'content-encoding': 'gzip' } : {}) },
                body: Buffer.from(compressed ? gzipSync(encoded) : encoded),
            });
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('application/x-protobuf');
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array());
        }
        const json = await fetch(`${url}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(traceRequest) });
        expect(json.status).toBe(200);
        expect(batches[0]).toEqual(batches[1]);
        expect(batches[1]).toEqual(batches[2]);
    });

    it('accepts JSON and gzip through the same real HTTP receiver and keeps supplied trace/route identity', async () => {
        const batches: NormalizedTelemetryBatch[] = [];
        const url = await listen(receiver(batch => batches.push(batch)));
        for (const compressed of [false, true]) {
            const body = JSON.stringify(traceRequest);
            const result = await fetch(`${url}/v1/traces`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...(compressed ? { 'content-encoding': 'gzip' } : {}) },
                body: compressed ? gzipSync(body) : body,
            });
            expect(result.status).toBe(200);
            expect(await result.json()).toEqual({});
        }
        expect(batches).toHaveLength(2);
        expect(batches[0]).toEqual(batches[1]);
        expect(batches[0]?.spans[0]).toMatchObject({
            traceId, spanId, serviceName: 'api', durationMs: 10,
            endpoint: { method: 'GET', route: '/users/:id' },
        });
        expect(JSON.stringify(batches)).not.toContain('/users/493');
    });

    it('preserves structured log bodies and links, reports record rejection as permanent partial success', async () => {
        const batches: NormalizedTelemetryBatch[] = [];
        const url = await listen(receiver(batch => batches.push(batch)));
        const body = { resourceLogs: [{ scopeLogs: [{ logRecords: [
                { traceId, spanId, timeUnixNano: '1700000000000000000', severityNumber: 17,
                    body: { kvlistValue: { values: [
                        { key: 'failed', value: { boolValue: true } },
                        { key: 'ratio', value: { doubleValue: 'NaN' } },
                        { key: 'count', value: { intValue: '9223372036854775807' } },
                        { key: 'bytes', value: { bytesValue: 'AQI=' } },
                    ] } } },
                { traceId: 'invalid', spanId, body: { stringValue: 'invalid record' } },
        ] }] }] };
        const root = protobuf.Root.fromJSON(otlpSchema);
        const requestType = root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest');
        const responseType = root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse');
        for (const json of [true, false]) {
            const proto = { resourceLogs: body.resourceLogs.map(resource => ({ scopeLogs: resource.scopeLogs.map(scope => ({
                logRecords: scope.logRecords.map(item => ({ ...item,
                    traceId: item.traceId === 'invalid' ? Buffer.from([1]) : Buffer.from(item.traceId, 'hex'),
                    spanId: Buffer.from(item.spanId, 'hex'),
                })),
            })) })) };
            const result = await fetch(`${url}/v1/logs`, { method: 'POST',
                headers: { 'content-type': json ? 'application/json' : 'application/x-protobuf' },
                body: json ? JSON.stringify(body) : Buffer.from(requestType.encode(requestType.fromObject(proto)).finish()),
            });
            expect(result.status).toBe(200);
            const partial = json ? await result.json() : responseType.toObject(responseType.decode(new Uint8Array(await result.arrayBuffer())), { longs: String });
            expect(partial).toMatchObject({ partialSuccess: { rejectedLogRecords: '1' } });
        }
        expect(batches[0]?.logs).toEqual([expect.objectContaining({ traceId, spanId,
            body: { failed: true, ratio: 'NaN', count: '9223372036854775807', bytes: 'AQI=' }, severityNumber: 17 })]);
        expect(batches[0]).toEqual(batches[1]);
    });

    it('preserves valid uint64 timestamp precision and rejects out-of-range timestamps as partial records', async () => {
        const batches: NormalizedTelemetryBatch[] = [];
        const url = await listen(receiver(batch => batches.push(batch)));
        const valid = { traceId, spanId, startTimeUnixNano: '18446744073709551614', endTimeUnixNano: '18446744073709551615' };
        const response = await fetch(`${url}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [valid, { ...valid, endTimeUnixNano: '18446744073709551616' }] }] }] }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ partialSuccess: { rejectedSpans: '1' } });
        expect(batches[0]?.spans).toEqual([expect.objectContaining({
            startTimeUnixNano: '18446744073709551614', endTimeUnixNano: '18446744073709551615', durationMs: 0.000001,
        })]);
    });

    it('does not invent endpoints from raw paths, and rejects malformed envelopes without ingestion', async () => {
        const batches: NormalizedTelemetryBatch[] = [];
        const url = await listen(receiver(batch => batches.push(batch)));
        const rawOnly = structuredClone(traceRequest);
        const span = rawOnly.resourceSpans[0]?.scopeSpans[0]?.spans[0];
        if (!span) throw new Error('Missing fixture span');
        span.attributes = span.attributes.filter(attribute => attribute.key !== 'http.route');
        const accepted = await fetch(`${url}/v1/traces`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rawOnly),
        });
        expect(accepted.status).toBe(200);
        expect(batches[0]?.spans[0]?.endpoint).toBeUndefined();
        for (const body of ['{', '{"resourceSpans":{}}']) {
            const rejected = await fetch(`${url}/v1/traces`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body,
            });
            expect(rejected.status).toBe(400);
        }
        expect(batches).toHaveLength(1);
    });
});
