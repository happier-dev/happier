import Fastify from 'fastify';
import { setImmediate } from 'node:timers/promises';
import type { Socket as TcpSocket } from 'node:net';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

import { startSocket } from './socket';
import type { Fastify as AppFastify } from './types';

describe('client disconnect drops queued socket delivery', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-socket-disconnect-drain-', initAuth: true, initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => { await harness.close(); });

    it.each(['websocket', 'upgrade'] as const)('sends zero queued bytes after the disconnect packet (%s)', async transportName => {
        harness.resetEnv();
        const account = await db.account.create({ data: { publicKey: `disconnect-${transportName}` } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        const io = app.machineDaemonPresence;
        if (!(io instanceof Server)) throw new Error('Expected the production Socket.IO server');
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Expected TCP address');
        const client = connect(`http://127.0.0.1:${address.port}`, {
            path: '/v1/updates', transports: transportName === 'upgrade' ? ['polling', 'websocket'] : [transportName], auth: { token },
            reconnection: false, autoConnect: false,
        });
        let serverSocket: import('socket.io').Socket | undefined;
        let tcpSocket: TcpSocket | undefined;
        let restoreSend: (() => void) | undefined;
        try {
            const connected = new Promise<void>((resolve, reject) => {
                client.once('connect', resolve);
                client.once('connect_error', reject);
            });
            client.connect();
            await connected;
            if (transportName === 'upgrade' && client.io.engine.transport.name !== 'websocket') {
                await new Promise<void>(resolve => client.io.engine.once('upgrade', () => resolve()));
            }
            const socket = io.sockets.sockets.get(client.id!);
            if (!socket) throw new Error('Expected admitted socket');
            serverSocket = socket;
            // Positive control: an active consumer receives its payload.
            const received = new Promise<string>(resolve => client.once('drain-control', resolve));
            socket.emit('drain-control', 'consumed');
            expect(await received).toBe('consumed');

            const transport = socket.conn.transport;
            if (transport.name === 'websocket') {
                // Engine.IO's ws network boundary exposes its TCP socket only at runtime.
                tcpSocket = (transport as unknown as { socket: { _socket: TcpSocket } }).socket._socket;
                tcpSocket.cork();
                socket.emit('drain-buffered', 'x'.repeat(1_250_000));
            }
            // Network boundary: hold transport writes as a slow peer does, leaving
            // the real Engine.IO queue and Socket.IO disconnect parser intact.
            transport.writable = false;
            socket.emit('drain-queued', 'x'.repeat(1_250_000));
            const send = vi.spyOn(transport, 'send');
            restoreSend = () => send.mockRestore();
            const disconnected = new Promise<void>(resolve => socket.once('disconnect', () => resolve()));
            // Engine.IO message containing Socket.IO DISCONNECT: wire packet 41.
            // Keep the client transport open so its own close cannot hide a leak.
            client.io.engine.write('1');
            await disconnected;
            await setImmediate();
            transport.writable = true;
            transport.emit('ready');
            const deliveredBytes = send.mock.calls.flatMap(([packets]) => packets)
                .filter(packet => packet.type === 'message')
                .reduce((bytes, packet) => bytes + Buffer.byteLength(String(packet.data)), 0);
            expect(deliveredBytes).toBe(0);
            expect(socket.conn.readyState).toBe('closed');
            if (tcpSocket) expect(tcpSocket.destroyed).toBe(true);
        } finally {
            restoreSend?.();
            if (serverSocket) {
                serverSocket.conn.transport.writable = false;
                serverSocket.conn.close(true);
            }
            tcpSocket?.uncork();
            client.close();
            await app.close();
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('sends zero queued bytes to a polling GET after the disconnect packet', async () => {
        harness.resetEnv();
        const account = await db.account.create({ data: { publicKey: 'disconnect-raw-polling' } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        const io = app.machineDaemonPresence;
        if (!(io instanceof Server)) throw new Error('Expected the production Socket.IO server');
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Expected TCP address');
        const base = `http://127.0.0.1:${address.port}/v1/updates/?EIO=4&transport=polling`;
        try {
            // Manual HTTP polls leave a real gap between GETs. An automatic
            // client would immediately fetch and consume the queued frame.
            const opened = await (await fetch(base)).text();
            const { sid } = JSON.parse(opened.slice(1)) as { sid: string };
            const url = `${base}&sid=${encodeURIComponent(sid)}`;
            const post = (body: string) => fetch(url, { method: 'POST', body });
            expect((await post(`40${JSON.stringify({ token })}`)).status).toBe(200);
            const admitted = await (await fetch(url)).text();
            const connected = admitted.split('\x1e').find(packet => packet.startsWith('40'));
            if (!connected) throw new Error('Expected Socket.IO connect response');
            const { sid: socketId } = JSON.parse(connected.slice(2)) as { sid: string };
            const socket = io.sockets.sockets.get(socketId);
            if (!socket) throw new Error('Expected admitted polling socket');
            socket.emit('drain-control', 'consumed');
            expect(await (await fetch(url)).text()).toContain('drain-control');
            socket.emit('drain-queued', 'x'.repeat(1_250_000));
            const disconnected = new Promise<void>(resolve => socket.once('disconnect', () => resolve()));
            // Discarding the connection may abort its in-flight POST response.
            await post('41').catch(() => undefined);
            await disconnected;
            await setImmediate();
            const afterDisconnect = await fetch(url);
            const packets = (await afterDisconnect.text()).split('\x1e');
            const deliveredBytes = packets.filter(packet => packet.startsWith('4'))
                .reduce((bytes, packet) => bytes + Buffer.byteLength(packet), 0);
            expect(deliveredBytes).toBe(0);
            expect(afterDisconnect.status).toBe(400);
        } finally {
            await new Promise<void>(resolve => io.close(() => resolve()));
            await app.close();
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
