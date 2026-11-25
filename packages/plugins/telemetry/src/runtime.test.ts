import { describe, expect, it } from 'vitest';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { createCaptureRuntime } from './runtime.js';
import { captureMigrations } from './store/capture.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';

import { setTimeout as delay } from 'node:timers/promises';

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
    it('lists masked query summaries and first-line log previews and returns full detail on demand', async () => {
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

            const logBody = 'request completed\nrequest detail';
            const logs = await post(receiver.endpoint, 'logs', { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } },
                { key: 'service.version', value: { stringValue: 'build-log' } },
                { key: 'deployment.environment', value: { stringValue: 'production' } }] }, scopeLogs: [{ logRecords: [{
                traceId, spanId, severityNumber: 13, timeUnixNano: '1700000000001000000', body: { stringValue: logBody },
            }] }] }] });
            expect(logs.status).toBe(200);
            await f.runtime.ingest.settled();
            const logRows = await f.runtime.store.list({ worktree: partition, kind: 'log', limit: 20 });
            expect(logRows).toHaveLength(1);
            expect(logRows[0]).toMatchObject({ traceId, spanId, serviceName: 'api', severityNumber: 13,
                bodyPrefix: 'request completed', bodyPrefixTruncated: true });
            expect(JSON.stringify(logRows)).not.toContain('request detail');
            expect(await f.runtime.store.detail(partition, logRows[0]!.id)).toMatchObject({ log: {
                serviceVersion: 'build-log', deploymentEnvironmentName: 'production', deploymentEnvironment: 'production', body: logBody,
            } });
            expect(f.publications).toEqual([[partition], [partition]]);
        } finally {
            await receiver.release();
            await f.runtime.ingest.settled();
            f.close();
        }
    });

    it('keeps sequential log exports when a store commit spans the export interval', async () => {
        const f = await fixture();
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition } });
        const held = f.holdNextCommit();
        const count = 8;
        const statuses: number[] = [];
        const release = held.entered.then(() => delay(1_000)).then(held.release);
        try {
            for (let index = 0; index < count; index++) {
                const response = await post(receiver.endpoint, 'logs', { resourceLogs: [{
                    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] },
                    scopeLogs: [{ logRecords: [{ severityNumber: 9,
                        timeUnixNano: String(1_700_000_000_000_000_000n + BigInt(index) * 1_000_000n),
                        body: { stringValue: `request ${index} completed` } }] }],
                }] });
                statuses.push(response.status);
                await response.json();
                if (index + 1 < count) await delay(200);
            }
            await f.runtime.ingest.settled();
            expect(statuses).toEqual(Array(count).fill(200));
            expect(await f.runtime.store.list({ worktree: partition, kind: 'log', limit: count })).toHaveLength(count);
            expect(f.publications).toEqual(Array.from({ length: count }, () => [partition]));
        } finally {
            held.release();
            await receiver.release();
            await release;
            await f.runtime.ingest.settled();
            f.close();
        }
    });

    it('retains concurrent trace and log exports without counting the retryable batch as lost', async () => {
        const f = await fixture();
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition } });
        const held = f.holdNextCommit();
        try {
            const traces = () => post(receiver.endpoint, 'traces', traceRequest());
            const logs = () => post(receiver.endpoint, 'logs', { resourceLogs: [{ scopeLogs: [{ logRecords: [{
                traceId, spanId, timeUnixNano: '1700000000001000000', body: { stringValue: 'request completed' },
            }] }] }] });
            const tracesPending = traces();
            await held.entered;
            const busy = await logs();
            expect(busy.status).toBe(503);
            expect(await busy.json()).toMatchObject({ code: 14, message: expect.any(String) });
            expect(f.runtime.ingest.coverage(partition)).toEqual({ lostObservations: 0, reason: null });
            expect(f.publications).toEqual([]);

            held.release();
            const accepted = await tracesPending;
            expect(accepted.status).toBe(200);
            expect(await accepted.json()).toEqual({});
            const replay = await logs();
            expect(replay.status).toBe(200);
            expect(await replay.json()).toEqual({});
            await f.runtime.ingest.settled();
            expect(await f.runtime.store.list({ worktree: partition, kind: 'query', limit: 10 })).toEqual([
                expect.objectContaining({ traceId, spanId }),
            ]);
            expect(await f.runtime.store.list({ worktree: partition, kind: 'log', limit: 10 })).toEqual([
                expect.objectContaining({ traceId, spanId, bodyPrefix: 'request completed' }),
            ]);
            expect(f.runtime.ingest.coverage(partition)).toEqual({ lostObservations: 0, reason: null });
            expect(f.publications).toEqual([[partition], [partition]]);
        } finally {
            held.release();
            await receiver.release();
            await f.runtime.ingest.settled();
            f.close();
        }
    });

    it('counts observations refused by degraded storage, then clears and resumes', async () => {
        const f = await fixture();
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition } });
        try {
            f.failWrites('daemon_database_quota_exceeded');
            const failedCommit = await post(receiver.endpoint, 'traces', traceRequest());
            expect(failedCommit.status).toBe(200);
            expect(await failedCommit.json()).toMatchObject({ partialSuccess: { rejectedSpans: '1' } });
            expect(f.runtime.ingest.coverage(partition)).toEqual({ lostObservations: 1, reason: 'daemon_database_quota_exceeded' });
            const dropped = await post(receiver.endpoint, 'traces', traceRequest('2234567890abcdef'));
            expect(dropped.status).toBe(200);
            expect(await dropped.json()).toMatchObject({ partialSuccess: { rejectedSpans: '1' } });
            expect(f.runtime.ingest.coverage(partition)).toEqual({ lostObservations: 2, reason: 'daemon_database_quota_exceeded' });

            f.failWrites(null);
            await f.runtime.clear(partition);
            expect(f.runtime.ingest.coverage(partition)).toEqual({ lostObservations: 0, reason: null });
            expect((await post(receiver.endpoint, 'traces', traceRequest('3234567890abcdef'))).status).toBe(200);
            await f.runtime.ingest.settled();
            expect(await f.runtime.store.list({ worktree: partition, limit: 20 })).toEqual([
                expect.objectContaining({ spanId: '3234567890abcdef' }),
            ]);
        } finally {
            await receiver.release();
            await f.runtime.ingest.settled();
            f.close();
        }
    });

    it('counts wire observations per partition while an OTLP write is held', async () => {
        const f = await fixture();
        const first = await f.runtime.acquireReceiver({ port: 0, context: { partition } });
        const otherPartition = 'another-account/machine/project/worktree';
        const observeTransaction = (worktree: string) => f.runtime.observeWire({
            id: 'wire-transaction', kind: 'transaction', connectionId: 'wire', startedAt: 1,
            durationMs: 1, outcome: 'commit', executionIds: [],
        }, { partition: worktree });
        const held = f.holdNextCommit();
        try {
            const tracesPending = post(first.endpoint, 'traces', traceRequest());
            await held.entered;
            observeTransaction(otherPartition);
            expect(f.runtime.ingest.coverage(otherPartition)).toMatchObject({ lostObservations: 1, reason: 'store_busy' });
            expect(f.runtime.ingest.coverage(partition)).toMatchObject({ lostObservations: 0 });
            expect(f.publications).toEqual([[otherPartition]]);

            observeTransaction(partition);
            expect(f.runtime.ingest.coverage(partition)).toMatchObject({ lostObservations: 1, reason: 'store_busy' });
            expect(f.runtime.ingest.coverage(otherPartition)).toMatchObject({ lostObservations: 1, reason: 'store_busy' });
            expect(f.runtime.ingest.coverage('unaffected-partition')).toMatchObject({ lostObservations: 0 });
            expect(f.publications).toEqual([[otherPartition], [partition]]);
            held.release();
            expect((await tracesPending).status).toBe(200);
        } finally {
            held.release();
            await first.release();
            await f.runtime.ingest.settled();
            f.close();
        }
    });
});
