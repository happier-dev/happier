import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { describe, expect, it, vi } from 'vitest';

import { createStartServerHarness } from '@/testkit/startServerHarness';

vi.mock(import('@/storage/db'), async importOriginal => {
    const storage = await importOriginal();
    return {
        ...storage,
        initDbPostgres() {
            storage.initDbPostgres();
            // Fail only the process's first Machine enrollment read. Subsequent
            // reads and every write go to the disposable PostgreSQL database.
            const machines = storage.db.machine;
            const findMany = machines.findMany.bind(machines);
            vi.spyOn(machines, 'findMany').mockImplementation(findMany).mockRejectedValueOnce(
                new Error('timeout exceeded when trying to connect'),
            );
        },
    };
});

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Home boot with PostgreSQL presence enrollment', () => {
    it('serves through a pool timeout, expires a disconnected Machine and keeps a connected one online', async () => {
        const databaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!databaseUrl || databaseUrl !== process.env.DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        const harness = createStartServerHarness();
        const dir = await mkdtemp(join(tmpdir(), 'home-presence-startup-'));
        const receiptPath = join(dir, 'ready.json');
        let socket: Socket | undefined;
        let boot: Promise<void> | undefined;
        let shutdown: (() => Promise<void>) | undefined;
        try {
            const { startServer } = await harness.importStartServerModule({
                HAPPIER_DB_PROVIDER: 'postgres',
                DATABASE_URL: databaseUrl,
                HAPPIER_SERVER_LIGHT_DATA_DIR: dir,
                HAPPIER_FILES_BACKEND: 'local',
                HAPPIER_SOCKET_ADAPTER: 'memory',
                HANDY_MASTER_SECRET: 'test-presence-startup-secret',
                SERVER_ROLE: 'api',
                HAPPIER_SERVER_HOST: '127.0.0.1',
                METRICS_ENABLED: 'false',
                PORT: '0',
                HAPPIER_SERVER_STARTUP_RECEIPT_PATH: receiptPath,
                HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 'presence-startup-test',
                HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
            });
            const { createDefaultPrismaClient } = await import('@/storage/prismaClientConstruction');
            const fixture = createDefaultPrismaClient(databaseUrl).client;
            const disconnected = randomUUID();
            const connected = randomUUID();
            let accountId: string;
            try {
                ({ id: accountId } = await fixture.account.create({ data: { publicKey: randomUUID() } }));
                await fixture.machine.createMany({ data: [
                    { id: disconnected, accountId, metadata: 'opaque', active: true, lastActiveAt: new Date(0) },
                    { id: connected, accountId, metadata: 'opaque', active: false },
                ] });
            } finally {
                await fixture.$disconnect();
            }

            const { db } = await import('@/storage/db');
            const { auth } = await import('@/app/auth/auth');
            const { initiateShutdown } = await import('@/utils/process/shutdown');
            const logging = await import('@/utils/logging/log');
            const warning = vi.spyOn(logging, 'warn');
            shutdown = () => initiateShutdown('presence startup integration test');
            boot = startServer('full');
            const { host, port }: { host: string; port: number } = await Promise.race([
                boot.then(() => { throw new Error('Home stopped before readiness'); }),
                vi.waitFor(async () => JSON.parse(await readFile(receiptPath, 'utf8')), { timeout: 20_000 }),
            ]);
            const baseUrl = `http://${host}:${port}`;
            const token = await auth.createToken(accountId, undefined, { kind: 'account', authority: 'present_user' });
            const response = await fetch(`${baseUrl}/v2/sessions`, { headers: { authorization: `Bearer ${token}` } });
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ sessions: [] });

            socket = io(baseUrl, {
                path: '/v1/updates', transports: ['websocket'], reconnection: false, autoConnect: false,
                auth: { token, clientType: 'machine-scoped', machineId: connected },
            });
            await new Promise<void>((resolve, reject) => {
                socket!.once('connect', resolve).once('connect_error', reject).connect();
            });
            await vi.waitFor(async () => {
                const machines = await db.machine.findMany({
                    where: { id: { in: [connected, disconnected] } },
                    select: { id: true, active: true },
                });
                expect(machines).toHaveLength(2);
                expect(machines).toEqual(expect.arrayContaining([
                    { id: connected, active: true }, { id: disconnected, active: false },
                ]));
            }, { timeout: 10_000 });
            expect(warning).toHaveBeenCalledWith(
                expect.objectContaining({ module: 'presence-timeout', code: 'database_connection_unavailable' }),
                expect.any(String),
            );
        } finally {
            try {
                socket?.close();
                await shutdown?.();
                await boot?.catch(() => {});
            } finally {
                vi.restoreAllMocks();
                harness.restore();
                await rm(dir, { recursive: true, force: true });
            }
        }
    }, 180_000);
});
