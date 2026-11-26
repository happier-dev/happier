import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPostgresMigrations } from '../../../../../../scripts/prismaMigrations';
import { openPgliteMigrationSession, type PgliteMigrationSession } from '../../../../../../scripts/pgliteMigrationSession';
import type { Prisma } from '@prisma/client';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { prismaRuntime } from '@/storage/prisma';
import { inTx } from '@/storage/inTx';
import { applyEnvValues, restoreEnv, snapshotEnv } from '@/testkit/env';
import { createUsageSnapshot } from '../providerAccountUsageTestkit';
import { setProviderAccountUsagePendingDays } from './daySummaryPendingStorage';
import { createProviderAccountUsageRecord, retainProviderAccountUsageHistory } from './recordStorage';
import { readProviderAccountUsageDaySummaries, writeProviderAccountUsageDaySummary,
    readExpiredProviderAccountUsageSummaryDays, pruneProviderAccountUsageSummaryDetail } from './daySummaryStorage';
import { buildProviderAccountUsageDaySummaryV1, packProviderAccountUsageDaySummaryV1, PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';

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
            const legacy = await readProviderAccountUsageDaySummaries({ ...query, requireClockBounds: true }, tx);
            expect(legacy).toEqual({ summaries: [{ dayStartAtMs, payload }], missingDays: [{ dayStartAtMs, coverage: payload.coverage }] });
            expect(await writeProviderAccountUsageDaySummary({ accountId: account.id, value: { recordId: first.recordId, dayStartAtMs,
                payload: { ...payload, clockBoundsVersion: 1 } } }, tx)).toBe(true);
            expect(await readProviderAccountUsageDaySummaries({ ...query, requireClockBounds: true }, tx)).toEqual({ summaries: [], missingDays: [] });
            const compact = await readProviderAccountUsageDaySummaries({ ...query, requireCompact: true }, tx);
            expect(compact.missingDays).toEqual([{ dayStartAtMs, coverage: payload.coverage, rewriteOnly: true }]);
            expect(await writeProviderAccountUsageDaySummary({ accountId: account.id, value: { recordId: first.recordId, dayStartAtMs,
                payload: { ...payload, clockBoundsVersion: 1, encoding: PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING,
                    content: { t: 'plain', v: packProviderAccountUsageDaySummaryV1(payload.content.v) } } } }, tx)).toBe(true);
            expect(await readProviderAccountUsageDaySummaries({ ...query, requireCompact: true }, tx)).toEqual({ summaries: [], missingDays: [] });
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
            expect((await readProviderAccountUsageDaySummaries({ ...query, requireClockBounds: true }, tx)).missingDays)
                .toEqual([{ dayStartAtMs, coverage: { observationCount: 0, frontier: null } }]);
            const record = await tx.providerAccountUsageRecord.findUniqueOrThrow({ where: { accountId_recordId: { accountId: account.id, recordId: first.recordId } } });
            expect(record.metadata).toEqual({ materialFingerprint: 'keep' });
        });
    });

    it.each([
        { name: 'stored pending day', hasPendingIndex: true, legacy: null },
        { name: 'legacy discovery', hasPendingIndex: false, legacy: null },
        { name: 'legacy epoch summary with bounds', hasPendingIndex: false, legacy: 'bounded' },
        { name: 'pending legacy epoch summary', hasPendingIndex: true, legacy: 'bounded' },
        { name: 'legacy epoch body without bounds', hasPendingIndex: false, legacy: 'unbounded' },
    ])('seeks past unread-only history on the $name path', async ({ hasPendingIndex, legacy }) => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const measured = createUsageSnapshot({ fetchedAt: 1000 });
        const unread = { ...measured, fetchedAtMs: 0, observedAtMs: 0, state: 'not_loaded' as const, meters: [] };
        const key = { accountId: account.id, recordId: unread.recordId };
        const write = { ...key, recordKey: unread.recordKey, payloadMode: 'plain_json_v1' as const, status: 'unavailable' as const,
            snapshot: unread, fetchedAt: 0, staleAfterMs: unread.staleAfterMs,
            ...(hasPendingIndex ? { metadata: { daySummaryPendingDays: [0] } } : {}) };
        await createProviderAccountUsageRecord(write);
        const legacySummary = buildProviderAccountUsageDaySummaryV1({ recordId: key.recordId, dayStartAtMs: 0, snapshots: [unread] });
        const { observedAtRange: _bounds, ...withoutBounds } = legacySummary;
        const legacyPayload = { v: 1 as const, coverage: { observationCount: 0, frontier: null },
            content: { t: 'plain' as const, v: legacy === 'unbounded' ? withoutBounds : legacySummary } };
        if (legacy) {
            await inTx(async tx => {
                expect(await writeProviderAccountUsageDaySummary({
                    accountId: key.accountId, value: { recordId: key.recordId, dayStartAtMs: 0, payload: legacyPayload },
                }, tx)).toBe(true);
                if (hasPendingIndex) await setProviderAccountUsagePendingDays(key, [0], tx);
            });
        }
        const sentinelRows = 201;
        await db.providerAccountUsageHistory.createMany({ data: Array.from({ length: sentinelRows }, () => ({
            ...key, observedAt: new Date(0), payload: write,
        })) });

        type Plan = {
            'Node Type': string;
            'Relation Name'?: string;
            'Index Cond'?: string;
            'Actual Rows': number;
            'Actual Loops': number;
            'Rows Removed by Filter'?: number;
            Plans?: Plan[];
        };
        const historyScans = (plan: Plan): Plan[] => [
            ...(plan['Relation Name'] === 'ProviderAccountUsageHistory' ? [plan] : []),
            ...(plan.Plans ?? []).flatMap(historyScans),
        ];

        await inTx(async tx => {
            await tx.$executeRaw`ANALYZE "ProviderAccountUsageHistory"`;
            let queries = 0;
            const scans: Plan[] = [];
            const rankedScans: Plan[] = [];
            const storage = {
                providerAccountUsageDaySummary: tx.providerAccountUsageDaySummary,
                providerAccountUsageHistory: tx.providerAccountUsageHistory,
                $executeRaw: tx.$executeRaw,
                $queryRaw: async <T>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<T> => {
                    queries++;
                    if ('sql' in query && query.sql.includes('"ProviderAccountUsageHistory"')) {
                        const explained = await tx.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>>(
                            prismaRuntime.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`);
                        const history = historyScans(explained[0]!['QUERY PLAN'][0]!.Plan);
                        scans.push(...history);
                        if (query.sql.includes('COUNT(*) OVER')) rankedScans.push(...history);
                    }
                    return tx.$queryRaw<T>(query, ...values);
                },
            };
            const query = { ...key, range: { startAtMs: 0, endAtMs: 86_400_000 },
                includeMissingDays: true, requireClockBounds: true, requireCompact: true };
            expect.soft(await readProviderAccountUsageDaySummaries(query, storage)).toEqual({ summaries: [], missingDays: [] });
            expect.soft(scans.length).toBeGreaterThan(0);
            const visits = scans.reduce((rows, scan) =>
                rows + (scan['Actual Rows'] + (scan['Rows Removed by Filter'] ?? 0)) * scan['Actual Loops'], 0);
            expect.soft(rankedScans).toEqual([]);
            expect.soft(visits, `history rows visited for ${sentinelRows} unread rows; ${scans.map(scan => scan['Node Type']).join(', ')}`).toBe(legacy ? 1 : 0);
            expect.soft(scans.every(scan => /Index/.test(scan['Node Type']) && scan['Index Cond']?.includes('"observedAt" >'))).toBe(true);
            expect.soft(queries).toBe(legacy && !hasPendingIndex ? 4 : 3);
            const coverage = await readProviderAccountUsageDaySummaries({ ...key, range: query.range, includeCoverage: true }, tx);
            expect(coverage.missingDays).toMatchObject([{ dayStartAtMs: 0, coverage: { observationCount: sentinelRows } }]);

            // Once a real observation exists, coverage still proves every
            // physical row of the mixed day for the ordinary write CAS.
            const measuredWrite = { ...write, snapshot: measured, status: 'ok' as const, fetchedAt: measured.fetchedAtMs };
            await tx.providerAccountUsageHistory.create({ data: {
                ...key, observedAt: new Date(measured.fetchedAtMs), payload: measuredWrite,
            } });
            const mixed = await readProviderAccountUsageDaySummaries(query, tx);
            expect(mixed.missingDays).toMatchObject([{ dayStartAtMs: 0, coverage: {
                observationCount: sentinelRows + 1, frontier: { observedAtMs: measured.fetchedAtMs },
            } }]);
            const payload = { v: 1 as const, coverage: mixed.missingDays[0]!.coverage,
                content: { t: 'plain' as const, v: packProviderAccountUsageDaySummaryV1(buildProviderAccountUsageDaySummaryV1({
                    recordId: key.recordId, dayStartAtMs: 0, snapshots: [measured],
                })) }, encoding: PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING, clockBoundsVersion: 1 as const };
            expect(await writeProviderAccountUsageDaySummary({ accountId: key.accountId,
                value: { recordId: key.recordId, dayStartAtMs: 0, payload } }, tx)).toBe(true);
            if (!hasPendingIndex) {
                // A subsequent publication initializes the legacy pending leaf.
                await setProviderAccountUsagePendingDays(key, [], tx);
            }
            queries = 0;
            scans.length = 0;
            expect(await readProviderAccountUsageDaySummaries(query, storage)).toEqual({ summaries: [], missingDays: [] });
            expect(scans).toEqual([]);
            expect(queries).toBe(2);

            if (legacy) {
                // An old summary whose exact detail was compacted still needs its rewrite.
                await tx.providerAccountUsageHistory.deleteMany({ where: key });
                expect(await writeProviderAccountUsageDaySummary({
                    accountId: key.accountId, value: { recordId: key.recordId, dayStartAtMs: 0, payload: legacyPayload },
                }, tx)).toBe(true);
                expect(await readProviderAccountUsageDaySummaries(query, tx)).toEqual({
                    summaries: [{ dayStartAtMs: 0, payload: legacyPayload }],
                    missingDays: [{ dayStartAtMs: 0, coverage: legacyPayload.coverage, rewriteOnly: true }],
                });
            }
        });
    });
});
