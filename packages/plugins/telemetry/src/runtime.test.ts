import { describe, expect, it } from 'vitest';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { createCaptureRuntime } from './runtime.js';
import { captureMigrations } from './store/capture.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';

const partition = 'account/machine/project/worktree';
const traceId = '1234567890abcdef1234567890abcdef';
const spanId = '1234567890abcdef';
const sql = "SELECT name FROM users WHERE password = 'private-password'";
function traceRequest(id = spanId) {
    return { resourceSpans: [{ resource: { attributes: [
        { key: 'service.version', value: { stringValue: 'build-123' } },
        { key: 'deployment.environment.name', value: { stringValue: 'staging' } },
        { key: 'deployment.environment', value: { stringValue: 'legacy-staging' } },
    ] }, scopeSpans: [{ spans: [{ traceId, spanId: id, name: sql, kind: 3,
        startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000000001000000',
        attributes: [{ key: 'db.statement', value: { stringValue: sql } },
            { key: 'db.query.parameter.password', value: { stringValue: 'private-password' } }],
    }] }] }] };
}

async function fixture() {
    const sqlite = createCaptureSqliteFixture();
    for (const migration of captureMigrations) await migration.up(sqlite.db);
    const publications: string[][] = [];
    const runtime = createCaptureRuntime({ database: sqlite.db, publish: keys => publications.push([...keys]),
        normalizeStatement: createPostgresqlObservationNormalizer(),
    });
    return { ...sqlite, runtime, publications };
}

async function post(endpoint: string, signal: 'traces' | 'logs', body: unknown) {
    return fetch(`${endpoint}/v1/${signal}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('capture runtime through real HTTP and SQLite', () => {
    it('ingests canonical masked queries and linked logs, lists summaries without bodies and loads only demanded detail', async () => {
        const f = await fixture();
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition } });
        try {
            const response = await post(receiver.endpoint, 'traces', traceRequest());
            expect(response.status).toBe(200);
            await f.runtime.ingest.settled();
            const beforeRead = f.statements.length;
            const rows = await f.runtime.store.list({ worktree: partition, kind: 'query', limit: 20 });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ source: 'otlp', traceId, spanId, durationMs: 1 });
            expect(rows[0]?.shape).toContain('?');
            expect(f.statements.slice(beforeRead).some(statement => statement.includes('captureDetails'))).toBe(false);
            expect(JSON.stringify(rows)).not.toMatch(/private-password|parameters|maskedSql/);
            const id = rows[0]?.id;
            if (!id) throw new Error('Missing captured query');
            expect(await f.runtime.store.detail(partition, id)).toMatchObject({ span: { serviceVersion: 'build-123', deploymentEnvironmentName: 'staging', deploymentEnvironment: 'legacy-staging', database: { statementKind: 'select', maskedSql: expect.any(String) } } });
            expect(await f.runtime.store.detail('another-account/machine/project/worktree', id)).toBeNull();
            expect(JSON.stringify(await f.runtime.store.detail(partition, id))).not.toContain('private-password');

            const repeated = await post(receiver.endpoint, 'traces', traceRequest());
            expect(repeated.status).toBe(200);
            await f.runtime.ingest.settled();
            expect(f.publications).toEqual([[partition]]);

            const logs = await post(receiver.endpoint, 'logs', { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } },
                { key: 'service.version', value: { stringValue: 'build-log' } },
                { key: 'deployment.environment', value: { stringValue: 'production' } }] }, scopeLogs: [{ logRecords: [{
                traceId, spanId, severityNumber: 13, timeUnixNano: '1700000000001000000', body: { stringValue: 'request completed' },
            }] }] }] });
            expect(logs.status).toBe(200);
            await f.runtime.ingest.settled();
            const logRows = await f.runtime.store.list({ worktree: partition, kind: 'log', limit: 20 });
            expect(logRows).toHaveLength(1);
            expect(logRows[0]).toMatchObject({ traceId, spanId, serviceName: 'api', severityNumber: 13 });
            expect(JSON.stringify(logRows)).not.toContain('request completed');
            expect(await f.runtime.store.detail(partition, logRows[0]!.id)).toMatchObject({ log: {
                serviceVersion: 'build-log', deploymentEnvironmentName: 'production', deploymentEnvironment: 'production',
            } });
            expect(f.publications).toEqual([[partition], [partition]]);
        } finally {
            await receiver.release();
            await f.runtime.ingest.settled();
            f.close();
        }
    });

    it('returns visible partial success while a real write transaction is held, then clears and resumes without a queue', async () => {
        const f = await fixture();
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition } });
        const held = f.holdNextCommit();
        try {
            expect((await post(receiver.endpoint, 'traces', traceRequest())).status).toBe(200);
            await held.entered;
            const dropped = await post(receiver.endpoint, 'traces', traceRequest('2234567890abcdef'));
            expect(dropped.status).toBe(200);
            expect(await dropped.json()).toMatchObject({ partialSuccess: { rejectedSpans: '1' } });
            expect(f.runtime.ingest.coverage()).toMatchObject({ lostObservations: 1, reason: 'store_busy' });
            const clearing = f.runtime.clear(partition);
            held.release();
            await clearing;
            await f.runtime.ingest.settled();
            expect(await f.runtime.store.list({ worktree: partition, limit: 20 })).toEqual([]);
            expect((await post(receiver.endpoint, 'traces', traceRequest('3234567890abcdef'))).status).toBe(200);
            await f.runtime.ingest.settled();
            expect(await f.runtime.store.list({ worktree: partition, limit: 20 })).toEqual([
                expect.objectContaining({ spanId: '3234567890abcdef' }),
            ]);
        } finally {
            held.release();
            await receiver.release();
            await f.runtime.ingest.settled();
            f.close();
        }
    });

    it('publishes coverage loss only for the dropped partition and keeps other partition coverage isolated', async () => {
        const f = await fixture();
        const first = await f.runtime.acquireReceiver({ port: 0, context: { partition } });
        const otherPartition = 'another-account/machine/project/worktree';
        const second = await f.runtime.acquireReceiver({ port: 0, context: { partition: otherPartition } });
        const held = f.holdNextCommit();
        try {
            expect((await post(first.endpoint, 'traces', traceRequest())).status).toBe(200);
            await held.entered;
            const droppedOther = await post(second.endpoint, 'traces', traceRequest('4234567890abcdef'));
            expect(droppedOther.status).toBe(200);
            expect(await droppedOther.json()).toMatchObject({ partialSuccess: { rejectedSpans: '1' } });
            expect(f.runtime.ingest.coverage(otherPartition)).toMatchObject({ lostObservations: 1, reason: 'store_busy' });
            expect(f.runtime.ingest.coverage(partition)).toMatchObject({ lostObservations: 0 });
            expect(f.publications).toEqual([[otherPartition]]);

            const droppedFirst = await post(first.endpoint, 'traces', traceRequest('5234567890abcdef'));
            expect(droppedFirst.status).toBe(200);
            expect(f.runtime.ingest.coverage(partition)).toMatchObject({ lostObservations: 1, reason: 'store_busy' });
            expect(f.runtime.ingest.coverage(otherPartition)).toMatchObject({ lostObservations: 1, reason: 'store_busy' });
            expect(f.runtime.ingest.coverage('unaffected-partition')).toMatchObject({ lostObservations: 0 });
            expect(f.publications).toEqual([[otherPartition], [partition]]);
        } finally {
            held.release();
            await Promise.all([first.release(), second.release()]);
            await f.runtime.ingest.settled();
            f.close();
        }
    });
});
