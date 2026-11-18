import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { inReadSnapshot } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { loadUsageEventsForQuery } from './loadUsageEventsForQuery';

describe('loadUsageEventsForQuery SQLite transport', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-event-read-' });
    }, 120_000);

    afterAll(async () => {
        if (harness) await harness.close();
    });

    it('keeps the day predicate inside the portable bind budget while chunking event ids', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        try {
            const ids = Array.from({ length: 1_200 }, (_, index) => `usage-read-${index}`);
            await db.usageEvent.createMany({ data: ids.map((id, index) => ({
                id, accountId: account.id, observedAt: new Date(index * 86_400_000), agentId: 'codex',
                source: 'runtime', scope: 'turn_delta', totalTokens: 1,
            })) });
            const request = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { endMs: 365 * 86_400_000 } });
            const rows = await inReadSnapshot(tx => loadUsageEventsForQuery(tx, account.id, request, ids, Array.from({ length: 365 }, (_, day) => day * 86_400_000)));
            expect(rows).toHaveLength(365);
        } finally {
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
