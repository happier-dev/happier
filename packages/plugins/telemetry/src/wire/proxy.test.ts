import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { startPostgresProxy } from '../proxy';
import type { WireObservation } from './tracker';

function frame(tag: string, value = ''): Buffer { const body = Buffer.from(value); const header = Buffer.alloc(5); header.write(tag); header.writeInt32BE(body.length + 4, 1); return Buffer.concat([header, body]); }
function startup(): Buffer { const data = Buffer.alloc(8); data.writeInt32BE(8); data.writeInt32BE(196608, 4); return data; }
async function readBytes(socket: Socket, length: number): Promise<Buffer> {
    const parts: Buffer[] = []; let received = 0;
    while (received < length) { const value: Buffer = socket.read() ?? await new Promise<Buffer>(resolve => socket.once('data', resolve)); parts.push(value); received += value.length; }
    return Buffer.concat(parts);
}

describe('loopback Postgres proxy', () => {
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
