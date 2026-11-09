import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { applyPostgresMigrations } from '../../../../scripts/prismaMigrations';
import { openPgliteMigrationSession, type PgliteMigrationSession } from '../../../../scripts/pgliteMigrationSession';
import { eventRouter } from '@/app/events/eventRouter';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { applyEnvValues, restoreEnv, snapshotEnv } from '@/testkit/env';
import { assertKeepaliveRealtimeFreshness } from './sessionUpdateHandler.presence.testkit';

describe('Retained legacy Session keepalive through the incumbent PostgreSQL wire harness', () => {
    const originalEnv = snapshotEnv();
    let root: string | undefined;
    let session: PgliteMigrationSession | undefined;
    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-session-keepalive-pg-'));
        const databaseDir = join(root, 'pglite');
        const database = new PGlite(databaseDir);
        try {
            await database.waitReady;
            await applyPostgresMigrations({ db: database, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        } finally { await database.close(); }
        applyEnvValues({ HAPPIER_SERVER_LIGHT_DB_DIR: databaseDir, HAPPIER_SERVER_LIGHT_DATA_DIR: root });
        session = await openPgliteMigrationSession(process.env, { purpose: 'session-keepalive-test' });
        // Exercise the real PostgreSQL Prisma client and wire protocol, not the PGlite adapter.
        applyEnvValues({ HAPPIER_DB_PROVIDER: 'postgres', HAPPY_DB_PROVIDER: 'postgres', DATABASE_URL: session.databaseUrl });
        initDbPostgres();
        await db.$connect();
    }, 120_000);
    afterAll(async () => {
        eventRouter.clearIo();
        try { await shutdownDbClient(); } finally {
            await session?.close();
            restoreEnv(originalEnv);
            if (root) await rm(root, { recursive: true, force: true });
        }
    });
    it('delivers two minute-spaced realtime heartbeats to owner and shared viewer with no Account cursor',
        assertKeepaliveRealtimeFreshness);
});
