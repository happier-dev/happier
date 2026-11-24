import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { startPostgresProxy } from '../proxy';
import { createCaptureReader } from '../read.js';
import { createCaptureRuntime } from '../runtime.js';
import { captureMigrations } from '../store/capture.js';
import { createCaptureSqliteFixture } from '../testing/sqlite.js';
import type { WireObservation } from './tracker';

function frame(tag: string, value = ''): Buffer { const body = Buffer.from(value); const header = Buffer.alloc(5); header.write(tag); header.writeInt32BE(body.length + 4, 1); return Buffer.concat([header, body]); }
function startup(): Buffer { const data = Buffer.alloc(8); data.writeInt32BE(8); data.writeInt32BE(196608, 4); return data; }
async function readBytes(socket: Socket, length: number): Promise<Buffer> {
    const parts: Buffer[] = []; let received = 0;
    while (received < length) { const value: Buffer = socket.read() ?? await new Promise<Buffer>(resolve => socket.once('data', resolve)); parts.push(value); received += value.length; }
    return Buffer.concat(parts);
}

describe('loopback Postgres proxy', () => {
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
