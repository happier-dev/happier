import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { createCaptureRuntime } from './runtime.js';
import { captureMigrations } from './store/capture.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';
import { createTelemetryAssignments } from './telemetry/assignments.js';

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
            const detail = await f.runtime.store.detail(partition, rows[0]!.id);
            expect(JSON.stringify(detail)).not.toContain('super-secret-token');
            expect(JSON.stringify(detail)).toContain('second line');
        } finally { await receiver.release(); f.close(); }
    });

    it('waits before reading concurrent bodies and acknowledges only committed batches', async () => {
        const f = await fixture(), requests: IncomingMessage[] = [];
        let admitted = () => {};
        const allAdmitted = new Promise<void>(resolve => { admitted = resolve; });
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition }, admit: request => {
            requests.push(request); if (requests.length === 3) admitted(); return f.assignments.admit(request);
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
            responses.push(post(receiver.endpoint, 3), post(receiver.endpoint, 4));
            await allAdmitted;
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(firstAcknowledged).toBe(false);
            expect(requests.slice(1).map(request => request.readableDidRead)).toEqual([false, false]);
            expect(requests.slice(1).some(request => request.readableFlowing === true)).toBe(false);
            held.release();
            for (const response of await Promise.all(responses)) { expect(response.status).toBe(200); expect(await response.json()).toEqual({}); }
            expect(await f.runtime.store.list({ worktree: partition, kind: 'query', limit: 10 })).toHaveLength(4);
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
