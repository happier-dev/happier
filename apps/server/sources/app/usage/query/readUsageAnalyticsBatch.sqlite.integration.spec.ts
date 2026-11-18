import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { createDbMaintenanceClient, onDbClientQuery } from '@/storage/prismaClientConstruction';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { getUsageAnalyticsQueryRequestKey, UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { captureUsageAnalyticsBatchInTx } from './readUsageAnalyticsBatch';

describe('SQLite usage accounting batch capture', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-batch-capture-' });
    }, 120_000);

    afterAll(async () => {
        if (harness) await harness.close();
    });

    it('reads all admitted bodies by the account-time index and retains ID selection for a narrower cohort', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('SQLite harness did not supply its scratch database');
        const client = await createDbMaintenanceClient('sqlite', url, { log: [{ emit: 'event', level: 'query' }] });
        const statements: Array<{ query: string; params: string }> = [];
        onDbClientQuery(client, event => {
            if (event.query.startsWith('SELECT') && event.query.includes('UsageEvent')) statements.push(event);
        });
        try {
            const sessions = await Promise.all(['first', 'second'].map(tag => db.session.create({
                data: { accountId: account.id, tag, encryptionMode: 'plain', metadata: '{}' }, select: { id: true },
            })));
            const rows = Array.from({ length: 1_200 }, (_, index) => ({
                id: `${account.id}-${index}`, accountId: account.id, observedAt: new Date(10_000 + index),
                sessionId: sessions[index % 2]!.id, agentId: 'codex', source: 'runtime', scope: 'turn_delta',
                inputTokens: 1, totalTokens: 1,
            }));
            await db.usageEvent.createMany({ data: rows });
            const run = async (sessionIds?: string[]) => {
                statements.length = 0;
                const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 10_000, endMs: 11_200 },
                    filters: sessionIds ? { sessionIds } : undefined });
                const snapshot = await client.$transaction(async tx => {
                    const batch = await captureUsageAnalyticsBatchInTx(tx, account.id, [query]);
                    return batch.snapshots.get(getUsageAnalyticsQueryRequestKey(query));
                });
                const bodies = statements.filter(statement => statement.query.includes('inputTokens'));
                const explain = await Promise.all(bodies.map(async statement => {
                    const params: unknown = JSON.parse(statement.params);
                    if (!Array.isArray(params)) throw new Error('Expected SQLite statement bind array');
                    const plan = await client.$queryRawUnsafe<Array<{ detail: string }>>(`EXPLAIN QUERY PLAN ${statement.query}`, ...params);
                    return plan.map(step => step.detail);
                }));
                console.info(JSON.stringify({ kind: 'usage-accounting-batch-capture', bodyRows: snapshot?.rows.length,
                    bodyReads: bodies.length, evidenceReads: statements.length - bodies.length, explain }));
                return { snapshot, bodies, evidenceReads: statements.length - bodies.length, explain };
            };
            const all = await run();
            expect(all.snapshot?.rows.map(row => row.id)).toEqual(rows.map(row => row.id));
            expect(all.evidenceReads).toBe(1);
            expect(all.bodies).toHaveLength(1);
            expect(all.explain.flat().join(' ')).toMatch(/UsageEvent.*accountId.*observedAt/u);

            const filtered = await run([sessions[0]!.id]);
            expect(filtered.snapshot?.rows.map(row => row.id)).toEqual(rows.filter(row => row.sessionId === sessions[0]!.id).map(row => row.id));
            expect(filtered.evidenceReads).toBe(1);
            expect(filtered.bodies).toHaveLength(1);
            expect(filtered.bodies[0]?.query).toMatch(/\bid["\x60]\s+IN\s*\(/u);
        } finally {
            await client.$disconnect();
        }
    });
});
