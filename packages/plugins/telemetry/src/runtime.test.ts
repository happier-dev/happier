import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import protobuf from 'protobufjs';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { createCanonicalJsonSigningInput, type PluginWorktreeDatabaseMemberV1 } from '@happier-dev/plugin-sdk';
import { projectAutomationDatabaseFindingSubjectV1 } from '@happier-dev/plugin-sdk/events';
import { otlpSchema } from './otlp/schema.js';
import { createCaptureRuntime } from './runtime.js';
import { captureMigrations } from './store/capture.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';
import { createDatabaseFindingPublisher, selectWorktreeFindingSubjects } from './telemetry/databaseFindings.js';

import { setTimeout as delay } from 'node:timers/promises';

const partition = 'account/machine/project/worktree';
const traceId = '1234567890abcdef1234567890abcdef';
const spanId = '1234567890abcdef';
const sql = "SELECT name FROM users WHERE password = 'private-password'";
const worktreeSourceScope = { serverId: 'home', machineId: 'machine' };
const worktreeSource = { kind: 'worktree', ...worktreeSourceScope, projectId: 'project', workspaceId: 'worktree' } as const;
const worktreeDatabaseMember = { kind: 'worktree', accountId: 'account', installationId: 'install', projectKey: 'project',
    workspace: { ...worktreeSourceScope, workspaceId: 'worktree', rootPath: '/worktree' },
    source: { kind: 'service', serviceId: 'api', variable: 'DATABASE_URL' },
} satisfies PluginWorktreeDatabaseMemberV1;
const worktreeDatabaseMemberKey = createCanonicalJsonSigningInput(worktreeDatabaseMember);
const worktreeFindingSubjects = new Map([[worktreeDatabaseMemberKey,
    projectAutomationDatabaseFindingSubjectV1(worktreeSource.serverId, worktreeDatabaseMember)]]);
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

async function post(endpoint: string, signal: 'traces' | 'logs' | 'metrics', body: unknown) {
    return fetch(`${endpoint}/v1/${signal}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('capture runtime through real HTTP and SQLite', () => {
    it('retains the same log identity and attributes from JSON and protobuf on one receiver', async () => {
        const f = await fixture();
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition } });
        const uid = 'capture-parity-log';
        const entry = { traceId, spanId, timeUnixNano: '1700000000000000000',
            attributes: [{ key: 'log.record.uid', value: { stringValue: uid } }] };
        const envelope = (ids: { traceId: string | Buffer; spanId: string | Buffer }, bytesValue: string) =>
            ({ resourceLogs: [{
                resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] },
                scopeLogs: [{ logRecords: [{ ...entry, ...ids, body: { kvlistValue: { values: [
                    { key: 'payload', value: { bytesValue } },
                    { key: 'count', value: { intValue: '9223372036854775807' } },
                ] } } }] }],
            }] });
        const type = protobuf.Root.fromJSON(otlpSchema).lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest');
        const jsonBody = envelope({ traceId, spanId }, '-_8');
        const binary = type.encode(type.fromObject(envelope({
            traceId: Buffer.from(traceId, 'hex'), spanId: Buffer.from(spanId, 'hex'),
        }, '+/8='))).finish();
        const read = async () => {
            const rows = await f.runtime.store.list({ worktree: partition, kind: 'log', limit: 10 });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ traceId, spanId, serviceName: 'api' });
            return { row: rows[0], detail: await f.runtime.store.detail(partition, rows[0]!.id) };
        };
        try {
            const json = await post(receiver.endpoint, 'logs', jsonBody);
            expect(json.status).toBe(200);
            expect(await json.json()).toEqual({});
            const jsonCapture = await read();
            await f.runtime.clear(partition);

            const proto = await fetch(`${receiver.endpoint}/v1/logs`, { method: 'POST',
                headers: { 'content-type': 'application/x-protobuf' }, body: Buffer.from(binary) });
            expect(proto.status).toBe(200);
            expect((await proto.arrayBuffer()).byteLength).toBe(0);
            const protobufCapture = await read();
            expect.soft(jsonCapture.detail).toEqual(protobufCapture.detail);
            expect.soft(jsonCapture.row).toEqual(protobufCapture.row);

            expect((await post(receiver.endpoint, 'logs', jsonBody)).status).toBe(200);
            expect(await read()).toEqual(protobufCapture);
        } finally {
            await receiver.release();
            await f.runtime.ingest.settled();
            f.close();
        }
    });

    it('clears stored and pending capture after physical Worktree removal without changing neighboring coverage', async () => {
        const f = await fixture();
        const physicalRootIdentity = await mkdtemp(join(tmpdir(), 'happier-capture-removed-'));
        const pendingPartition = 'account/machine/project/pending';
        const neighbor = 'account/machine/project/neighbor';
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition, physicalRootIdentity } });
        const readSelected = () => f.runtime.store.list({ worktree: partition, limit: 10 });
        try {
            const response = await post(receiver.endpoint, 'traces', traceRequest());
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({});
            expect(await readSelected()).toHaveLength(1);
            const neighborEvent = { id: 'keep', worktree: neighbor, kind: 'log', source: 'otlp', at: 1 } as const;
            f.runtime.ingest.offer([neighborEvent]);
            await f.runtime.ingest.settled();
            const readNeighbor = () => f.runtime.store.list({ worktree: neighbor, limit: 10 });
            const neighborBefore = await readNeighbor();
            f.runtime.recordCoverage(neighbor, 'store_busy', '/physical/neighbor');
            f.runtime.recordCoverage(pendingPartition, 'store_busy', physicalRootIdentity);
            const beforeRemoval = f.publications.length;
            await rm(physicalRootIdentity, { recursive: true });
            await expect(stat(physicalRootIdentity)).rejects.toMatchObject({ code: 'ENOENT' });
            await f.runtime.removeWorktree(physicalRootIdentity);
            expect(await readSelected()).toEqual([]);
            expect(f.runtime.ingest.coverage(pendingPartition)).toEqual({ lostObservations: 0, reason: null });
            expect(f.runtime.ingest.coverage(neighbor)).toEqual({ lostObservations: 1, reason: 'store_busy' });
            expect(await readNeighbor()).toEqual(neighborBefore);
            expect(f.publications.slice(beforeRemoval)).not.toContainEqual([neighbor]);
        } finally {
            await receiver.release();
            await f.runtime.ingest.settled();
            f.close();
            await rm(physicalRootIdentity, { recursive: true, force: true });
        }
    });

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

    it('acknowledges and retains overlapping trace, log and metric exports without replay', async () => {
        const f = await fixture();
        const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition, capabilities: { metrics: true } } });
        const held = f.holdNextCommit();
        try {
            const traces = () => post(receiver.endpoint, 'traces', traceRequest());
            const logs = () => post(receiver.endpoint, 'logs', { resourceLogs: [{ scopeLogs: [{ logRecords: [{
                traceId, spanId, timeUnixNano: '1700000000001000000', body: { stringValue: 'request completed' },
            }] }] }] });
            const tracesPending = traces();
            await held.entered;
            const logsPending = logs();
            const metricsPending = post(receiver.endpoint, 'metrics', { resourceMetrics: [{ scopeMetrics: [{ metrics: [{
                name: 'api.requests', gauge: { dataPoints: [{ timeUnixNano: '1700000000001000000', asInt: '1' }] },
            }] }] }] });
            // Give both exporters a turn on the real listener while SQLite still holds the first commit.
            await delay(150);
            held.release();
            const responses = await Promise.all([tracesPending, logsPending, metricsPending]);
            const retained = await Promise.all([
                f.runtime.store.list({ worktree: partition, kind: 'query', limit: 10 }),
                f.runtime.store.list({ worktree: partition, kind: 'log', limit: 10 }),
                f.runtime.store.metricPoints({ worktree: partition, since: 1_700_000_000_000, until: 1_700_000_001_000 }),
            ]);
            expect(retained.map(rows => rows.length)).toEqual([1, 1, 1]);
            expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
            expect(await Promise.all(responses.map(response => response.json()))).toEqual([{}, {}, {}]);
            expect(await f.runtime.store.list({ worktree: partition, kind: 'query', limit: 10 })).toEqual([
                expect.objectContaining({ traceId, spanId }),
            ]);
            expect(await f.runtime.store.list({ worktree: partition, kind: 'log', limit: 10 })).toEqual([
                expect.objectContaining({ traceId, spanId, bodyPrefix: 'request completed' }),
            ]);
            expect(f.runtime.ingest.coverage(partition)).toEqual({ lostObservations: 0, reason: null });
            expect(f.publications).toEqual([[partition], [partition], [partition]]);
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

    it('keeps a wire observation while projecting an unrelated Worktree trace', async () => {
        const f = await fixture();
        const publisher = createDatabaseFindingPublisher(f.runtime, {
            signal: new AbortController().signal,
            services: { events: { plugin: {
                async emit() { throw new Error('A single request without SQL is not a database finding'); },
                subscribe() { throw new Error('Finding publication does not subscribe'); },
            } } },
        });
        try {
            await f.runtime.ingest.exclusive(() => f.runtime.ingest.write([{
                kind: 'span', id: 'checkout', source: 'otlp', at: 1,
                worktree: partition, traceId, spanId, spanKind: 2, endpointRoute: '/checkout',
            }]));
            const projection = publisher({ source: worktreeSource, sourceScope: worktreeSourceScope, partition, traceIds: [traceId],
                selectSubjects: trace => selectWorktreeFindingSubjects(trace, worktreeFindingSubjects),
            });
            f.runtime.observeWire({ id: 'wire-transaction', kind: 'transaction', connectionId: 'wire', startedAt: 2,
                durationMs: 1, outcome: 'commit', executionIds: [],
            }, { partition });
            await projection;
            await f.runtime.ingest.settled();
            expect(await f.runtime.store.list({ worktree: partition, kind: 'transaction', limit: 10 }))
                .toEqual([expect.objectContaining({ id: 'wire-transaction', source: 'wire' })]);
        } finally {
            await f.runtime.ingest.settled();
            f.close();
        }
    });

    it.each([false, true])('admits a projected Worktree finding only from retained evidence (cleared = %s)', async cleared => {
        const f = await fixture();
        const events: unknown[] = [];
        const publisher = createDatabaseFindingPublisher(f.runtime, {
            signal: new AbortController().signal,
            services: { events: { plugin: {
                async emit(_localId, payload) {
                    events.push(payload);
                    return { status: 'admitted', sequence: events.length, subscriberCount: 1 };
                },
                subscribe() { throw new Error('Finding publication does not subscribe'); },
            } } },
        });
        try {
            await f.runtime.ingest.exclusive(() => f.runtime.ingest.write([{
                kind: 'span', id: 'orders', source: 'otlp', at: 1,
                worktree: partition, traceId, spanId, spanKind: 2, endpointRoute: '/orders',
            }, ...[1, 2].map(index => ({
                kind: 'query' as const, id: `wire-${index}`, source: 'wire' as const, at: index + 1,
                worktree: partition, traceId, spanId: `1234567890abcde${index}`, parentSpanId: spanId,
                executionIdentity: `execution-${index}`, databaseMemberKey: worktreeDatabaseMemberKey,
                shape: 'SELECT ?', statementKind: 'select' as const, parameterIdentity: `parameter-${index}`,
            }))]));
            await publisher({ source: worktreeSource, sourceScope: worktreeSourceScope, partition, traceIds: [traceId],
                async selectSubjects(trace) {
                    const selected = selectWorktreeFindingSubjects(trace, worktreeFindingSubjects);
                    expect(selected.size).toBe(1);
                    if (cleared) await f.runtime.clear(partition);
                    return selected;
                },
            });
            expect(events).toEqual(cleared ? [] : [
                expect.objectContaining({ observation: expect.objectContaining({ kind: 'suspected_n_plus_one' }) }),
            ]);
        } finally {
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
