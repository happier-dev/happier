import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { bindLocalCapture } from '../launch.js';
import { startPostgresProxy } from '../proxy';
import { createCaptureReader } from '../read.js';
import { createCaptureRuntime } from '../runtime.js';
import { captureMigrations } from '../store/capture.js';
import { createCaptureSqliteFixture } from '../testing/sqlite.js';
import type { WireObservation } from './tracker';

function frame(tag: string, value = ''): Buffer { const body = Buffer.from(value); const header = Buffer.alloc(5); header.write(tag); header.writeInt32BE(body.length + 4, 1); return Buffer.concat([header, body]); }
function startup(database?: string): Buffer {
    const parameters = database ? Buffer.from(`user\0user\0database\0${database}\0\0`) : Buffer.alloc(0);
    const header = Buffer.alloc(8);
    header.writeInt32BE(header.length + parameters.length);
    header.writeInt32BE(196608, 4);
    return Buffer.concat([header, parameters]);
}
async function readBytes(socket: Socket, length: number): Promise<Buffer> {
    const parts: Buffer[] = []; let received = 0;
    while (received < length) { const value: Buffer = socket.read() ?? await new Promise<Buffer>(resolve => socket.once('data', resolve)); parts.push(value); received += value.length; }
    return Buffer.concat(parts);
}

describe('loopback Postgres proxy', () => {
    it('retains an exact database member only while the listening socket can distinguish its traffic', async () => {
        const fixture = createCaptureSqliteFixture();
        for (const migration of captureMigrations) {
            if (migration.id === 'worktree-database-member') {
                await fixture.db.execute(`INSERT INTO captureSummaries(id,worktree,kind,source,at,shape)
                    VALUES ('older','selected','query','wire',1,'select ?')`);
            }
            await migration.up(fixture.db);
        }
        const runtime = createCaptureRuntime({ database: fixture.db, normalizeStatement: createPostgresqlObservationNormalizer(), publish: () => {} });
        const upstream = createServer();
        upstream.listen(0, '127.0.0.1');
        await once(upstream, 'listening');
        const address = upstream.address();
        if (!address || typeof address === 'string') throw new Error('missing upstream address');
        const owner = {
            kind: 'worktree', accountId: 'alice', installationId: 'installation', projectKey: 'project',
            workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'chosen', rootPath: '/chosen' },
        } as const;
        const member = { ...owner, source: { kind: 'service', serviceId: 'web', variable: 'DATABASE_URL' } } as const;
        const other = { ...owner, source: { kind: 'service', serviceId: 'worker', variable: 'DATABASE_URL' } } as const;
        const original = `postgres://user:secret@127.0.0.1:${address.port}/db`;
        const context = { partition: 'selected', physicalRootIdentity: '/selected', runtime, enabled: true, signal: new AbortController().signal };
        const offer = { name: 'DATABASE_URL', original, upstream: { host: '127.0.0.1', port: address.port }, assignedPort: 0,
            hostSpan: { start: original.indexOf('127.0.0.1'), end: original.lastIndexOf('/') } };
        const selectedOffer = { ...offer, databaseMember: member };
        const otherOffer = { ...offer, databaseMember: other };
        const selected = await bindLocalCapture({ ...context, urls: [selectedOffer] });
        const connection = once(upstream, 'connection');
        const client = createConnection(Number(new URL(selected.replacements.DATABASE_URL!).port), '127.0.0.1');
        const [database] = await connection as [Socket];
        let shared: Awaited<ReturnType<typeof bindLocalCapture>> | undefined;
        try {
            const ready = frame('Z', 'I');
            const startupPacket = startup('db');
            client.write(startupPacket);
            expect(await readBytes(database, startupPacket.length)).toEqual(startupPacket);
            database.write(ready);
            expect(await readBytes(client, ready.length)).toEqual(ready);
            const execute = async (value: number) => {
                const query = frame('Q', `SELECT ${value}\0`);
                client.write(query);
                expect(await readBytes(database, query.length)).toEqual(query);
                const result = Buffer.concat([frame('C', 'SELECT 1\0'), ready]);
                database.write(result);
                expect(await readBytes(client, result.length)).toEqual(result);
                await runtime.ingest.settled();
            };
            const list = { worktree: context.partition, kind: 'query', limit: 10 } as const;
            const listSelected = { ...list, databaseMember: member };
            const listOther = { ...list, databaseMember: other };
            await execute(1);
            const attributed = await runtime.store.list(listSelected);
            expect(attributed).toHaveLength(1);
            shared = await bindLocalCapture({ ...context, urls: [otherOffer] });
            expect(shared.replacements).toEqual(selected.replacements);
            await execute(2);
            await shared.release();
            await execute(3);
            expect(await runtime.store.list(list)).toHaveLength(4);
            expect(await runtime.store.list(listSelected)).toEqual(attributed);
            expect(await runtime.store.list(listOther)).toEqual([]);
        } finally {
            client.destroy();
            database.destroy();
            await shared?.release();
            await selected.release();
            await new Promise<void>(resolve => upstream.close(() => resolve()));
            fixture.close();
        }
    });

    it('pairs late OTLP evidence with one proven wire execution and preserves reused execution tags', async () => {
        const fixture = createCaptureSqliteFixture();
        for (const migration of captureMigrations) await migration.up(fixture.db);
        const published: string[][] = [];
        const runtime = createCaptureRuntime({ database: fixture.db, normalizeStatement: createPostgresqlObservationNormalizer(),
            publish: partitions => published.push([...partitions]) });
        const context = { partition: 'selected', physicalRootIdentity: '/selected' };
        const receiver = await runtime.acquireReceiver({ port: 0, context });
        const upstream = createServer();
        upstream.listen(0, '127.0.0.1');
        await once(upstream, 'listening');
        const address = upstream.address();
        if (!address || typeof address === 'string') throw new Error('missing upstream address');
        const proxy = await startPostgresProxy({ listenHost: '127.0.0.1', listenPort: 0,
            upstream: { host: '127.0.0.1', port: address.port }, onObservation: observation => runtime.observeWire(observation, context) });
        const connection = once(upstream, 'connection');
        const client = createConnection(proxy.port, proxy.host);
        const [database] = await connection as [Socket];
        const traceId = '0123456789abcdef0123456789abcdef';
        const requestId = '0123456789abcdef';
        const firstSpan = '1111111111111111';
        const reusedSpan = '2222222222222222';
        const firstExecution = '3b154552-3d01-460f-8c95-6f0a93c1bbae';
        const reusedExecution = 'f31fbe91-84e9-44be-97a8-afacbcb73776';
        const key = 'happier.db.execution_id';
        const tag = (spanId: string, execution: string) => `/*traceparent='00-${traceId}-${spanId}-01',${key}='${execution}'*/`;
        const span = (spanId: string, kind: number, attributes: Record<string, string>, parentSpanId?: string) => ({
            traceId, spanId, kind, parentSpanId, name: 'request', startTimeUnixNano: '1700000000000000000',
            endTimeUnixNano: '1700000000010000000', attributes: Object.entries(attributes).map(([key, stringValue]) => ({ key, value: { stringValue } })),
        });
        try {
            client.write(startup());
            expect(await readBytes(database, 8)).toEqual(startup());
            const ready = frame('Z', 'I');
            database.write(ready);
            expect(await readBytes(client, ready.length)).toEqual(ready);
            const execute = async (sql: string) => {
                const query = frame('Q', `${sql}\0`);
                client.write(query);
                expect(await readBytes(database, query.length)).toEqual(query);
                const result = Buffer.concat([frame('C', 'SELECT 1\0'), ready]);
                database.write(result);
                expect(await readBytes(client, result.length)).toEqual(result);
                await runtime.ingest.settled();
            };
            await execute(`SELECT 1 ${tag(firstSpan, firstExecution)}`);
            await execute(`SELECT 2 ${tag(reusedSpan, reusedExecution)}`);
            await execute(`SELECT 3 ${tag(reusedSpan, reusedExecution)}`);
            await execute(`SELECT $$ ${tag(firstSpan, firstExecution)} $$`);
            const before = await runtime.store.list({ worktree: context.partition, kind: 'query', limit: 10 });
            expect(before).toHaveLength(4);
            const reader = createCaptureReader(runtime.store);
            const readTrace = () => reader.trace({ worktree: context.partition, traceId, pageSize: 10 });
            expect((await readTrace()).repeatedQueries).toEqual([]);

            published.length = 0;
            const response = await fetch(`${receiver.endpoint}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [
                    span(requestId, 2, { 'http.request.method': 'GET', 'http.route': '/widgets' }),
                    span(firstSpan, 3, { 'db.query.text': 'SELECT 1', [key]: firstExecution }, requestId),
                    span(reusedSpan, 3, { 'db.query.text': 'SELECT 2', [key]: reusedExecution }, requestId),
                ] }] }] }) });
            expect(response.status).toBe(200);
            await runtime.ingest.settled();
            expect(published).toEqual([[context.partition]]);
            const trace = await readTrace();
            expect(trace.summaries.filter(row => row.kind === 'query' && row.source === 'wire')).toHaveLength(3);
            expect(trace.repeatedQueries).toEqual([expect.objectContaining({ repetitionCount: 4, observationIds: expect.arrayContaining([
                before.find(row => row.executionIdentity === firstExecution)!.id, `span:${traceId}:${firstSpan}`, `span:${traceId}:${reusedSpan}`,
            ]) })]);
            const wireTime = trace.summaries.filter(row => row.source === 'wire').reduce((total, row) => total + (row.durationMs ?? 0), 0);
            expect((await reader.endpoints({ worktree: context.partition, limit: 10, pageSize: 10 }))[0]?.databaseTimeMs).toBeCloseTo(wireTime + 10);
        } finally {
            client.destroy();
            database.destroy();
            await proxy.stop();
            await receiver.release();
            await new Promise<void>(resolve => upstream.close(() => resolve()));
            fixture.close();
        }
    });

    it('preserves responses after a client half-close and forwards cancellation startup bytes unchanged', async () => {
        const received: Buffer[] = [];
        const response = Buffer.from('upstream response');
        const upstream = createServer({ allowHalfOpen: true }, socket => { socket.on('data', bytes => received.push(bytes)); socket.on('end', () => socket.end(response)); });
        upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
        const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('missing upstream address');
        const observations: WireObservation[] = [];
        const proxy = await startPostgresProxy({ listenHost: '127.0.0.1', listenPort: 0, upstream: { host: '127.0.0.1', port: address.port }, onObservation: observation => observations.push(observation) });
        const client = createConnection(proxy.port, proxy.host);
        const bytes = Buffer.alloc(16); bytes.writeInt32BE(16); bytes.writeInt32BE(80877102, 4); bytes.writeInt32BE(12345, 8); bytes.writeInt32BE(67890, 12);
        try {
            await once(client, 'connect');
            const returned: Buffer[] = []; client.on('data', value => returned.push(value)); const closed = once(client, 'close');
            client.end(bytes); await closed;
            expect(Buffer.concat(received)).toEqual(bytes);
            expect(Buffer.concat(returned)).toEqual(response);
            expect(observations).toEqual([]);
        } finally { client.destroy(); await proxy.stop(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
    });

    it('relays exact bytes with a held recorder, turns off parsing without dropping traffic, and stops connections', async () => {
        let upstreamSocket: Socket | undefined;
        const upstream = createServer(socket => { upstreamSocket = socket; });
        upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
        const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('missing upstream address');
        const observations: WireObservation[] = [];
        let release: (() => void) | undefined;
        const held = new Promise<void>(resolve => { release = resolve; });
        const proxy = await startPostgresProxy({ listenHost: '127.0.0.1', listenPort: 0, upstream: { host: '127.0.0.1', port: address.port }, onObservation: observation => { observations.push(observation); return held; } });
        const client = createConnection(proxy.port, proxy.host); await once(client, 'connect');
        if (!upstreamSocket) await once(upstream, 'connection');
        const database = upstreamSocket; if (!database) throw new Error('missing upstream socket');
        try {
            const sslRequest = startup(); sslRequest.writeInt32BE(80877103, 4);
            client.write(sslRequest.subarray(0, 3)); client.write(sslRequest.subarray(3));
            expect(await readBytes(client, 1)).toEqual(Buffer.from('N'));
            client.write(startup()); expect(await readBytes(database, 8)).toEqual(startup());
            database.write(frame('Z', 'I')); expect(await readBytes(client, 6)).toEqual(frame('Z', 'I'));
            const query = frame('Q', 'SELECT 1\0'); client.write(query); expect(await readBytes(database, query.length)).toEqual(query);
            const result = Buffer.concat([frame('D', 'private-result'), frame('C', 'SELECT 1\0'), frame('Z', 'I')]);
            database.write(result); expect(await readBytes(client, result.length)).toEqual(result);
            expect(observations).toHaveLength(1);
            const begin = frame('Q', 'BEGIN\0'); client.write(begin); expect(await readBytes(database, begin.length)).toEqual(begin);
            const begun = Buffer.concat([frame('C', 'BEGIN\0'), frame('Z', 'T')]); database.write(begun); expect(await readBytes(client, begun.length)).toEqual(begun);
            proxy.setRecording(false);
            expect(observations.at(-1)).toMatchObject({ kind: 'transaction', outcome: 'incomplete' });
            client.write(query); expect(await readBytes(database, query.length)).toEqual(query);
            database.write(result); expect(await readBytes(client, result.length)).toEqual(result);
            expect(observations).toHaveLength(3);
            const closed = once(client, 'close'); await proxy.stop(); await closed;
            expect(client.destroyed).toBe(true);
        } finally { release?.(); client.destroy(); database.destroy(); await proxy.stop(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
    });
});
