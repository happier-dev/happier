import Fastify from 'fastify';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

// Only persistence is substituted: real tokens, admission, handlers, and sockets
// exercise connect-time delivery without writing any database.
const persistence = vi.hoisted(() => {
    const account = { id: 'connect-rpc-account', tokenEpoch: 0, status: 'active', terminalPresentUserPolicy: 'deny' };
    const readAccount = vi.fn(async () => account);
    const database = {
        account: { findUnique: readAccount },
        simpleCache: { findUnique: async () => ({ value: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }) },
        $transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => run(database),
    };
    return { database, readAccount, account };
});
vi.mock('@/storage/db', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/storage/db')>(),
    db: persistence.database,
}));

import { auth } from '@/app/auth/auth';
import { startSocket } from './socket';
import type { Fastify as AppFastify } from './types';

describe('connect-time RPC delivery', () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    it.each(['admitted', 'revoked', 'disconnected'] as const)('settles a connect-time scoped RPC after delayed admission (%s)', async (outcome) => {
        persistence.account.status = 'active';
        vi.stubEnv('HANDY_MASTER_SECRET', 'connect-rpc-test-only-master-secret');
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        await auth.init();
        const token = await auth.createToken(persistence.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        const server = app.machineDaemonPresence;
        if (!(server instanceof Server)) throw new Error('Expected live Socket.IO server');
        let releaseAdmission!: () => void;
        const pendingAdmission = new Promise<void>(resolve => { releaseAdmission = resolve; });
        let packetArrived!: () => void;
        const receivedPacket = new Promise<void>(resolve => { packetArrived = resolve; });
        let postConnect = false;
        let disconnected!: () => void;
        const serverDisconnected = new Promise<void>(resolve => { disconnected = resolve; });
        server.once('connection', socket => {
            postConnect = true;
            socket.onAny(event => { if (event === SOCKET_RPC_EVENTS.CALL) packetArrived(); });
            socket.once('disconnect', disconnected);
        });
        persistence.readAccount.mockImplementation(async () => {
            if (postConnect) await pendingAdmission;
            return persistence.account;
        });
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Expected bound server');
        const caller = ioClient(`http://127.0.0.1:${address.port}`, {
            path: '/v1/updates/', transports: ['websocket'], autoConnect: false, reconnection: false,
            auth: { token, clientType: 'user-scoped', clientPurpose: 'scoped-rpc' },
        });
        try {
            const response = new Promise<unknown>((resolve, reject) => {
                caller.once('connect_error', reject);
                caller.once('connect', () => {
                    void caller.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.CALL, {
                        method: 'neutral.missing', params: {},
                    }).then(resolve, reject);
                });
            }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
            caller.connect();
            await receivedPacket;
            if (outcome === 'revoked') persistence.account.status = 'disabled';
            if (outcome === 'disconnected') {
                caller.close();
                await serverDisconnected;
            }
            releaseAdmission();
            const result = await response;
            if (outcome === 'admitted') {
                expect(result).toMatchObject({ ok: true, value: { ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE } });
            } else {
                expect(result).toMatchObject({ ok: false, error: expect.any(Error) });
                await serverDisconnected;
            }
        } finally {
            releaseAdmission();
            persistence.account.status = 'active';
            persistence.readAccount.mockImplementation(async () => persistence.account);
            caller.close();
            await app.close();
        }
    });
});
