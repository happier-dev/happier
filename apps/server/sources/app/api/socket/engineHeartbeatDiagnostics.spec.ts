import { createServer } from 'node:http';
import { once } from 'node:events';
import { Server, type Socket } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { describe, expect, it } from 'vitest';

import { registerEngineHeartbeatDiagnostics, type EngineHeartbeatDiagnostic } from './engineHeartbeatDiagnostics';

describe('opt-in Engine.IO heartbeat diagnostics', () => {
    it.each([false, true])('observes real upgraded heartbeat delivery without recording application data (enabled=%s)', async enabled => {
        const http = createServer();
        const io = new Server(http, {
            path: '/v1/updates', transports: ['polling', 'websocket'],
            pingInterval: 100, pingTimeout: 5_000, serveClient: false,
        });
        const records: EngineHeartbeatDiagnostic[] = [];
        registerEngineHeartbeatDiagnostics(io, {
            HAPPIER_SOCKET_HEARTBEAT_DIAGNOSTICS: enabled ? '1' : undefined,
        }, record => { records.push(record); });
        const serverConnection = new Promise<Socket['conn']>(resolve => io.engine.once('connection', resolve));
        io.on('connection', socket => {
            socket.on('large-read', (ack: (value: string) => void) => ack('private application content'.repeat(100_000)));
        });
        http.listen(0, '127.0.0.1');
        await once(http, 'listening');
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Expected TCP address');
        const client = connect(`http://127.0.0.1:${address.port}`, {
            path: '/v1/updates', transports: ['polling', 'websocket'],
            auth: { clientPurpose: 'scoped-rpc' }, reconnection: false, autoConnect: false,
        });
        try {
            client.connect();
            await new Promise<void>(resolve => client.once('connect', resolve));
            if (client.io.engine.transport.name !== 'websocket') {
                await new Promise<void>(resolve => client.io.engine.once('upgrade', () => resolve()));
            }
            const response = await client.timeout(5_000).emitWithAck('large-read');
            expect(response).toHaveLength(2_700_000);
            await new Promise<void>(resolve => client.io.engine.once('ping', resolve));
            // A following ping proves the previous pong reached the real server.
            await new Promise<void>(resolve => client.io.engine.once('ping', resolve));
            if (!enabled) {
                expect(records).toEqual([]);
                return;
            }
            const engineId = client.io.engine.id;
            const connection = records.filter(record => record.engineId === engineId);
            expect(connection).toEqual(expect.arrayContaining([
                expect.objectContaining({ event: 'engine_connected', transport: 'polling' }),
                expect.objectContaining({ event: 'namespace_connected', socketId: client.id, purpose: 'scoped-rpc' }),
                expect.objectContaining({ event: 'upgrade', transport: 'websocket' }),
                expect.objectContaining({ event: 'ping_created', transport: 'websocket', writeBufferPackets: expect.any(Number) }),
                expect.objectContaining({ event: 'ping_flushed', transport: 'websocket' }),
                expect.objectContaining({ event: 'pong_received', transport: 'websocket' }),
                expect.objectContaining({ event: 'transport_drained', transport: 'websocket' }),
            ]));
            expect(connection.every(record => Number.isFinite(record.at))).toBe(true);
            expect(JSON.stringify(records)).not.toContain('private application content');
            expect(connection.filter(record => record.event === 'ping_created').length).toBeGreaterThanOrEqual(2);
            const closed = once(await serverConnection, 'close');
            client.close();
            await closed;
            expect(records).toContainEqual(expect.objectContaining({ engineId, event: 'closed' }));
        } finally {
            client.close();
            await new Promise<void>(resolve => io.close(() => resolve()));
        }
    });
});
