import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createStartServerHarness } from '@/testkit/startServerHarness';
import { applyPostgresMigrations } from '../scripts/prismaMigrations';

const provider = process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID ? process.env.HAPPIER_DB_PROVIDER : undefined;
const targets = provider === 'postgres' || provider === 'mysql' ? [provider] : ['sqlite', 'pglite'];
const harness = createStartServerHarness();

describe.each(targets)('Home starts with unavailable public S3 (%s)', dbProvider => {
    let sqlite: LightSqliteHarness | undefined;
    let pgliteDir: string | undefined;
    beforeAll(async () => {
        if (dbProvider === 'sqlite') {
            sqlite = await createLightSqliteHarness({ tempDirPrefix: 'home-s3-availability-sqlite-' });
            await (await import('@/storage/db')).shutdownDbClient();
        }
        if (dbProvider !== 'pglite') return;
        pgliteDir = await mkdtemp(join(tmpdir(), 'home-s3-availability-pglite-'));
        const database = new PGlite(pgliteDir);
        try {
            await database.waitReady;
            await applyPostgresMigrations({ db: database, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        } finally {
            await database.close();
        }
    }, 120_000);
    afterAll(async () => {
        await sqlite?.close();
        if (pgliteDir) await rm(pgliteDir, { recursive: true, force: true });
    });

    it.each([
        ['unreachable endpoint', 'backend_unavailable'],
        ['missing bucket', 's3_public_bucket_missing'],
        ['bad credentials', 's3_access_denied'],
    ])('serves an authenticated Session list with %s', async (failure, reason) => {
        const dir = await mkdtemp(join(tmpdir(), 'home-s3-availability-'));
        const receiptPath = join(dir, 'ready.json');
        const s3 = createServer((request, reply) => {
            if (failure === 'unreachable endpoint') {
                request.socket.destroy();
                return;
            }
            reply.writeHead(failure === 'missing bucket' ? 404 : 403).end();
        });
        let closeHome: (() => Promise<void>) | undefined;
        let boot: Promise<void> | undefined;
        try {
            s3.listen(0, '127.0.0.1');
            await once(s3, 'listening');
            const { startServer } = await harness.importStartServerModule({
                HAPPIER_DB_PROVIDER: dbProvider,
                DATABASE_URL: sqlite?.envBase.DATABASE_URL ?? (provider ? process.env.DATABASE_URL : undefined),
                HAPPIER_SERVER_LIGHT_DATA_DIR: dir,
                HAPPIER_SERVER_LIGHT_DB_DIR: pgliteDir,
                HAPPIER_FILES_BACKEND: 's3',
                HAPPIER_SOCKET_ADAPTER: 'memory',
                HANDY_MASTER_SECRET: 'test-storage-availability-secret',
                SERVER_ROLE: 'api',
                HAPPIER_SERVER_HOST: '127.0.0.1',
                METRICS_ENABLED: 'false',
                PORT: '0',
                HAPPIER_SERVER_STARTUP_RECEIPT_PATH: receiptPath,
                HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 's3-availability-test',
                S3_HOST: '127.0.0.1',
                S3_PORT: String((s3.address() as AddressInfo).port),
                S3_USE_SSL: 'false',
                S3_PUBLIC_URL: 'https://cdn.example.test',
                S3_BUCKET: 'public-assets',
                S3_PRIVATE_BUCKET: 'private-assets',
                S3_ACCESS_KEY: 'test-access',
                S3_SECRET_KEY: 'test-secret',
            });
            const { initiateShutdown } = await import('@/utils/process/shutdown');
            const { db } = await import('@/storage/db');
            closeHome = () => initiateShutdown('s3 availability integration test');
            const { auth } = await import('@/app/auth/auth');
            const logging = await import('@/utils/logging/log');
            const startupLogs = vi.spyOn(logging, 'log');
            boot = startServer(provider ? 'full' : 'light');
            const { host, port }: { host: string; port: number } = await Promise.race([
                boot.then(() => { throw new Error('Home stopped before readiness'); }),
                vi.waitFor(async () => JSON.parse(await readFile(receiptPath, 'utf8')), { timeout: 45_000 }),
            ]);
            const baseUrl = `http://${host}:${port}`;
            const { id } = await db.account.create({ data: { encryptionMode: 'plain' } });
            const token = await auth.createToken(id, undefined, { kind: 'account', authority: 'present_user' });
            expect((await fetch(`${baseUrl}/v2/sessions`)).status).toBe(401);
            const sessions = await fetch(`${baseUrl}/v2/sessions`, { headers: { authorization: `Bearer ${token}` } });
            expect(sessions.status).toBe(200);
            expect(await sessions.json()).toMatchObject({ sessions: [] });

            const features = await fetch(`${baseUrl}/v1/features`);
            expect(features.status).toBe(200);
            expect(await features.json()).toMatchObject({ capabilities: { server: { fileStorage: {
                public: { status: 'unavailable', reason },
                private: { status: 'unavailable', reason: 'backend_unavailable' },
            } } } });
            expect(startupLogs.mock.calls.filter(([entry]) => entry?.module === 'files')).toEqual([
                [expect.objectContaining({ level: 'warn', status: 'unavailable', reason }), expect.any(String)],
            ]);
        } finally {
            try {
                await closeHome?.();
                await boot?.catch(() => {});
            } finally {
                s3.close();
                vi.restoreAllMocks();
                harness.restore();
                await rm(dir, { recursive: true, force: true });
            }
        }
    }, 180_000);
});
