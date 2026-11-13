import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPostgresMigrations } from '../../../../../../scripts/prismaMigrations';
import { openPgliteMigrationSession, type PgliteMigrationSession } from '../../../../../../scripts/pgliteMigrationSession';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { applyEnvValues, restoreEnv, snapshotEnv } from '@/testkit/env';
import { createUsageSnapshot } from '../providerAccountUsageTestkit';
import { createProviderAccountUsageRecord, retainProviderAccountUsageHistory } from './recordStorage';
import { readProviderAccountUsageDaySummaries, writeProviderAccountUsageDaySummary,
    readExpiredProviderAccountUsageSummaryDays, pruneProviderAccountUsageSummaryDetail } from './daySummaryStorage';
import { buildProviderAccountUsageDaySummaryV1 } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';

describe('usage day summaries PostgreSQL storage', () => {
    const originalEnv = snapshotEnv();
    let root: string | undefined;
    let session: PgliteMigrationSession | undefined;
    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-usage-days-pg-'));
        const databaseDir = join(root, 'pglite');
        const database = new PGlite(databaseDir);
        try {
            await database.waitReady;
            await applyPostgresMigrations({ db: database, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        } finally { await database.close(); }
        applyEnvValues({ HAPPIER_SERVER_LIGHT_DB_DIR: databaseDir, HAPPIER_SERVER_LIGHT_DATA_DIR: root });
        session = await openPgliteMigrationSession(process.env, { purpose: 'usage-day-storage-test' });
        applyEnvValues({ HAPPIER_DB_PROVIDER: 'postgres', HAPPY_DB_PROVIDER: 'postgres', DATABASE_URL: session.databaseUrl });
        initDbPostgres();
        await db.$connect();
    }, 120_000);
    afterAll(async () => {
        try { await shutdownDbClient(); } finally {
            await session?.close(); restoreEnv(originalEnv);
            if (root) await rm(root, { recursive: true, force: true });
        }
    });

    it('preserves UTC day identity, invalidates opaque coverage and compacts partial batches atomically', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const dayStartAtMs = Date.UTC(2026, 0, 1);
        const first = createUsageSnapshot({ fetchedAt: dayStartAtMs + 1000 });
        const later = { ...first, fetchedAtMs: dayStartAtMs + 2000, observedAtMs: dayStartAtMs + 2000, planLabel: 'changed' };
        const write = (snapshot: typeof first) => ({ accountId: account.id, recordId: first.recordId, recordKey: first.recordKey,
            payloadMode: 'plain_json_v1' as const, status: 'ok' as const, snapshot,
            fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs });
        await createProviderAccountUsageRecord(write(first));
        await inTx(tx => retainProviderAccountUsageHistory(write(first), tx));
        const query = { accountId: account.id, recordId: first.recordId,
            range: { startAtMs: dayStartAtMs, endAtMs: dayStartAtMs + 86_400_000 }, includeMissingDays: true };
        await inTx(async tx => {
            await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Auckland'");
            const missing = await readProviderAccountUsageDaySummaries(query, tx);
            expect(missing.missingDays).toMatchObject([{ dayStartAtMs, coverage: { observationCount: 1, frontier: { observedAtMs: first.fetchedAtMs } } }]);
            const payload = { v: 1 as const, coverage: missing.missingDays[0]!.coverage,
                content: { t: 'plain' as const, v: buildProviderAccountUsageDaySummaryV1({ recordId: first.recordId, dayStartAtMs, snapshots: [first] }) } };
            expect(await writeProviderAccountUsageDaySummary({ accountId: account.id, value: { recordId: first.recordId, dayStartAtMs, payload } }, tx)).toBe(true);
        });
        await inTx(tx => retainProviderAccountUsageHistory(write(later), tx));
        await inTx(async tx => {
            await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Auckland'");
            const missing = await readProviderAccountUsageDaySummaries(query, tx);
            expect(missing.summaries[0]!.payload.coverage).toEqual({ observationCount: 0, frontier: null });
            expect(missing.missingDays[0]!.coverage.observationCount).toBe(2);
            const payload = { v: 1 as const, coverage: missing.missingDays[0]!.coverage,
                content: { t: 'plain' as const, v: buildProviderAccountUsageDaySummaryV1({ recordId: first.recordId, dayStartAtMs, snapshots: [first, later] }) } };
            expect(await writeProviderAccountUsageDaySummary({ accountId: account.id, value: { recordId: first.recordId, dayStartAtMs, payload } }, tx)).toBe(true);
            await tx.providerAccountUsageRecord.update({ where: { accountId_recordId: { accountId: account.id, recordId: first.recordId } },
                data: { metadata: { materialFingerprint: 'keep', pageProjection: { legacy: 'opaque' } } } });
            const cutoff = new Date(dayStartAtMs + 86_400_000);
            const days = await readExpiredProviderAccountUsageSummaryDays({ cutoff, limit: 1 }, tx);
            expect(days).toEqual([{ accountId: account.id, recordId: first.recordId, dayStartAtMs }]);
            expect((await pruneProviderAccountUsageSummaryDetail({ ...days[0]!, cutoff, limit: 1, dryRun: false }, tx)).deleted).toBe(1);
            expect((await readProviderAccountUsageDaySummaries({ ...query, includeMissingDays: false }, tx)).summaries[0]!.payload)
                .toEqual({ ...payload, coverage: { observationCount: 1, frontier: payload.coverage.frontier } });
            expect((await pruneProviderAccountUsageSummaryDetail({ ...days[0]!, cutoff, limit: 1, dryRun: false }, tx)).deleted).toBe(1);
            expect((await readProviderAccountUsageDaySummaries({ ...query, includeMissingDays: false }, tx)).summaries[0]!.payload)
                .toEqual({ ...payload, coverage: { observationCount: 0, frontier: null } });
            expect(await readExpiredProviderAccountUsageSummaryDays({ cutoff, limit: 1 }, tx)).toEqual([]);
            const record = await tx.providerAccountUsageRecord.findUniqueOrThrow({ where: { accountId_recordId: { accountId: account.id, recordId: first.recordId } } });
            expect(record.metadata).toEqual({ materialFingerprint: 'keep' });
        });
    });
});
