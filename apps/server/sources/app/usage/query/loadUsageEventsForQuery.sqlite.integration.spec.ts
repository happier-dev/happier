import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { inReadSnapshot } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { createDbMaintenanceClient, onDbClientQuery } from '@/storage/prismaClientConstruction';
import { captureUsageActivityRoutingInTx } from './usageActivitySummaryRouting';
import { readUsageActivitySourceChanges } from './usageActivitySummaryStore';
import { loadUsageEventsForQuery } from './loadUsageEventsForQuery';

describe('loadUsageEventsForQuery SQLite transport', () => {
    let harness: LightSqliteHarness;
    const dayMs = 86_400_000;

    async function seedDays(dayCount: number) {
        const account = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const data = Array.from({ length: dayCount }, (_, day) => [0, dayMs - 1].map(offset => ({
            id: `${account.id}-${day}-${offset}`, accountId: account.id, observedAt: new Date(day * dayMs + offset),
            agentId: 'codex', source: 'runtime', scope: 'turn_delta', totalTokens: 1,
        }))).flat();
        await db.usageEvent.createMany({ data });
        return { account, data, days: Array.from({ length: dayCount }, (_, day) => day * dayMs),
            request: UsageAnalyticsQueryRequestSchema.parse({ dateRange: { endMs: dayCount * dayMs } }) };
    }

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

    it('conserves both adjacent-day edges and global order for an unbounded day-only selection', async () => {
        const { account, data, days, request } = await seedDays(500);
        try {
            const rows = await inReadSnapshot(tx => loadUsageEventsForQuery(tx, account.id, request, undefined, [...days, ...days].reverse()));
            expect(rows.map(row => row.id)).toEqual(data.map(row => row.id));
            expect(new Set(rows.map(row => row.id)).size).toBe(data.length);
            expect(await inReadSnapshot(tx => loadUsageEventsForQuery(tx, account.id, request, undefined, []))).toEqual([]);
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

    it('uses the emitted account, end, source and LIMIT/OFFSET binds without a guessed reserve', async () => {
        const { account, data, days, request } = await seedDays(500);
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('SQLite harness did not supply its scratch database');
        const client = await createDbMaintenanceClient('sqlite', url, { log: [{ emit: 'event', level: 'query' }] });
        const binds: number[] = [];
        onDbClientQuery(client, event => { if (event.query.startsWith('SELECT') && event.query.includes('UsageEvent')) binds.push(JSON.parse(event.params).length); });
        try {
            const ids = data.slice(0, 994).map(row => row.id);
            const rows = await loadUsageEventsForQuery(client, account.id, request, ids);
            expect(rows.map(row => row.id)).toEqual(ids);
            // The first 993 IDs plus four predicates and two pagination operands
            // fill the measured 999-variable SQLite boundary exactly.
            expect(binds).toEqual([999, 7]);
            binds.length = 0;
            const selected = await loadUsageEventsForQuery(client, account.id, request, [ids[0]!], days.slice(0, 488));
            expect(selected.map(row => row.id)).toEqual([ids[0]]);
            expect(binds).toEqual([983]);
            binds.length = 0;
            const both = await loadUsageEventsForQuery(client, account.id, request, ids, days);
            expect(both.map(row => row.id)).toEqual(ids);
            expect(binds.every(count => count <= 999)).toBe(true);
            // Two balanced 250-day selections leave 493 IDs per query: three
            // ID partitions each, rather than hundreds of one-ID SELECTs.
            expect(binds.length).toBeLessThanOrEqual(6);
        } finally { await client.$disconnect(); await db.account.delete({ where: { id: account.id } }); }
    });

    it('admits a real warm-routing import spanning 500 changed historical days', async () => {
        const { account, data, request } = await seedDays(500);
        try {
            const capture = await inReadSnapshot(async tx => {
                const changes = await readUsageActivitySourceChanges(tx, account.id, request.dateRange?.endMs);
                expect(changes).toHaveLength(500);
                return captureUsageActivityRoutingInTx(tx, account.id, request, changes, {
                    sourceDays: [], subjectKeys: [], sessionKeys: [], sourceCoverage: [], reportSources: [],
                    legacyReports: [], subjectCount: 0, projectionDays: [],
                });
            });
            expect(capture.discoveryEventsRead).toBe(data.length);
            expect(new Set(capture.rows.map(row => row.id))).toEqual(new Set(data.map(row => row.id)));
            expect(capture.sourceDays.size).toBe(500);
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

});
