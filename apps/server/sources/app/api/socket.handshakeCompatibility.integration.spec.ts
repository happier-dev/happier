import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { io as ioClient } from 'socket.io-client';
import { buildClientCompatibilitySocketAuthV1 } from '@happier-dev/protocol';

import { auth } from '@/app/auth/auth';
import { startSocket } from './socket';
import type { Fastify as AppFastify } from './types';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

type ConnectErrorPayload = {
    message: string;
    data: {
        error: string;
        statusCode?: number;
    } | null;
};

function parseConnectErrorPayload(err: unknown): ConnectErrorPayload {
    const obj = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
    const dataObj = typeof obj.data === 'object' && obj.data !== null ? (obj.data as Record<string, unknown>) : null;
    return {
        message: typeof obj.message === 'string' ? obj.message : String(err),
        data: dataObj
            ? {
                error: typeof dataObj.error === 'string' ? dataObj.error : 'unknown',
                statusCode: typeof dataObj.statusCode === 'number' ? dataObj.statusCode : undefined,
            }
            : null,
    };
}

async function waitForConnectionSuccess(socket: ReturnType<typeof ioClient>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            socket.off('connect', onConnect);
            socket.off('connect_error', onConnectError);
        };

        const onConnect = () => {
            cleanup();
            resolve();
        };

        const onConnectError = (err: unknown) => {
            cleanup();
            reject(err);
        };

        socket.on('connect', onConnect);
        socket.on('connect_error', onConnectError);
    });
}

async function waitForConnectionFailure(socket: ReturnType<typeof ioClient>): Promise<ConnectErrorPayload> {
    return await new Promise<ConnectErrorPayload>((resolve, reject) => {
        const cleanup = () => {
            socket.off('connect_error', onConnectError);
            socket.off('connect', onConnect);
        };

        const onConnectError = (err: unknown) => {
            cleanup();
            resolve(parseConnectErrorPayload(err));
        };

        const onConnect = () => {
            cleanup();
            reject(new Error('Socket connected unexpectedly'));
        };

        socket.on('connect_error', onConnectError);
        socket.on('connect', onConnect);
    });
}

async function startSocketApp(): Promise<{ app: AppFastify; port: number }> {
    const app = Fastify({ logger: false }) as unknown as AppFastify;
    startSocket(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    if (!port) {
        await app.close();
        throw new Error('Failed to bind socket server');
    }
    return { app, port };
}

describe('startSocket handshake compatibility', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-socket-handshake-',
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.unstubAllGlobals();
        harness.resetEnv();
    });

    afterEach(async () => {
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    it('rejects sockets that omit the auth token', async () => {
        const { app, port } = await startSocketApp();
        const socket = ioClient(`http://127.0.0.1:${port}`, {
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: {},
        });

        let payload: ConnectErrorPayload;
        try {
            payload = await waitForConnectionFailure(socket);
        } finally {
            socket.close();
            await app.close();
        }

        expect(payload.message).toBe('invalid-token');
        expect(payload.data).toEqual({
            error: 'invalid-token',
            statusCode: 401,
        });
    }, 30_000);

    it('rejects session-scoped sockets that omit sessionId', async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);

        const { app, port } = await startSocketApp();
        const socket = ioClient(`http://127.0.0.1:${port}`, {
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: { token, clientType: 'session-scoped' },
        });

        let payload: ConnectErrorPayload;
        try {
            payload = await waitForConnectionFailure(socket);
        } finally {
            socket.close();
            await app.close();
        }

        expect(payload.message).toBe('missing-session-id');
        expect(payload.data).toEqual({
            error: 'missing-session-id',
            statusCode: 400,
        });
    }, 30_000);

    it('rejects machine-scoped sockets that omit machineId', async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);

        const { app, port } = await startSocketApp();
        const socket = ioClient(`http://127.0.0.1:${port}`, {
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: { token, clientType: 'machine-scoped' },
        });

        let payload: ConnectErrorPayload;
        try {
            payload = await waitForConnectionFailure(socket);
        } finally {
            socket.close();
            await app.close();
        }

        expect(payload.message).toBe('missing-machine-id');
        expect(payload.data).toEqual({
            error: 'missing-machine-id',
            statusCode: 400,
        });
    }, 30_000);

    it.each([
        ['undeclared', {}],
        ['out-of-date', buildClientCompatibilitySocketAuthV1({
            v: 1,
            clientKind: 'daemon',
            appVersion: '0.2.9',
            sessionSyncProtocolVersion: 2,
        })],
    ] as const)('rejects an %s daemon before machine ownership and admits its compatible reconnect', async (_case, compatibilityAuth) => {
        harness.resetEnv({
            HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT: 'required',
            HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION: '2',
            HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON: JSON.stringify({ daemon: '0.2.10' }),
        });
        const account = await db.account.create({
            data: { publicKey: `pk-daemon-compat-${Date.now()}` },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: 'm-daemon-compat',
                accountId: account.id,
                metadata: 'metadata',
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                active: false,
            },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);

        const { app, port } = await startSocketApp();
        const socket = ioClient(`http://127.0.0.1:${port}`, {
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: {
                token,
                clientType: 'machine-scoped',
                machineId: 'm-daemon-compat',
                ...compatibilityAuth,
            },
        });

        let payload: ConnectErrorPayload;
        try {
            payload = await waitForConnectionFailure(socket);
        } finally {
            socket.close();
        }

        expect(payload.message).toBe('client-upgrade-required');
        expect(payload.data?.error).toBe('client-upgrade-required');

        const compatible = ioClient(`http://127.0.0.1:${port}`, {
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: {
                token,
                clientType: 'machine-scoped',
                machineId: 'm-daemon-compat',
                ...buildClientCompatibilitySocketAuthV1({
                    v: 1,
                    clientKind: 'daemon',
                    appVersion: '0.2.10',
                    sessionSyncProtocolVersion: 2,
                }),
            },
        });
        try {
            await waitForConnectionSuccess(compatible);
        } finally {
            compatible.close();
            await app.close();
        }
    }, 30_000);

    it('rejects an out-of-date session runner before resolving its session binding', async () => {
        harness.resetEnv({
            HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT: 'required',
            HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION: '2',
            HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON: JSON.stringify({
                daemon: '0.2.10',
                'session-runner': '0.2.10',
            }),
        });
        const account = await db.account.create({
            data: { publicKey: `pk-runner-compat-${Date.now()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);
        const { app, port } = await startSocketApp();
        const socket = ioClient(`http://127.0.0.1:${port}`, {
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: {
                token,
                clientType: 'session-scoped',
                sessionId: 'session-does-not-exist',
                ...buildClientCompatibilitySocketAuthV1({
                    v: 1,
                    clientKind: 'session-runner',
                    appVersion: '0.2.9',
                    sessionSyncProtocolVersion: 2,
                }),
            },
        });

        let payload: ConnectErrorPayload;
        try {
            payload = await waitForConnectionFailure(socket);
        } finally {
            socket.close();
            await app.close();
        }

        expect(payload.message).toBe('client-upgrade-required');
        expect(payload.data?.error).toBe('client-upgrade-required');
    }, 30_000);

    it('treats unknown client types as user-scoped for mixed-version compatibility', async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);

        const { app, port } = await startSocketApp();
        const socket = ioClient(`http://127.0.0.1:${port}`, {
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: { token, clientType: 'future-scoped' },
        });

        try {
            await waitForConnectionSuccess(socket);
        } finally {
            socket.close();
            await app.close();
        }
    }, 30_000);

});
