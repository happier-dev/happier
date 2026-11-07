import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import { io as connectSocket, type Socket as ClientSocket } from 'socket.io-client';
import type { Server as SocketServer } from 'socket.io';
import { expect, it, vi } from 'vitest';

import { auth } from '@/app/auth/auth';
import { buildMachineActivityEphemeral } from '@/app/events/eventRouter';
import { db } from '@/storage/db';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { startSocket } from './socket';
import type { Fastify as AppFastify } from './types';

// Observe the real Socket.IO transport; all ownership, authentication and persistence stay real.
const transport = vi.hoisted(() => ({
    server: null as SocketServer | null,
    authenticate: null as Parameters<SocketServer['use']>[0] | null,
}));
vi.mock('socket.io', async (importOriginal) => {
    const actual = await importOriginal<typeof import('socket.io')>();
    return {
        ...actual,
        Server: class extends actual.Server {
            constructor(...args: ConstructorParameters<typeof actual.Server>) {
                super(...args);
                transport.server = this;
            }
            use(middleware: Parameters<SocketServer['use']>[0]) {
                transport.authenticate = middleware;
                return super.use(middleware);
            }
        },
    };
});

async function connect(client: ClientSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        client.once('connect', () => { client.off('connect_error', reject); resolve(); });
        client.once('connect_error', reject);
        client.connect();
    });
}

type MachineActivity = ReturnType<typeof buildMachineActivityEphemeral>;

it('keeps a replacement machine online when its predecessor disconnects late, then publishes its real disconnect', async () => {
    const harness = await createLightSqliteHarness({
        tempDirPrefix: 'happier-machine-reconnect-', initAuth: true,
        env: { HAPPIER_SOCKET_ADAPTER: 'memory' },
    });
    const app = fastify();
    const clients: ClientSocket[] = [];
    try {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: account.id, metadata: '{}', active: false } });
        const token = await auth.createToken(account.id);
        // Fastify's application decorations are unused by the Socket.IO transport entry.
        startSocket(app as AppFastify);
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const server = transport.server;
        if (!server) throw new Error('Socket transport was not initialized');
        const createClient = (clientType: 'user-scoped' | 'machine-scoped') => {
            const client = connectSocket(address, {
                path: '/v1/updates', transports: ['websocket'], autoConnect: false, reconnection: false,
                auth: { token, clientType, ...(clientType === 'machine-scoped' ? { machineId, runtimeId: 'same-runtime' } : {}) },
            });
            clients.push(client);
            return client;
        };
        const viewer = createClient('user-scoped');
        const updates: MachineActivity[] = [];
        viewer.on('ephemeral', (update: MachineActivity) => {
            if (update.type === 'machine-activity' && update.id === machineId) updates.push(update);
        });
        const nextActivity = (active: boolean) => new Promise<void>((resolve) => {
            const listener = (update: MachineActivity) => {
                if (update.type !== 'machine-activity' || update.id !== machineId || update.active !== active) return;
                viewer.off('ephemeral', listener);
                resolve();
            };
            viewer.on('ephemeral', listener);
        });
        const initialSnapshot = nextActivity(false);
        await connect(viewer);
        await initialSnapshot;
        const predecessor = createClient('machine-scoped');
        const predecessorOnline = nextActivity(true);
        await connect(predecessor);
        await predecessorOnline;

        // Model delayed delivery of the old transport's disconnect after a successful replacement.
        const predecessorId = predecessor.id;
        let deliverOldDisconnect: (() => void) | undefined;
        const originalIn = server.in.bind(server);
        vi.spyOn(server, 'in').mockImplementation((rooms) => {
            const operator = originalIn(rooms);
            if (rooms === predecessorId) {
                const disconnect = operator.disconnectSockets.bind(operator);
                vi.spyOn(operator, 'disconnectSockets').mockImplementation((close) => {
                    deliverOldDisconnect = () => { disconnect(close); };
                    return operator;
                });
            }
            return operator;
        });
        const replacement = createClient('machine-scoped');
        const replacementOnline = nextActivity(true);
        await connect(replacement);
        await replacementOnline;
        const observationStart = updates.length;
        if (!deliverOldDisconnect) throw new Error('Replacement did not retire its predecessor');
        deliverOldDisconnect();
        await Promise.resolve();
        await Promise.resolve();
        // An ordered transport barrier observes everything published by the old disconnect.
        const barrier = new Promise<void>((resolve) => viewer.once('reconnect-test-barrier', resolve));
        server.sockets.sockets.get(viewer.id ?? '')?.emit('reconnect-test-barrier');
        await barrier;
        expect(updates.slice(observationStart).filter((update) => !update.active)).toEqual([]);
        expect(replacement.connected).toBe(true);

        const authenticate = transport.authenticate;
        const replacementSocket = server.sockets.sockets.get(replacement.id ?? '');
        if (!authenticate || !replacementSocket) throw new Error('Missing authenticated replacement transport');
        const unavailableLookup = vi.spyOn(db.machine, 'findFirst')
            .mockRejectedValueOnce(new Error('private database failure detail'));
        try {
            // Socket.IO owns a callback boundary: a rejected middleware Promise must settle next().
            const failure = await new Promise<Error | undefined>((resolve, reject) => {
                Promise.resolve(authenticate(replacementSocket, resolve)).catch(reject);
            });
            expect(failure).toMatchObject({
                message: 'upstream_error',
                data: { error: 'upstream_error', statusCode: 503 },
            });
            expect(replacement.connected).toBe(true);
        } finally {
            unavailableLookup.mockRestore();
        }

        const replacementOffline = nextActivity(false);
        const disconnectedAt = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(disconnectedAt);
        try {
            replacementSocket.disconnect(true);
            clock.mockReturnValue(disconnectedAt + 1000);
            await replacementOffline;
            expect(updates.at(-1)).toMatchObject({ active: false, activeAt: disconnectedAt });
        } finally {
            clock.mockRestore();
        }
    } finally {
        vi.restoreAllMocks();
        for (const client of clients) client.disconnect();
        const server = transport.server;
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
        await harness.close();
    }
});
