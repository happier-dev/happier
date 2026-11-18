import { expect, it } from 'vitest';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { loadUsageMessageCountsBySessionInTx } from './loadUsageMessageStatsForQuery';

it("counts published messages across distinct Session ceilings beyond SQLite's binding limit", async () => {
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-messages-', initAuth: false });
    try {
        const { id: accountId } = await db.account.create({ data: { publicKey: 'message-ceiling-scale' } });
        const population = Array.from({ length: 1_100 }, (_, index) => ({
            id: `message-ceiling-${index}`, ceiling: index + 1,
        }));
        await db.session.createMany({ data: population.map(({ id, ceiling }) => ({
            id, accountId, tag: id, encryptionMode: 'e2ee', metadata: 'ciphertext',
            currentStorageState: 'server_partial', acceptedThroughServerSeq: ceiling, seq: ceiling + 1,
        })) });
        await db.usageEvent.createMany({ data: population.map(({ id }) => ({
            accountId, sessionId: id, observedAt: new Date(150), agentId: 'codex',
            source: 'codex_app_server', scope: 'turn_delta', totalTokens: 1,
        })) });
        await db.sessionMessage.createMany({ data: population.flatMap(({ id, ceiling }) => [ceiling, ceiling + 1].map(seq => ({
            sessionId: id, seq, content: { t: 'encrypted', c: 'ciphertext' }, createdAt: new Date(160),
        }))) });
        const request = UsageAnalyticsQueryRequestSchema.parse({
            includeMessageStats: true, dateRange: { startMs: 100, endMs: 200 },
        });
        const readCounts = (sessionIds?: string[]) => inTx(tx =>
            loadUsageMessageCountsBySessionInTx(tx, accountId, request, sessionIds), { readOnly: true });
        expect(await readCounts([population[0]!.id])).toEqual(new Map([[population[0]!.id, 1]]));
        const expected = new Map(population.map(({ id }) => [id, 1]));
        expect(await readCounts()).toEqual(expected);
        expect(await readCounts([...expected.keys()])).toEqual(expected);
    } finally {
        await harness.close();
    }
}, 120_000);
