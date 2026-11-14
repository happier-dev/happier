import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { prismaRuntime } from '@/storage/prisma';
import { loadUsageAccountingRowsForQuery } from './loadUsageAccountingRowsForQuery';
import { usageEventSelect } from './loadUsageEventsForQuery';
import { legacyUsageReportAgentId } from '../legacyUsageReportSchema';

function sumWindowMembershipRows(plan: unknown): number {
    if (!plan || typeof plan !== 'object') return 0;
    const ownRows = Reflect.get(plan, 'Node Type') === 'CTE Scan' && Reflect.get(plan, 'CTE Name') === 'window_rows'
        ? Number(Reflect.get(plan, 'Actual Rows')) * Number(Reflect.get(plan, 'Actual Loops')) : 0;
    return ownRows + Object.values(plan).reduce<number>((sum, child) => sum + sumWindowMembershipRows(child), 0);
}

function findHistoryPlans(plan: unknown): unknown[] {
    if (!plan || typeof plan !== 'object') return [];
    if (Reflect.get(plan, 'Subplan Name') === 'CTE history') return [plan];
    return Object.values(plan).flatMap(findHistoryPlans);
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Usage accounting result materialization on PostgreSQL', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Requires the disposable PostgreSQL DB-contract owner');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(shutdownDbClient);

    it('does not scan captured window identities again to exclude them from history', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        try {
            const eventCount = 128;
            await db.usageEvent.createMany({ data: Array.from({ length: eventCount }, () => ({
                accountId: account.id, observedAt: new Date(150), agentId: 'codex',
                source: 'runtime', scope: 'turn_delta', totalTokens: 7,
            })) });
            let captureSql: ReturnType<typeof prismaRuntime.sql> | undefined;
            const request = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 100, endMs: 200 } });
            await inReadSnapshot(async tx => {
                const rows = await loadUsageAccountingRowsForQuery(new Proxy(tx, {
                    get(target, property, receiver) {
                        if (property !== '$queryRaw') return Reflect.get(target, property, receiver);
                        return async (...args: unknown[]) => {
                            // Observe the actual SQL at the database boundary; execute its real decoder.
                            captureSql = args[0] as ReturnType<typeof prismaRuntime.sql>;
                            return Reflect.apply(target.$queryRaw, target, args);
                        };
                    },
                }) as Tx, account.id, [request]);
                expect(rows.filter(row => row.captureKind === 'body')).toHaveLength(eventCount);
                if (!captureSql) throw new Error('Expected the accounting capture statement');
                const explain = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(prismaRuntime.sql`
                    EXPLAIN (ANALYZE, FORMAT JSON) ${captureSql}`);
                const historyPlans = findHistoryPlans(explain);
                expect(historyPlans, 'the measured statement must execute historical qualification').toHaveLength(1);
                expect(sumWindowMembershipRows(historyPlans[0]),
                    'history exclusion must use its time predicate instead of revisiting captured window identities').toBe(0);
            });
        } finally {
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('retains historical session, native, producer and report closure across overlapping windows and exact boundaries', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sessionIds = Array.from({ length: 4 }, () => randomUUID());
        const prefix = randomUUID();
        try {
            await db.session.createMany({ data: sessionIds.map(id => ({ id, accountId: account.id, tag: id, metadata: '{}' })) });
            const native = { accountingSubject: { sourceRootKey: 'root', nativeSessionKey: 'native' } };
            const producer = { usageAccounting: { nativeSessionId: 'producer-one' } };
            const events = [
                { externalKey: 'start', observedAt: 100, sessionId: sessionIds[0] },
                { externalKey: 'session-history', observedAt: 50, sessionId: sessionIds[0] },
                { externalKey: 'session-gap', observedAt: 250, sessionId: sessionIds[0] },
                { externalKey: 'wrong-agent', observedAt: 50, sessionId: sessionIds[0], agentId: 'claude' },
                { externalKey: 'native-window', observedAt: 150, metadata: native, machineId: 'first' },
                { externalKey: 'native-history', observedAt: 50, metadata: JSON.stringify(native), machineId: 'other', agentId: 'claude' },
                { externalKey: 'producer-window', observedAt: 160, metadata: producer },
                { externalKey: 'producer-history', observedAt: 50, metadata: JSON.stringify({ usageAccounting: { nativeSessionId: 'producer_one' } }) },
                { externalKey: 'producer-wrong-agent', observedAt: 50, metadata: producer, agentId: 'claude' },
                { externalKey: 'report-history', observedAt: 50, sessionId: sessionIds[1], agentId: legacyUsageReportAgentId },
                { externalKey: 'outside-report-history', observedAt: 50, sessionId: sessionIds[2], agentId: legacyUsageReportAgentId },
                { externalKey: 'first-end', observedAt: 200 },
                { externalKey: 'second-start', observedAt: 300 },
                { externalKey: 'last-end', observedAt: 400 },
                { externalKey: 'unrelated-history', observedAt: 50, metadata: '{malformed' },
            ];
            await db.usageEvent.createMany({ data: events.map(event => ({
                ...event, id: `${prefix}-${event.externalKey}`, accountId: account.id, observedAt: new Date(event.observedAt),
                agentId: event.agentId ?? 'codex', source: 'runtime', scope: 'turn_delta', totalTokens: 9,
            })) });
            await db.usageReport.createMany({ data: [
                { accountId: account.id, sessionId: sessionIds[1], key: 'inside', data: { tokens: { total: 0 }, cost: { total: 0 } }, updatedAt: new Date(120) },
                { accountId: account.id, sessionId: sessionIds[2], key: 'gap', data: { tokens: { total: 0 }, cost: { total: 0 } }, updatedAt: new Date(250) },
            ] });
            const queries = [
                { dateRange: { startMs: 100, endMs: 200 }, filters: { machineIds: ['first'] } },
                { dateRange: { startMs: 140, endMs: 180 }, filters: { machineIds: ['other'] } },
                { dateRange: { startMs: 300, endMs: 400 } },
            ].map(query => UsageAnalyticsQueryRequestSchema.parse(query));
            const rows = await inReadSnapshot(tx => loadUsageAccountingRowsForQuery(tx, account.id, queries));
            expect(rows.filter(row => row.captureKind === 'body').map(row => row.externalKey).sort()).toEqual([
                'native-history', 'native-window', 'producer-history', 'producer-window', 'report-history',
                'second-start', 'session-gap', 'session-history', 'start',
            ]);
            expect(rows.filter(row => row.captureKind === 'evidence').map(row => ({
                key: row.id.slice(prefix.length + 1), tokens: Reflect.get(row, 'totalTokens'),
            })).sort((a, b) => String(a.key).localeCompare(String(b.key)))).toEqual([
                'first-end', 'outside-report-history', 'producer-wrong-agent', 'unrelated-history', 'wrong-agent',
            ].map(key => ({ key, tokens: null })));
            expect(rows.filter(row => row.captureKind === 'report').map(row => row.reportKey)).toEqual(['gap', 'inside']);
            expect(rows.some(row => row.id === `${prefix}-last-end`)).toBe(false);
        } finally {
            await db.usageReport.deleteMany({ where: { accountId: account.id } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('transfers one accounting payload and native timestamps per row without losing bodies, evidence or ordered reports', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const prefix = randomUUID();
        try {
            const metadata = { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true },
                opaque: { unicode: '日本語', escaped: '"\\\n', number: 1.23456789012345 } };
            const event = await db.usageEvent.create({ data: {
                accountId: account.id, observedAt: new Date(150), createdAt: new Date(151),
                agentId: 'codex', modelId: 'model', backendMode: 'native', projectKey: 'project',
                workspaceId: 'workspace', machineId: 'machine', source: 'runtime', scope: 'turn_delta',
                turnId: 'turn', externalKey: 'external', metadata, requestCount: 2,
                inputTokens: 7, outputTokens: 3, reasoningTokens: 1, cacheReadTokens: 2,
                cacheWriteTokens: 4, totalTokens: 17, reportedCostUsd: 0.000000123456789,
                estimatedCostUsd: 1.23456789012345, invoiceCostUsd: 2.34,
                billingContext: 'subscription', costSource: 'provider', currency: 'EUR',
                costBreakdown: '{"opaque":true}', contextUsedTokens: 19, contextWindowTokens: 200,
            }, select: usageEventSelect });
            const malformed = await db.usageEvent.create({ data: { accountId: account.id,
                observedAt: new Date(160), agentId: 'codex', source: 'runtime', scope: 'turn_delta', metadata: '{malformed' } });
            const historical = await db.usageEvent.create({ data: { accountId: account.id,
                observedAt: new Date(50), agentId: 'codex', source: 'historical', scope: 'turn_delta', totalTokens: 99 } });
            const reports = await Promise.all(['a', 'b'].map(suffix => db.usageReport.create({ data: {
                id: `${prefix}-${suffix}`, accountId: account.id, key: `report-${suffix}`,
                data: { tokens: { total: 4 }, cost: { total: 0.1 }, opaque: ['日本語', null] },
                createdAt: new Date(140), updatedAt: new Date(170),
            } })));
            let nativeCells = 0;
            let statements = 0;
            const request = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 100, endMs: 200 } });
            const rows = await inReadSnapshot(tx => loadUsageAccountingRowsForQuery(new Proxy(tx, {
                get(target, property, receiver) {
                    if (property !== '$queryRaw') return Reflect.get(target, property, receiver);
                    // Observe the real database result; the production decoder stays real.
                    return async (...args: unknown[]) => {
                        const rows: unknown = await Reflect.apply(target.$queryRaw, target, args);
                        statements++;
                        if (!Array.isArray(rows)) throw new Error('Expected a database row set');
                        for (const row of rows) nativeCells += Object.keys(row).length;
                        return rows;
                    };
                },
            }) as Tx, account.id, [request]));
            const captured = rows.find(row => row.id === event.id);
            expect(captured).toEqual({ ...event, metadata: expect.any(String), captureKind: 'body',
                reportKey: null, reportData: null, reportUpdatedAt: null });
            if (!captured || captured.captureKind !== 'body') throw new Error('Expected the selected body');
            expect(JSON.parse(String(captured.metadata))).toEqual(metadata);
            expect(rows.find(row => row.id === malformed.id)).toMatchObject({ captureKind: 'body', metadata: '{malformed' });
            expect(rows.find(row => row.id === historical.id)).toMatchObject({ captureKind: 'evidence',
                observedAt: new Date(50), totalTokens: null, metadata: null });
            expect(rows.filter(row => row.captureKind === 'report').map(row => ({ id: row.id,
                createdAt: row.createdAt, updatedAt: row.reportUpdatedAt, key: row.reportKey, data: row.reportData })))
                .toEqual(reports.reverse().map(row => ({ id: row.id, createdAt: row.createdAt,
                    updatedAt: row.updatedAt, key: row.key, data: row.data })));
            expect(statements, 'one statement retains the coherent event/report snapshot').toBe(1);
            // Three timestamp columns preserve native Date/null decoding. All accounting
            // fields share one text payload instead of native engine cells per field.
            expect(nativeCells, 'native result allocations scale with payloads, not accounting field count')
                .toBe(rows.length * (3 + 1));
            const all = await inReadSnapshot(tx => loadUsageAccountingRowsForQuery(tx, account.id,
                [UsageAnalyticsQueryRequestSchema.parse({})]));
            expect(all.find(row => row.id === historical.id)).toMatchObject({ captureKind: 'body', totalTokens: 99 });
        } finally {
            await db.usageReport.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
