import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { createCaptureRuntime } from './runtime.js';
import { captureMigrations } from './store/capture.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';
import { createTelemetryAssignments } from './telemetry/assignments.js';
import { createCaptureSelectedSourceReaders } from './actions.js';
import { DatabaseCaptureQueryGetResultV1Schema } from '@happier-dev/database-protocol';

const partition = 'environment:production';
const token = 'fixture-exporter-token';
function body(index: number) { return { resourceSpans: [{ scopeSpans: [{ spans: [{
    traceId: '1234567890abcdef1234567890abcdef', spanId: String(index).padStart(16, '0'),
    kind: 3, name: 'database', startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000000001000000',
    attributes: [{ key: 'db.statement', value: { stringValue: 'SELECT 1' } }],
}] }] }] }; }
async function fixture() {
    const f = createCaptureSqliteFixture();
    for (const migration of captureMigrations) await migration.up(f.db);
    const runtime = createCaptureRuntime({ database: f.db, normalizeStatement: createPostgresqlObservationNormalizer(), publish: () => {} });
    const assignments = createTelemetryAssignments();
    assignments.replace([{ environmentId: 'production', tokenHash: createHash('sha256').update(token).digest('hex') }]);
    return { ...f, runtime, assignments };
}
function post(endpoint: string, index: number) {
    return fetch(endpoint + '/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body(index)) });
}

describe('authenticated collector writer admission through HTTP and SQLite', () => {
    it('wakes finding demand only when a trace changes in the committed capture store', async () => {
        const f = await fixture();
        let wakes = 0;
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition },
            admit: request => f.assignments.admit(request), onTraceBatchCommitted: () => { wakes++; } });
        try {
            expect((await post(receiver.endpoint, 1)).status).toBe(200);
            expect(wakes).toBe(1);
            expect((await post(receiver.endpoint, 1)).status).toBe(200);
            expect.soft(wakes).toBe(1);
            expect((await post(receiver.endpoint, 2)).status).toBe(200);
            expect(wakes).toBe(2);
        } finally { await receiver.release(); f.close(); }
    });

    it('reports the latest retained sample for each Environment capability independently', async () => {
        const f = await fixture();
        f.assignments.replace([{ environmentId: 'production', tokenHash: createHash('sha256').update(token).digest('hex'),
            capabilities: { metrics: true, appLlmCost: true, exceptions: true } }]);
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition }, admit: request => f.assignments.admit(request) });
        const source = { kind: 'environment', serverId: 'home', environmentId: 'production' } as const;
        const status = createCaptureSelectedSourceReaders({ source, partition, runtime: f.runtime }).captureStatus;
        const postSignal = (signal: 'metrics' | 'traces', payload: unknown) => fetch(receiver.endpoint + '/v1/' + signal, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
            body: JSON.stringify(payload),
        });
        try {
            expect((await post(receiver.endpoint, 1)).status).toBe(200);
            expect(await status({ source })).toMatchObject({ ok: true, capabilityLastSampleAt: {
                metrics: null, appLlmCost: null, exceptions: null,
            } });
            expect((await postSignal('metrics', { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'runtime.heap',
                gauge: { dataPoints: ['1700000020000000000', '1700000010000000000'].map(timeUnixNano => ({ timeUnixNano, asInt: '42' })) },
            }] }] }] })).status).toBe(200);
            expect((await postSignal('traces', { resourceSpans: [{ scopeSpans: [{ spans: [{
                traceId: '1234567890abcdef1234567890abcdef', spanId: '0000000000000002',
                kind: 3, name: 'chat', startTimeUnixNano: '1700000030000000000', endTimeUnixNano: '1700000030001000000',
                attributes: [{ key: 'gen_ai.request.model', value: { stringValue: 'fixture-model' } },
                    { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
                    { key: 'gen_ai.usage.input_tokens', value: { intValue: '8' } }],
                events: [{ timeUnixNano: '1700000030000500000', name: 'exception',
                    attributes: [{ key: 'exception.type', value: { stringValue: 'FixtureError' } }] }],
            }] }] }] })).status).toBe(200);
            expect(await status({ source })).toMatchObject({ ok: true, capabilityLastSampleAt: {
                metrics: 1700000020000, appLlmCost: 1700000030000, exceptions: 1700000030000,
            } });
        } finally {
            await receiver.release();
            f.close();
        }
    });

    it('reports the selected Environment’s latest accepted observation through capture status', async () => {
        const f = await fixture();
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition }, admit: request => f.assignments.admit(request) });
        const source = { kind: 'environment', serverId: 'home', environmentId: 'production' } as const;
        const status = createCaptureSelectedSourceReaders({ source, partition, runtime: f.runtime }).captureStatus;
        try {
            f.runtime.ingest.recordLoss(partition, 'invalid_telemetry');
            await f.runtime.ingest.write([{ id: 'other', worktree: 'environment:other', kind: 'span', source: 'otlp', at: 1700000000001 }]);
            expect(await status({ source })).toMatchObject({ ok: true, lastReceivedAt: null });
            expect((await post(receiver.endpoint, 1)).status).toBe(200);
            expect(await status({ source })).toMatchObject({ ok: true, lastReceivedAt: 1700000000000 });
            await f.runtime.clear(partition);
            expect(await status({ source })).toMatchObject({ ok: true, lastReceivedAt: null });
        } finally { await receiver.release(); f.close(); }
    });

    it('looks up only retained App LLM calls and opens the selected call’s exact trace', async () => {
        const f = await fixture();
        const source = { kind: 'environment', serverId: 'home', environmentId: 'production' } as const;
        const reads = createCaptureSelectedSourceReaders({ source, partition, runtime: f.runtime });
        const tokens = { input: 12, output: 3, total: null, reasoning: null, cacheRead: null, cacheWrite: null };
        const genAi = { provider: 'example', requestedModel: null, modelId: 'test-model', operation: 'chat',
            tokens, tokenCategories: null, reportedCost: { amount: 0.002, currency: 'USD' } };
        const span = { worktree: partition, kind: 'span', source: 'otlp', spanKind: 2,
            at: 1000, serviceName: 'api', serviceVersion: 'v2' } as const;
        try {
            await f.runtime.ingest.write([
                { ...span, id: 'first', traceId: 'trace-a', genAi },
                { ...span, id: 'selected', at: 1001, traceId: 'trace-b', genAi },
                { ...span, id: 'ordinary', at: 1002, traceId: 'ordinary' },
                { ...span, id: 'neighbor', traceId: 'wrong-env', worktree: 'environment:neighbor', genAi },
                { ...span, id: 'older-release', traceId: 'wrong-version', serviceVersion: 'v1', genAi },
                { ...span, id: 'outside-window', at: 2000, traceId: 'wrong-window', genAi },
            ]);
            const input = { source, page: { limit: 2 }, since: 1000, until: 2000,
                appLlmCalls: { serviceName: 'api', serviceVersion: 'v2' } };
            const listed = await reads.listCapturedTraces(input);
            expect(listed.items.map(call => [call.id, call.traceId])).toEqual([['selected', 'trace-b'], ['first', 'trace-a']]);
            expect(listed.items[0]).toMatchObject({ serviceVersion: 'v2', genAi });
            const selected = listed.items.find(call => call.id === 'selected');
            if (!selected?.traceId) throw new Error('Expected the selected retained call’s trace');
            expect(await reads.getCapturedTrace({ source, traceId: selected.traceId, page: { limit: 5 } })).toMatchObject({
                traceId: 'trace-b', summaries: [{ id: 'selected' }],
            });
        } finally { f.close(); }
    });

    it('returns redacted log bodies at rest from one authenticated batch and one list query', async () => {
        const f = await fixture();
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition }, admit: request => f.assignments.admit(request) });
        try {
            const response = await fetch(receiver.endpoint + '/v1/logs', { method: 'POST', headers: {
                'content-type': 'application/json', authorization: 'Bearer ' + token,
            }, body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: Array.from({ length: 5 }, (_, index) => ({
                timeUnixNano: String(index + 1), body: { stringValue: `request-${index} Authorization: Bearer super-secret-token\nsecond line` },
            })) }] }] }) });
            expect(response.status).toBe(200);
            f.statements.length = 0;
            const rows = await f.runtime.store.list({ worktree: partition, kind: 'log', limit: 10 });
            expect(rows).toHaveLength(5);
            expect(f.statements).toHaveLength(1);
            for (const row of rows) {
                expect(row.bodyPrefix).toContain('request-');
                expect(row.bodyPrefixTruncated).toBe(true);
                expect(row.bodyPrefix).not.toContain('super-secret-token');
                expect(row.bodyPrefix).not.toContain('second line');
            }
            const source = { kind: 'environment', serverId: 'home', environmentId: 'production' } as const;
            const reads = createCaptureSelectedSourceReaders({ source, partition, runtime: f.runtime });
            const detail = DatabaseCaptureQueryGetResultV1Schema.parse(await reads.getCapturedQuery({ source, id: rows[0]!.id }));
            expect(detail).toMatchObject({ ok: true, detail: { secretMasking: 'incomplete' } });
            expect(JSON.stringify(detail)).not.toContain('super-secret-token');
            expect(JSON.stringify(detail)).toContain('second line');
        } finally { await receiver.release(); f.close(); }
    });

    it('waits before reading concurrent bodies and acknowledges only committed batches', async () => {
        const f = await fixture(), requests: IncomingMessage[] = [];
        const exporterCount = 20;
        let admitted = () => {};
        const allAdmitted = new Promise<void>(resolve => { admitted = resolve; });
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition }, admit: request => {
            requests.push(request); if (requests.length === exporterCount) admitted(); return f.assignments.admit(request);
        } });
        let held: ReturnType<typeof f.holdNextCommit> | undefined;
        const responses: Promise<Response>[] = [];
        try {
            expect((await post(receiver.endpoint, 1)).status).toBe(200);
            expect(await f.runtime.store.list({ worktree: partition, kind: 'query', limit: 10 })).toHaveLength(1);
            requests.length = 0;
            held = f.holdNextCommit();
            let firstAcknowledged = false;
            responses.push(post(receiver.endpoint, 2).then(response => { firstAcknowledged = true; return response; }));
            await held.entered;
            for (let index = 3; index < exporterCount + 2; index++) responses.push(post(receiver.endpoint, index));
            await allAdmitted;
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(firstAcknowledged).toBe(false);
            expect(requests.slice(1).every(request => !request.readableDidRead)).toBe(true);
            expect(requests.slice(1).some(request => request.readableFlowing === true)).toBe(false);
            held.release();
            for (const response of await Promise.all(responses)) { expect(response.status).toBe(200); expect(await response.json()).toEqual({}); }
            expect(await f.runtime.store.list({ worktree: partition, kind: 'query', limit: exporterCount + 1 })).toHaveLength(exporterCount + 1);
            expect(f.runtime.ingest.coverage(partition)).toEqual({ lostObservations: 0, reason: null });
        } finally { held?.release(); await Promise.allSettled(responses); await receiver.release(); await f.runtime.ingest.settled(); f.close(); }
    });

    it('releases the writer when an authenticated exporter aborts while waiting', async () => {
        const f = await fixture();
        let admitted = () => {}, waiting: IncomingMessage | undefined;
        const queued = new Promise<void>(resolve => { admitted = resolve; });
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition }, admit: request => {
            if (waiting === undefined) waiting = request;
            else { waiting = request; admitted(); }
            return f.assignments.admit(request);
        } });
        const held = f.holdNextCommit();
        const first = post(receiver.endpoint, 1);
        await held.entered;
        const payload = JSON.stringify(body(2));
        const client = httpRequest(receiver.endpoint + '/v1/traces', { method: 'POST', headers: {
            'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: 'Bearer ' + token,
        } });
        client.on('error', () => {});
        client.write(payload.slice(0, 10));
        try {
            await queued;
            if (!waiting) throw new Error('Missing queued request');
            const aborted = new Promise<void>(resolve => waiting?.once('aborted', resolve));
            client.destroy();
            await aborted;
            expect(waiting.aborted).toBe(true);
            held.release();
            expect((await first).status).toBe(200);
            await new Promise<void>(resolve => setImmediate(resolve));
            let settled = false;
            void f.runtime.ingest.settled().then(() => { settled = true; });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(settled).toBe(true);
            expect((await post(receiver.endpoint, 3)).status).toBe(200);
        } finally { held.release(); client.destroy(); await first; await receiver.release(); f.close(); }
    });

    it('recovers authenticated exports after successful Clear frees an exhausted allocation', async () => {
        const f = await fixture();
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition }, admit: request => f.assignments.admit(request) });
        try {
            expect((await post(receiver.endpoint, 1)).status).toBe(200);
            f.failWrites('daemon_database_quota_exceeded');
            const failed = await post(receiver.endpoint, 2);
            expect(failed.status).toBe(507);
            expect(await failed.json()).toMatchObject({ code: 8, message: 'collector storage full' });
            expect(f.runtime.ingest.coverage(partition)).toEqual({ lostObservations: 1, reason: 'daemon_database_quota_exceeded' });
            f.failWrites(null);
            await f.runtime.clear(partition);
            expect(f.runtime.ingest.coverage(partition)).toEqual({ lostObservations: 0, reason: null });
            expect((await post(receiver.endpoint, 3)).status).toBe(200);
            expect((await post(receiver.endpoint, 4)).status).toBe(200);
            expect((await f.runtime.store.list({ worktree: partition, kind: 'query', limit: 10 })).map(row => row.spanId).sort()).toEqual(['0000000000000003', '0000000000000004']);
        } finally { await receiver.release(); await f.runtime.ingest.settled(); f.close(); }
    });

    it('returns 503 only after the actual persistent store reports a failure', async () => {
        const f = await fixture();
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition }, admit: request => f.assignments.admit(request) });
        try {
            expect((await post(receiver.endpoint, 1)).status).toBe(200);
            f.failWrites('SQLITE_IOERR');
            expect((await post(receiver.endpoint, 2)).status).toBe(503);
            expect(f.runtime.ingest.coverage(partition)).toEqual({ lostObservations: 1, reason: 'SQLITE_IOERR' });
        } finally { await receiver.release(); await f.runtime.ingest.settled(); f.close(); }
    });
});
