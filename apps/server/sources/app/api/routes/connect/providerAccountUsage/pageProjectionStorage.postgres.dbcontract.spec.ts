import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { createUsageSnapshot } from '../providerAccountUsageTestkit';
import { hasProviderAccountUsageHistory, upsertProviderAccountUsageRecord } from './recordStorage';
import { readProviderAccountUsagePageProjection } from './pageProjectionStorage';
import { PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { createDbMaintenanceClient, onDbClientQuery } from '@/storage/prisma';

interface SqlPlan {
    'Relation Name'?: string;
    'Rows Removed by Filter'?: number;
    Plans?: SqlPlan[];
}

function filteredHistoryRows(plan: SqlPlan): number {
    return (plan['Relation Name'] === 'ProviderAccountUsageHistory' ? plan['Rows Removed by Filter'] ?? 0 : 0)
        + (plan.Plans ?? []).reduce((total, child) => total + filteredHistoryRows(child), 0);
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('usage projection retained-history work (PostgreSQL)', () => {
    let accountId: string;
    let databaseUrl: string;

    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error('Use the disposable PostgreSQL DB-contract harness');
        databaseUrl = supplied;
        initDbPostgres();
        await db.$connect();
        accountId = (await db.account.create({ data: { id: randomUUID(), publicKey: null, encryptionMode: 'plain' } })).id;
    });

    afterAll(async () => {
        if (accountId) await db.account.delete({ where: { id: accountId } });
        await db.$disconnect();
    });

    it('counts a retained prefix once and uses the existing index to seek an empty tail', async () => {
        const snapshot = createUsageSnapshot({ fetchedAt: Date.UTC(2026, 0, 1) });
        const other = createUsageSnapshot({ fetchedAt: snapshot.fetchedAtMs,
            recordKey: { ...snapshot.recordKey, accountSubjectId: 'unrelated-subject' } });
        for (const value of [snapshot, other]) await upsertProviderAccountUsageRecord({ accountId,
            recordId: value.recordId, recordKey: value.recordKey, payloadMode: 'plain_json_v1', status: 'ok',
            fetchedAt: value.fetchedAtMs, staleAfterMs: value.staleAfterMs, snapshot: value });
        // Only row cardinality/identity is under test; payload decoding has its
        // own real-storage suite. Avoid inflating this planner fixture's JSON.
        // Raw Date parameters bind as timestamptz. Preserve Prisma's UTC wall
        // time in this timestamp column independently of the database timezone.
        for (const [recordId, count] of [[other.recordId, 86000], [snapshot.recordId, 68000]] as const) {
            await db.$executeRaw`INSERT INTO "ProviderAccountUsageHistory" (id, "accountId", "recordId", "observedAt", payload)
                SELECT ${recordId} || '-' || lpad(i::text, 8, '0'), ${accountId}, ${recordId},
                    (${new Date(snapshot.fetchedAtMs)}::timestamptz AT TIME ZONE 'UTC') + i * interval '1 millisecond', '{}'::jsonb
                FROM generate_series(1, ${count}::integer) AS i`;
        }
        await db.$executeRawUnsafe('ANALYZE "ProviderAccountUsageHistory"');
        const demand = { range: { startAtMs: snapshot.fetchedAtMs, endAtMs: snapshot.fetchedAtMs + 86400000 }, resolution: 'accepted_observations' as const };
        const frontier = { id: snapshot.recordId + '-00068000', observedAtMs: snapshot.fetchedAtMs + 68000 };
        const projection = { recordId: snapshot.recordId, encoding: PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING,
            demand, frontier, observationCount: 68000, content: { t: 'encrypted' as const, c: 'synthetic-planner-fixture' } };
        await db.providerAccountUsageRecord.update({ where: { accountId_recordId: { accountId, recordId: snapshot.recordId } },
            data: { metadata: { pageProjection: projection } } });
        const client = await createDbMaintenanceClient('postgres', databaseUrl, { log: [{ emit: 'event', level: 'query' }] });
        const queries: Array<{ label: string; query: string; params: unknown[]; actorId: string; recordId: string }> = [];
        let label = 'current-read';
        onDbClientQuery(client, event => {
            if (label && event.query.includes('ProviderAccountUsageHistory')) queries.push({ label, query: event.query,
                params: JSON.parse(event.params), actorId: accountId, recordId: snapshot.recordId });
        });
        try {
            let countedRows = 0;
            const storage = { providerAccountUsageRecord: client.providerAccountUsageRecord,
                providerAccountUsageHistory: new Proxy(client.providerAccountUsageHistory, {
                    get(target, property, receiver) {
                        if (property === 'count') return async (args: Pick<NonNullable<Parameters<typeof target.count>[0]>, 'where'>) => {
                            const count = await target.count(args);
                            countedRows += count;
                            return count;
                        };
                        return Reflect.get(target, property, receiver);
                    },
                }) };
            const result = await readProviderAccountUsagePageProjection({ accountId, recordId: snapshot.recordId,
                projection: demand, heldProjection: { demand, frontier, observationCount: 68000, contentMode: 'encrypted' } }, storage);
            label = 'current-exists';
            const hasHistory = await hasProviderAccountUsageHistory({ accountId, recordId: snapshot.recordId }, client);
            label = 'baseline-total-count';
            await client.providerAccountUsageHistory.count({ where: { accountId, recordId: snapshot.recordId,
                observedAt: { gte: new Date(demand.range.startAtMs), lt: new Date(demand.range.endAtMs) } } });
            label = 'baseline-page';
            await client.providerAccountUsageRecord.findUnique({ where: { accountId_recordId: { accountId, recordId: snapshot.recordId } },
                select: { history: { where: { observedAt: { gte: new Date(demand.range.startAtMs), lt: new Date(demand.range.endAtMs) } },
                    orderBy: [{ observedAt: 'asc' }, { id: 'asc' }], take: 101, select: { id: true, observedAt: true, payload: true } } } });
            label = 'baseline-exists';
            await client.providerAccountUsageRecord.findUnique({ where: { accountId_recordId: { accountId, recordId: snapshot.recordId } },
                select: { history: { take: 1, select: { id: true } } } });
            label = 'baseline-witness';
            await client.providerAccountUsageRecord.findUnique({ where: { accountId_recordId: { accountId, recordId: snapshot.recordId } },
                select: { history: { where: { id: frontier.id, observedAt: new Date(frontier.observedAtMs) },
                    select: { id: true, observedAt: true, payload: true } } } });
            label = '';
            const plans = [];
            for (const query of queries) {
                const values = query.params.map(value => typeof value === 'string' && /^\d{4}-\d\d-\d\d[ T]/.test(value) ? new Date(value) : value);
                const plan = await client.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: SqlPlan }> }>>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.query}`, ...values);
                plans.push({ label: query.label, query: query.query, plan });
            }
            const evidenceDir = resolve('../../.project/tmp/dbperf');
            await mkdir(evidenceDir, { recursive: true });
            await writeFile(resolve(evidenceDir, 'history-sql.json'), JSON.stringify({ queries }, null, 2));
            await writeFile(resolve(evidenceDir, 'history-plans.json'), JSON.stringify({ rows: 154000, selectedRecordRows: 68000, plans }, null, 2));
            console.log('HISTORY_QUERY_EVIDENCE', JSON.stringify({ countedRows, queries, plans }));
            expect(result).toMatchObject({ projection, complete: true, prefix: { complete: true } });
            expect(countedRows).toBe(68000);
            expect(hasHistory).toBe(true);
            for (const entry of plans.filter(entry => entry.label.startsWith('current-') && !entry.query.includes('COUNT(*)'))) {
                // The tuple-after predicate may reject this fixture's single
                // frontier row, but must not visit the 86k unrelated rows.
                expect(filteredHistoryRows(entry.plan[0]!['QUERY PLAN'][0]!.Plan), entry.label)
                    .toBeLessThanOrEqual(entry.label === 'current-exists' ? 0 : 1);
            }
        } finally { await client.$disconnect(); }
    });
});
