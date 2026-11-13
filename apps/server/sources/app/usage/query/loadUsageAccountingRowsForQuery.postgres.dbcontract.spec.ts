import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { loadUsageAccountingRowsForQuery } from './loadUsageAccountingRowsForQuery';
import { usageEventSelect } from './loadUsageEventsForQuery';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Usage accounting result materialization on PostgreSQL', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Requires the disposable PostgreSQL DB-contract owner');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(shutdownDbClient);

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
