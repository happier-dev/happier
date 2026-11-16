import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { io as ioClient } from 'socket.io-client';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilitySocketAuthV1,
} from '@happier-dev/protocol';

import { auth } from '@/app/auth/auth';
import { startSocket } from './socket';
import type { Fastify as AppFastify } from './types';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { buildAccountChangeRowsSocketAuthV1 } from '@happier-dev/protocol/changes';
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
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });

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
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });

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
        ['user-scoped', null],
        ['machine-scoped', 'm-account-content-compat'],
    ] as const)('admits %s sockets before operation-scoped stored-content checks', async (clientType, machineId) => {
        const account = await db.account.create({
            data: { publicKey: `pk-account-content-compat-${clientType}` },
            select: { id: true },
        });
        if (machineId) {
            await db.machine.create({
                data: {
                    id: machineId,
                    accountId: account.id,
                    metadata: 'metadata',
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                    active: false,
                },
            });
        }
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const baseAuth = {
            token,
            clientType,
            ...(machineId ? { machineId } : null),
        };
        const { app, port } = await startSocketApp();
        const legacy = ioClient(`http://127.0.0.1:${port}`, {
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: baseAuth,
        });
        try {
            await waitForConnectionSuccess(legacy);
        } finally {
            legacy.close();
        }

        const current = ioClient(`http://127.0.0.1:${port}`, {
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            auth: {
                ...baseAuth,
                ...buildAccountStoredContentCompatibilitySocketAuthV1(
                    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
                ),
            },
        });
        try {
            await waitForConnectionSuccess(current);
        } finally {
            current.close();
            await app.close();
        }
    }, 30_000);

    it('admits change-row demand on a session host Account socket and pushes it the rows of each wake', async () => {
        const account = await db.account.create({ data: { publicKey: 'pk-account-change-rows-user-scoped' }, select: { id: true } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'rows', metadata: '{}' }, select: { id: true } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const { app, port } = await startSocketApp();
        const host = ioClient(`http://127.0.0.1:${port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false,
            auth: { token, clientType: 'user-scoped',
                ...buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
                ...buildAccountChangeRowsSocketAuthV1(['session']) },
        });
        const wakes: { body: { t: string; rows?: { after: number; page: { changes: { entityId: string }[] } } } }[] = [];
        host.on('update', (update: (typeof wakes)[number]) => { if (update.body.t === 'account-change') wakes.push(update); });
        try {
            await waitForConnectionSuccess(host);
            // Room admission completes after connect: write until the first wake arrives.
            await vi.waitFor(async () => {
                await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id }));
                await new Promise(resolve => setTimeout(resolve, 100));
                expect(wakes.length).toBeGreaterThan(0);
            }, { timeout: 10_000, interval: 50 });
            expect(wakes.at(-1)!.body.rows?.page.changes).toEqual([expect.objectContaining({ entityId: session.id })]);
        } finally {
            host.close();
            await app.close();
        }
    }, 30_000);

    it('treats unknown client types as user-scoped for mixed-version compatibility', async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });

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
