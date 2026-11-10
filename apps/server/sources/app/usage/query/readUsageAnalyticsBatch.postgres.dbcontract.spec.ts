import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { TEAM_CREDENTIAL_ONLY_USAGE_SOURCES } from '../usageSourceClassifier';
import { captureUsageAnalyticsBatchInTx, projectUsageAnalyticsBatch } from './readUsageAnalyticsBatch';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Usage batch capture read cost on PostgreSQL', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Requires the disposable PostgreSQL DB-contract owner');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(shutdownDbClient);

    it('reads covered history once and retains selective hydration when the window changes', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        // The diagnosed Account's 90D query returned this many rows in both evidence and body reads.
        const eventCount = 74_212;
        const prefix = randomUUID();
        try {
            await db.$executeRaw`
                INSERT INTO "UsageEvent" ("id", "accountId", "observedAt", "agentId", "source", "scope",
                    "inputTokens", "totalTokens", "updatedAt")
                SELECT ${prefix} || '-' || n, ${account.id}, CAST('1970-01-01T00:00:00.150Z' AS timestamp),
                    'codex', 'runtime', 'turn_delta', 1, 1, now()
                FROM generate_series(1, ${eventCount}::int) AS n`;
            // Non-personal events must not turn a fully covered personal window into a historical scan.
            await db.usageEvent.create({ data: { accountId: account.id, observedAt: new Date(50), agentId: 'codex',
                source: TEAM_CREDENTIAL_ONLY_USAGE_SOURCES[0], scope: 'turn_delta', totalTokens: 999 } });
            const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 100, endMs: 200 },
                includeActivity: true, includeInsights: false, includeMessageStats: false });
            const capture = async (startMs: number) => {
                const cost = { evidenceRows: 0, bodyRows: 0 };
                const request = { ...query, dateRange: { startMs, endMs: 200 } };
                const snapshot = await inReadSnapshot(tx => captureUsageAnalyticsBatchInTx(new Proxy(tx, {
                    get(target, property, receiver) {
                        if (property !== '$queryRaw') return Reflect.get(target, property, receiver);
                        // Observe the real persistent boundary; selection and accounting remain real.
                        return async (...args: unknown[]) => {
                            const rows: unknown = await Reflect.apply(target.$queryRaw, target, args);
                            if (Array.isArray(rows) && rows[0] && Object.hasOwn(rows[0], 'observedAt')) {
                                if (Object.hasOwn(rows[0], 'totalTokens')) cost.bodyRows += rows.length;
                                else cost.evidenceRows += rows.length;
                            }
                            return rows;
                        };
                    },
                }) as Tx, account.id, [request]));
                const result = await projectUsageAnalyticsBatch(snapshot, [request], false);
                return { cost, result };
            };
            const covered = await capture(100);
            expect(covered.cost, 'a covering window must not transfer the same event history twice')
                .toEqual({ evidenceRows: 0, bodyRows: eventCount });
            const coveredResult = covered.result.results[0]!;
            if (!('value' in coveredResult)) throw new Error('Covered Usage query failed');
            expect(coveredResult.value.totals.tokens.total).toBe(eventCount);

            await db.usageEvent.create({ data: { accountId: account.id, observedAt: new Date(50), agentId: 'codex',
                source: 'historical', scope: 'turn_delta', inputTokens: 7, totalTokens: 7 } });
            const narrow = await capture(160);
            expect(narrow.cost, 'a changed window keeps complete coverage evidence without hydrating unrelated bodies')
                .toEqual({ evidenceRows: eventCount + 1, bodyRows: 0 });
            const narrowResult = narrow.result.results[0]!;
            if (!('value' in narrowResult)) throw new Error('Narrow Usage query failed');
            expect(narrowResult.value.totals.tokens.total).toBeNull();
            expect(narrowResult.value.coverage?.sources.some(source => source.source === 'historical')).toBe(true);
        } finally {
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
