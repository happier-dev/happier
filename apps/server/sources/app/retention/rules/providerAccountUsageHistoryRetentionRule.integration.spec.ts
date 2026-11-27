import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildProviderAccountUsageDaySummaryV1 } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import { createUsageSnapshot } from '@/app/api/routes/connect/providerAccountUsageTestkit';
import { createProviderAccountUsageRecord } from '@/app/api/routes/connect/providerAccountUsage/recordStorage';
import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';
import { runRetentionSweep } from '@/app/retention/runtime/runRetentionSweep';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { seedSqliteUsageHistory } from '@/testkit/seedSqliteUsageHistory';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('providerAccountUsageHistory retention', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-provider-usage-history-retention-' });
    }, 120_000);

    afterAll(async () => {
        await harness?.close();
    });

    it('keeps summarized detail with automatic deletion off and prunes it when enabled', async () => {
        const now = new Date('2026-11-15T12:00:00.000Z');
        const policy = readRetentionPolicyFromEnv({});
        expect(policy.enabled).toBe(false);
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const oldDay = Date.UTC(2026, 7, 16); // 91 days before `now`'s day
        const recentDay = Date.UTC(2026, 10, 5);
        const oldSnapshot = createUsageSnapshot({ fetchedAt: oldDay + 1000 });
        const recentSnapshot = createUsageSnapshot({ fetchedAt: recentDay + 1000 });
        const write = (snapshot: typeof oldSnapshot) => ({ accountId: account.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
            payloadMode: 'plain_json_v1' as const, status: 'ok' as const, snapshot, fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs });
        await createProviderAccountUsageRecord(write(recentSnapshot));
        const recordId = recentSnapshot.recordId;
        const rows = [
            { id: `${account.id}-old`, day: oldDay, snapshot: { ...oldSnapshot, recordId } },
            { id: `${account.id}-recent`, day: recentDay, snapshot: recentSnapshot },
        ];
        await seedSqliteUsageHistory(db, rows.map((row) => ({ id: row.id, accountId: account.id, recordId,
            observedAt: new Date(row.snapshot.fetchedAtMs), payload: write(row.snapshot) })));
        for (const row of rows) {
            await db.providerAccountUsageDaySummary.create({ data: { accountId: account.id, recordId, dayStartAt: new Date(row.day), payload: {
                v: 1, coverage: { observationCount: 1, frontier: { id: row.id, observedAtMs: row.snapshot.fetchedAtMs } },
                content: { t: 'plain', v: buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: row.day, snapshots: [row.snapshot] }) },
            } } });
        }
        expect(now.getTime() - oldDay).toBeGreaterThan(90 * DAY_MS);

        const readHistoryIds = async () => (await db.providerAccountUsageHistory.findMany({
            where: { accountId: account.id },
            select: { id: true },
            orderBy: { observedAt: 'asc' },
        })).map((row) => row.id);

        const disabled = await runRetentionSweep({ policy, now });

        expect(disabled.byRule.providerAccountUsageHistory).toBe(0);
        expect(await readHistoryIds()).toEqual(rows.map((row) => row.id));

        const enabled = await runRetentionSweep({
            policy: readRetentionPolicyFromEnv({ HAPPIER_SERVER_RETENTION__ENABLED: 'true' }),
            now,
        });

        expect(enabled.byRule.providerAccountUsageHistory).toBe(1);
        expect(await readHistoryIds()).toEqual([rows[1].id]);
        expect(await db.providerAccountUsageDaySummary.count({ where: { accountId: account.id } })).toBe(rows.length);
    });
});
