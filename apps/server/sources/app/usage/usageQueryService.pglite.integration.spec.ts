import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryBatchResponseSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import * as usageContracts from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { applyPostgresMigrations } from '../../../scripts/prismaMigrations';
import { openPgliteMigrationSession, type PgliteMigrationSession } from '../../../scripts/pgliteMigrationSession';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { prismaRuntime } from '@/storage/prisma';
import { inTx, type Tx } from '@/storage/inTx';
import { applyEnvValues, restoreEnv, snapshotEnv } from '@/testkit/env';
import { TEAM_CREDENTIAL_ONLY_USAGE_SOURCES } from './usageSourceClassifier';
import { captureUsageAnalyticsInTx, projectUsageAnalytics, projectUsageAnalyticsAsync } from './usageQueryService';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAccountUsageRoutes } from '@/app/api/routes/account/registerAccountUsageRoutes';
import { loadRetainedLegacyUsageReports, loadUsageEventsForQuery } from './query/loadUsageEventsForQuery';
import { captureUsageModelPriceCatalogInTx, USAGE_MODEL_PRICE_CACHE_KEY } from './usageModelPriceCatalog';
import { loadUsageMessageCountsBySessionInTx } from './query/loadUsageMessageStatsForQuery';
import { prepareUsageAnalyticsSnapshot, projectUsageAnalyticsPopulation } from './query/projectUsageAnalyticsPopulation';
import { captureUsageAnalyticsBatch } from './query/readUsageAnalyticsBatch';

type EventReadCount = { reads: number; ormRows: number; rowCounts?: number[]; metadataRows?: number; bodyRows?: number };

/** Observe the real transaction's database results, leaving the query and projector intact. */
function countUsageEventReads(tx: Tx, count: EventReadCount): Tx {
    return new Proxy(tx, {
        get(target, property, receiver) {
            if (property === 'usageEvent') return new Proxy(target.usageEvent, {
                get(delegate, method, delegateReceiver) {
                    if (method !== 'findMany') return Reflect.get(delegate, method, delegateReceiver);
                    return async (...args: unknown[]) => {
                        const rows = await Reflect.apply(Reflect.get(delegate, method), delegate, args) as object[];
                        count.reads += 1;
                        count.ormRows += rows.length;
                        return rows;
                    };
                },
            });
            if (property === '$queryRaw') return async (...args: unknown[]) => {
                const rows = await Reflect.apply(Reflect.get(target, property), target, args) as object[];
                const input = args[0] as { strings?: readonly string[]; raw?: readonly string[] } | undefined;
                const statement = (input?.strings ?? input?.raw ?? []).join('');
                if (statement.includes('"UsageEvent"')) {
                    const payloadExpression = statement.match(/jsonb_build_array\(([\s\S]*?)\)::text AS payload/)?.[1];
                    const payloadKeys = [...(payloadExpression ?? '').matchAll(/c\."([^"]+)"/g)].map(match => match[1]!);
                    const observed = rows.map(row => {
                        const payload = Reflect.get(row, 'payload');
                        if (typeof payload !== 'string') return row;
                        const values: unknown[] = JSON.parse(payload);
                        return Object.fromEntries<unknown>(payloadKeys.map((key, index) => [key, values[index]]));
                    });
                    count.reads += 1;
                    count.rowCounts?.push(rows.length);
                    if (count.bodyRows !== undefined && observed[0] && Object.hasOwn(observed[0], 'totalTokens')) {
                        count.bodyRows += observed.filter(row => !Object.hasOwn(row, 'captureKind')
                            || Reflect.get(row, 'captureKind') === 'body').length;
                    }
                    if (count.metadataRows !== undefined && observed[0] && Object.hasOwn(observed[0], 'metadata')) {
                        count.metadataRows += observed.filter(row => Reflect.get(row, 'captureKind') !== 'report').length;
                    }
                }
                return rows;
            };
            return Reflect.get(target, property, receiver);
        },
    });
}

describe('Usage analytics PostgreSQL event transport', () => {
    const originalEnv = snapshotEnv();
    let root: string | undefined;
    let session: PgliteMigrationSession | undefined;

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-usage-read-pg-'));
        const databaseDir = join(root, 'pglite');
        const database = new PGlite(databaseDir);
        try {
            await database.waitReady;
            await applyPostgresMigrations({ db: database, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        } finally { await database.close(); }
        applyEnvValues({ HAPPIER_SERVER_LIGHT_DB_DIR: databaseDir, HAPPIER_SERVER_LIGHT_DATA_DIR: root });
        session = await openPgliteMigrationSession(process.env, { purpose: 'usage-event-transport-test' });
        applyEnvValues({ HAPPIER_DB_PROVIDER: 'postgres', HAPPY_DB_PROVIDER: 'postgres', DATABASE_URL: session.databaseUrl,
            HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED: 'false' });
        initDbPostgres();
        await db.$connect();
    }, 120_000);

    afterAll(async () => {
        try { await shutdownDbClient(); } finally {
            await session?.close();
            restoreEnv(originalEnv);
            if (root) await rm(root, { recursive: true, force: true });
        }
    });

    it('captures 53 accounting slices including filtered TODAY without acquiring an interactive PostgreSQL transaction', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        await db.usageEvent.create({ data: { accountId: account.id, observedAt: new Date(100),
            agentId: 'codex', machineId: 'today-machine', source: 'runtime', scope: 'turn_delta', totalTokens: 7 } });
        // Observe the real persistent boundary; all route, capture, and projection logic stays real.
        const transaction = db.$transaction;
        // db forwards to the real client through a Proxy without own descriptors.
        let accountingReadsInTransaction = 0;
        const acquire = vi.fn(async (read: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof transaction>[1]) =>
            transaction(tx => read(new Proxy(tx, {
                get(target, property, receiver) {
                    if (property !== '$queryRaw') return Reflect.get(target, property, receiver);
                    return async (...args: unknown[]) => {
                        const query = args[0] as { strings?: readonly string[] };
                        if (query.strings?.join('').includes('"UsageEvent"')) accountingReadsInTransaction++;
                        return Reflect.apply(target.$queryRaw, target, args);
                    };
                },
            })), options));
        // This database-boundary observer handles the interactive overload used by the real snapshot owner.
        db.$transaction = acquire as unknown as typeof db.$transaction;
        try {
            await withAuthenticatedTestApp(app => registerAccountUsageRoutes(app), async app => {
                const response = await app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                    headers: { 'x-test-user-id': account.id }, payload: {
                        queries: [...Array.from({ length: 51 }, (_, index) => ({
                            dateRange: { startMs: 0, endMs: 200 + index }, includeSeries: false,
                        })),
                        { dateRange: { startMs: 0, endMs: 51_840_000 }, includeSeries: false },
                        { dateRange: { startMs: 0, endMs: 51_840_000 }, includeSeries: false,
                            filters: { machineIds: ['today-machine'] } }], includeContributions: true,
                    } });
                expect(response.statusCode, response.body).toBe(200);
                const batch = UsageAnalyticsQueryBatchResponseSchema.parse(response.json());
                expect(batch.results).toHaveLength(53);
                expect(batch.results.every(row => 'value' in row && row.value.totals.tokens.total === 7)).toBe(true);
                expect(accountingReadsInTransaction).toBe(0);
                expect(acquire).not.toHaveBeenCalled();
            });
        } finally { db.$transaction = transaction; }
    });

    it('keeps same-population detail in one accounting capture and isolates distinct compact-summary snapshots', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        await db.usageEvent.create({ data: { accountId: account.id, observedAt: new Date(100),
            agentId: 'codex', source: 'runtime', scope: 'turn_delta', totalTokens: 7 } });
        const activity = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 0, endMs: 200 },
            granularity: 'day', includeActivity: true, includeSeries: false });
        const detail = UsageAnalyticsQueryRequestSchema.parse({ ...activity, includeActivity: false, includeSeries: true });
        const transaction = db.$transaction;
        let normalAccountingReadsInTransaction = 0;
        const acquire = vi.fn(async (read: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof transaction>[1]) =>
            transaction(tx => read(new Proxy(tx, {
                get(target, property, receiver) {
                    if (property !== '$queryRaw') return Reflect.get(target, property, receiver);
                    return async (...args: unknown[]) => {
                        const query = args[0] as { strings?: readonly string[] };
                        if (query.strings?.join('').includes('"captureKind"')) normalAccountingReadsInTransaction++;
                        return Reflect.apply(target.$queryRaw, target, args);
                    };
                },
            })), options));
        // This database-boundary observer handles the interactive overload used by the real snapshot owner.
        db.$transaction = acquire as unknown as typeof db.$transaction;
        try {
            const shared = await captureUsageAnalyticsBatch(account.id, [activity, detail], undefined,
                { contributionQueries: [detail], sessionQueries: [activity] });
            expect(shared.activitySummary).toBeUndefined();
            const sharedSnapshots = [...shared.snapshots.values()];
            expect(sharedSnapshots[0]!.rows).toBe(sharedSnapshots[1]!.rows);
            const otherCompact = { ...activity, timeZoneOffsetMinutes: 60 };
            const compactSiblings = await captureUsageAnalyticsBatch(account.id, [activity, otherCompact], undefined,
                { contributionQueries: [], sessionQueries: [activity, otherCompact] });
            expect(compactSiblings.activitySummary).toBeUndefined();
            const compactSnapshots = [...compactSiblings.snapshots.values()];
            expect(compactSnapshots[0]!.rows).toBe(compactSnapshots[1]!.rows);
            const distinct = { ...detail, dateRange: { startMs: 50, endMs: 200 } };
            const split = await captureUsageAnalyticsBatch(account.id, [activity, distinct], undefined,
                { contributionQueries: [distinct], sessionQueries: [activity] });
            expect(split.activitySummary?.query).toEqual(activity);
            expect(split.snapshots.size).toBe(2);
            expect(normalAccountingReadsInTransaction).toBe(0);
            expect(projectUsageAnalytics(sharedSnapshots[1]!, detail).totals.tokens.total).toBe(7);
            expect(projectUsageAnalytics([...split.snapshots.values()][0]!, distinct).totals.tokens.total).toBe(7);
        } finally { db.$transaction = transaction; }
    });

    it('preserves nullable measurements through PostgreSQL row transport and known-only aggregation', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const unknown = { accountId: account.id, observedAt: new Date(100), agentId: 'codex', source: 'runtime',
            scope: 'turn_delta', inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null,
            cacheWriteTokens: null, totalTokens: null, reportedCostUsd: null, estimatedCostUsd: null, invoiceCostUsd: null,
            metadata: { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } } };
        await db.usageEvent.create({ data: unknown });
        const request = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 0, endMs: 200 } });
        const read = () => inTx(async tx => captureUsageAnalyticsInTx(tx, account.id, request), { readOnly: true });
        const first = await read();
        expect(first.rows[0]?.totalTokens).toBeNull();
        expect(projectUsageAnalytics(first, request).totals.tokens.total).toBeNull();
        await db.usageEvent.create({ data: { ...unknown, observedAt: new Date(101), inputTokens: 8, outputTokens: 2,
            reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10, reportedCostUsd: 0.25,
            costSource: 'provider_reported' } });
        const mixed = projectUsageAnalytics(await read(), request);
        expect(mixed.totals.tokens.total).toBe(10);
        expect(mixed.coverage?.status).toBe('partial');
        expect(mixed.coverage?.reasons).toContain('unknown_token_categories');
    });

    it('preserves typed rows and projected results across replay, source, Account and half-open bounds', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const other = await db.account.create({ data: { publicKey: randomUUID() } });
        const subject = { kind: 'native', machineId: 'machine', agent: { pluginId: 'happier.agent.claude', localId: 'claude' },
            sourceRootKey: 'root', nativeSessionKey: 'native' };
        const event = (id: string, accountId: string, observedAtMs: number, overrides: Record<string, unknown> = {}) => ({
            id, accountId, observedAt: new Date(observedAtMs), createdAt: new Date(observedAtMs + 1), agentId: 'claude',
            source: 'runtime', scope: 'turn_delta', inputTokens: 10, totalTokens: 10, estimatedCostUsd: 0.1,
            metadata: { accountingSubject: subject, usageAccounting: { path: 'runtime', status: 'available',
                historyComplete: true, inferenceId: id } }, ...overrides,
        });
        await db.usageEvent.createMany({ data: [
            event('before-replay', account.id, 100, { metadata: { accountingSubject: subject,
                usageAccounting: { path: 'runtime', status: 'available', historyComplete: true, inferenceId: 'replay' } } }),
            event('baseline', account.id, 150, { scope: 'session_cumulative', isCumulative: true,
                inputTokens: 100, totalTokens: 100, metadata: { accountingSubject: subject } }),
            event('native-replay', account.id, 200, { source: 'native', metadata: JSON.stringify({ accountingSubject: subject,
                usageAccounting: { path: 'native', status: 'available', historyComplete: true, inferenceId: 'replay' } }) }),
            event('before-end', account.id, 249, { metadata: null, costBreakdown: '{"inputUsd":0.025}',
                billingContext: 'direct_paid', costSource: 'pricing_estimate' }),
            event('at-end', account.id, 250),
            event('after-end', account.id, 251),
            event('excluded-team', account.id, 210, { source: TEAM_CREDENTIAL_ONLY_USAGE_SOURCES[0] }),
            event('other-account', other.id, 215),
        ] });
        const request = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 175, endMs: 250 },
            includeSeries: true, includeActivity: true, breakdowns: ['source'], includeInsights: false });
        const count: EventReadCount = { reads: 0, ormRows: 0 };
        const { rows, baseline } = await inTx(async tx => {
            // A non-UTC session must not shift the timestamp-without-time-zone predicate.
            await tx.$executeRaw`SET LOCAL TIME ZONE 'Europe/Amsterdam'`;
            const rows = await loadUsageEventsForQuery(countUsageEventReads(tx, count), account.id, request);
            const baseline = await tx.usageEvent.findMany({ where: { accountId: account.id,
                observedAt: { lt: new Date(request.dateRange!.endMs!) },
                source: { notIn: [...TEAM_CREDENTIAL_ONLY_USAGE_SOURCES] } }, orderBy: { observedAt: 'asc' } });
            return { rows, baseline };
        }, { readOnly: true, isolationLevel: 'Serializable' });
        expect(rows.map(row => row.id)).toEqual(['before-replay', 'baseline', 'native-replay', 'before-end']);
        const decodedMetadata = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) : value;
        expect(rows.map(row => ({ ...row, metadata: decodedMetadata(row.metadata) })))
            .toEqual(baseline.map(row => Object.fromEntries(Object.keys(rows[0]!).map(key => [key,
                key === 'metadata' ? decodedMetadata(row.metadata) : Reflect.get(row, key)]))));
        expect(rows.slice(0, 3).every(row => typeof row.metadata === 'string'), 'leave PostgreSQL metadata opaque until commit').toBe(true);
        expect(count).toEqual({ reads: 1, ormRows: 0 });
        const ordinaryCount: EventReadCount = { reads: 0, ormRows: 0 };
        const captured = await inTx(tx => captureUsageAnalyticsInTx(countUsageEventReads(tx, ordinaryCount), account.id, request),
            { readOnly: true, isolationLevel: 'Serializable' });
        const scalarSnapshot = { ...captured, rows: baseline };
        expect(projectUsageAnalytics(captured, request)).toEqual(projectUsageAnalytics(scalarSnapshot, request, undefined,
            projectUsageAnalyticsPopulation(scalarSnapshot, request)));
        expect(ordinaryCount).toEqual({ reads: 1, ormRows: 0 });
        const emptyCount: EventReadCount = { reads: 0, ormRows: 0 };
        const empty = await inTx(tx => captureUsageAnalyticsInTx(countUsageEventReads(tx, emptyCount),
            account.id, UsageAnalyticsQueryRequestSchema.parse({ dateRange: { endMs: 100 } })),
        { readOnly: true, isolationLevel: 'Serializable' });
        expect(empty.rows).toEqual([]);
        expect(emptyCount).toEqual({ reads: 1, ormRows: 0 });
        // An empty population is known zero; the nonempty unknown-only control above stays null.
        expect(projectUsageAnalytics(empty, UsageAnalyticsQueryRequestSchema.parse({ dateRange: { endMs: 100 } }))
            .totals.tokens.total).toBe(0);
    });

    it('keeps opaque native competitors, fallback baselines and malformed historical metadata coherent', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: { accountId: account.id,
            tag: 'candidate-attribution', encryptionMode: 'e2ee', metadata: 'ciphertext' } });
        const subject = { kind: 'native', machineId: ' machine ',
            agent: { pluginId: 'happier.agent.claude', localId: 'claude' },
            sourceRootKey: ' root ', nativeSessionKey: ' native ' };
        const event = (id: string, at: number, metadata: Prisma.InputJsonValue, tokens: number,
            cumulative = false, sessionId: string | null = null) => ({
            id, accountId: account.id, observedAt: new Date(at), createdAt: new Date(at),
            agentId: 'claude', machineId: 'machine', source: 'native', metadata, sessionId,
            scope: cumulative ? 'session_cumulative' : 'turn_delta', isCumulative: cumulative,
            inputTokens: tokens, totalTokens: tokens,
        });
        await db.usageEvent.createMany({ data: [
            event('candidate-native-baseline', 100, JSON.stringify({ accountingSubject: subject }), 100, true, session.id),
            event('candidate-native-current', 200, { accountingSubject: subject }, 110, true, session.id),
            event('candidate-fallback-baseline', 100, { usageAccounting: { nativeSessionId: ' \uFEFFfallback\u2003 ' } }, 40, true),
            event('candidate-fallback-current', 200, JSON.stringify({ usageAccounting: { nativeSessionId: 'fallback' } }), 45, true),
            event('candidate-malformed', 100, '{invalid json', 999),
            event('candidate-unrelated', 100, { accountingSubject: { ...subject, sourceRootKey: 'another root' } }, 999, false, session.id),
        ] });
        const request = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 175, endMs: 250 },
            includeSeries: true, includeActivity: true, breakdowns: ['source'] });
        const captured = await inTx(tx => captureUsageAnalyticsInTx(tx, account.id, request),
            { readOnly: true, isolationLevel: 'Serializable' });
        expect(prepareUsageAnalyticsSnapshot(captured, request).rows,
            'canonical admission excludes conservative SQL competitors sharing Session attribution').toHaveLength(4);
        const control = { ...captured, rows: await inTx(tx => loadUsageEventsForQuery(tx, account.id, request)),
            rawEvidenceRows: undefined, evidenceRows: undefined, replayContext: undefined, normalizedEvidenceById: undefined };
        expect(projectUsageAnalytics(captured, request)).toEqual(projectUsageAnalytics(control, request));
        expect(projectUsageAnalytics(captured, request).totals.tokens.total).toBe(15);
    });

    it('keeps candidate work proportional to unique histories when window and subject branches overlap', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const subject = { kind: 'native', machineId: 'machine',
            agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
            sourceRootKey: 'root', nativeSessionKey: 'native' };
        const rows = Array.from({ length: 16 }, (_, index) => ({
            id: `candidate-overlap-${index}`,
            accountId: account.id,
            observedAt: new Date(200 + index),
            createdAt: new Date(200 + index),
            agentId: 'codex', machineId: 'machine', source: 'native', metadata: { accountingSubject: subject },
            scope: 'session_cumulative', isCumulative: true,
            inputTokens: index + 1, totalTokens: index + 1,
        }));
        await db.usageEvent.createMany({ data: [
            { id: 'candidate-overlap-baseline', accountId: account.id, observedAt: new Date(100), createdAt: new Date(100),
                agentId: 'codex', machineId: 'machine', source: 'native', metadata: { accountingSubject: subject },
                scope: 'session_cumulative', isCumulative: true, inputTokens: 1, totalTokens: 1 },
            ...rows,
        ] });
        let candidateSql: Prisma.Sql | undefined;
        try {
            const request = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 200, endMs: 300 } });
            const captured = await inTx(tx => captureUsageAnalyticsInTx(new Proxy(tx, {
                get(target, property, receiver) {
                    if (property !== '$queryRaw') return Reflect.get(target, property, receiver);
                    return async (...args: unknown[]) => {
                        const input = args[0] as { strings?: readonly string[]; raw?: readonly string[] } | undefined;
                        const statement = input?.strings ?? input?.raw ?? [];
                        if (statement.some(part => part.includes('history AS MATERIALIZED'))) candidateSql = args[0] as Prisma.Sql;
                        return Reflect.apply(target.$queryRaw, target, args);
                    };
                },
            }), account.id, request),
                { readOnly: true, isolationLevel: 'Serializable' });
            expect(captured.rows).toHaveLength(17);
            expect(candidateSql).toBeDefined();
            if (!candidateSql) return;
            type PlanNode = { 'Node Type'?: string; 'Subplan Name'?: string; 'Actual Rows'?: number; Filter?: string; Plans?: PlanNode[] };
            const [plan] = await db.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(
                prismaRuntime.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${candidateSql}`);
            const find = (node: PlanNode, type: string): PlanNode | undefined =>
                node['Node Type'] === type ? node : node.Plans?.map(child => find(child, type)).find(Boolean);
            // PREPARE retains parameters: EXPLAIN GENERIC_PLAN through Prisma's
            // bound-query protocol substitutes values before PostgreSQL plans it.
            const literal = (value: unknown): string => {
                if (typeof value === 'string') return `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
                if (Array.isArray(value)) return `ARRAY[${value.map(literal).join(',')}]::text[]`;
                throw new Error('Candidate fixture binds text and text arrays only');
            };
            const statement = candidateSql;
            const generic = await inTx(async tx => {
                await tx.$executeRawUnsafe('SET LOCAL plan_cache_mode=force_generic_plan');
                await tx.$executeRawUnsafe(`PREPARE usage_candidate_cost AS ${statement.text}`);
                try {
                    return await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(
                        `EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE usage_candidate_cost(${statement.values.map(literal).join(',')})`);
                } finally { await tx.$executeRawUnsafe('DEALLOCATE usage_candidate_cost'); }
            }, { readOnly: true, isolationLevel: 'Serializable' });
            const unindexedArrayFilters = (node: PlanNode): number =>
                (node.Filter && /\bANY\s*\(\s*\$\d+/.test(node.Filter) ? 1 : 0)
                + (node.Plans ?? []).reduce((count, child) => count + unindexedArrayFilters(child), 0);
            expect(unindexedArrayFilters(generic[0]?.['QUERY PLAN']?.[0]?.Plan ?? {}),
                'generic plans must not compare each history row with the entire parameter array').toBe(0);
            const append = find(plan?.['QUERY PLAN']?.[0]?.Plan ?? {}, 'Append');
            expect(append?.['Actual Rows'], 'candidate branches must not re-emit admitted window rows').toBeLessThanOrEqual(17);
            const findHistory = (node: PlanNode): PlanNode | undefined =>
                node['Subplan Name'] === 'CTE history' ? node : node.Plans?.map(findHistory).find(Boolean);
            for (const value of [plan, generic[0]]) {
                const history = findHistory(value?.['QUERY PLAN']?.[0]?.Plan ?? {});
                expect(history?.['Actual Rows'], 'admitted window rows bypass historical metadata materialization in both plan modes').toBe(1);
            }
        } finally {
            await db.account.delete({ where: { id: account.id } });
        }
    });

    // This full-path cost contract is reproduced and tracked separately from the summary widening.
    it.fails('bounds Accounting decodes and admissions by the requested rows and cumulative anchors', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const prefix = 'accounting-window-work-';
        const request = UsageAnalyticsQueryRequestSchema.parse({
            dateRange: { startMs: 1_000, endMs: 2_000 },
            filters: { machineIds: ['selected-machine'] },
            breakdowns: ['model'], includeMessageStats: false,
        });
        const event = (index: number, at: number, machineId: string, totalTokens: number) => ({
            id: prefix + index, accountId: account.id, observedAt: new Date(at), createdAt: new Date(at),
            source: 'native', scope: 'session_cumulative', isCumulative: true, agentId: 'codex',
            machineId, modelId: 'counted-model', inputTokens: totalTokens, totalTokens,
            metadata: {
                captureCountMarker: prefix,
                accountingSubject: { kind: 'native', machineId, agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
                    sourceRootKey: 'counted-root', nativeSessionKey: machineId },
                usageAccounting: { path: 'native', status: 'available', historyComplete: true },
            },
        });
        const required = [
            event(0, 900, 'selected-machine', 100),
            event(1, 1_000, 'selected-machine', 103),
            event(2, 1_250, 'selected-machine', 106),
            event(3, 1_500, 'selected-machine', 110),
        ];
        const historySize = 256;
        await db.usageEvent.createMany({ data: required });

        async function measure() {
            let packedDecodes = 0;
            let admissions = 0;
            const parse = JSON.parse;
            const readMetadata = usageContracts.readUsageAccountingMetadata;
            const decode = vi.spyOn(JSON, 'parse').mockImplementation((...args: Parameters<typeof JSON.parse>) => {
                const value: unknown = parse(...args);
                if (Array.isArray(value) && (value[0] === 'body' || value[0] === 'evidence')
                    && typeof value[1] === 'string' && value[1].startsWith(prefix)) packedDecodes++;
                return value;
            });
            const admit = vi.spyOn(usageContracts, 'readUsageAccountingMetadata').mockImplementation(metadata => {
                if (metadata && typeof metadata === 'object' && Reflect.get(metadata, 'captureCountMarker') === prefix) admissions++;
                return readMetadata(metadata);
            });
            try {
                const captured = await inTx(tx => captureUsageAnalyticsInTx(tx, account.id, request), { readOnly: true });
                const value = await projectUsageAnalyticsAsync(captured, request);
                return { value, work: { packedDecodes, admissions } };
            } finally {
                decode.mockRestore();
                admit.mockRestore();
            }
        }

        const small = await measure();
        await db.usageEvent.createMany({ data: Array.from({ length: historySize }, (_, index) =>
            event(index + required.length, index + 1, 'unrelated-machine', index + 1)) });
        const large = await measure();
        expect(small.value.totals.tokens.total).toBe(10);
        expect(large.value).toEqual(small.value);
        expect({ noUnrelatedHistory: small.work, withUnrelatedHistory: large.work },
            'three in-window rows and their one required anchor are each decoded and admitted once').toEqual({
            noUnrelatedHistory: { packedDecodes: required.length, admissions: required.length },
            withUnrelatedHistory: { packedDecodes: required.length, admissions: required.length },
        });
    });

    it('matches full Accounting replay over retained reports, mixed sources and mutable history', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const day = 86_400_000;
        const end = Date.UTC(2026, 8, 1);
        const start = end - 90 * day;
        const createSession = (tag: string) => db.session.create({ data: {
            accountId: account.id, tag, encryptionMode: 'e2ee', metadata: 'fixture',
        } });
        const [legacy, competing, deleted] = await Promise.all([
            createSession('retained-report'), createSession('competing-report'), createSession('deleted-usage'),
        ]);
        const subject = { kind: 'native', machineId: 'replay-machine',
            agent: { pluginId: 'happier.agent.claude', localId: 'claude' }, sourceRootKey: 'replay-root', nativeSessionKey: 'replay-native' };
        const facts = (source: 'runtime' | 'native', subjectKey: string, options: Prisma.InputJsonObject = {}) => ({
            accountingSubject: { ...subject, nativeSessionKey: subjectKey },
            usageAccounting: { path: source, status: 'available', historyComplete: true, ...options },
        });
        const event = (key: string, at: number, overrides: Partial<Prisma.UsageEventCreateManyInput> = {}) => ({
            id: 'window-reference-' + key, accountId: account.id, observedAt: new Date(at), createdAt: new Date(at),
            source: 'runtime', scope: 'turn_delta', agentId: 'claude', modelId: 'synthetic-priced',
            machineId: subject.machineId, inputTokens: 5, outputTokens: 0, reasoningTokens: 0,
            cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5,
            reportedCostUsd: 0.05, costSource: 'provider_reported',
            metadata: facts('runtime', key), ...overrides,
        });
        const cumulative = (key: string, at: number, tokens: number, runtime: string, sequence: number, epoch: string) =>
            event(key, at, { scope: 'session_cumulative', isCumulative: true, inputTokens: tokens, totalTokens: tokens,
                reportedCostUsd: tokens / 100, metadata: facts('runtime', 'persistent-counter', {
                    counterEpoch: epoch, runtimeEventOrder: { runtimeIncarnationId: runtime, sequence },
                }) });
        await db.usageEvent.createMany({ data: [
            cumulative('old-runtime-anchor', start - 2 * day, 100, 'before-restart', 7, 'before-reset'),
            event('before-detail-boundary', start - 1),
            cumulative('new-runtime', start, 118, 'after-restart', 1, 'before-reset'),
            cumulative('reset', start + day, 4, 'after-restart', 2, 'after-reset'),
            event('overlap-runtime', start + 2 * day, { sessionId: competing.id,
                metadata: facts('runtime', 'overlap', { inferenceId: 'one-inference',
                    runtimeEventOrder: { runtimeIncarnationId: 'same-runtime', sequence: 3 } }) }),
            event('overlap-native', start + 2 * day + 1, { source: 'native', sessionId: competing.id,
                inputTokens: 9_000, totalTokens: 9_000, metadata: JSON.stringify(facts('native', 'overlap', {
                    inferenceId: 'one-inference',
                })) }),
            event('unpriced', end - 5 * day, { modelId: 'synthetic-unpriced', reportedCostUsd: null, costSource: null }),
            event('unknown', end - 4 * day, { modelId: 'synthetic-unpriced', inputTokens: null,
                totalTokens: null, reportedCostUsd: null, costSource: null }),
            event('deleted-session', end - 3 * day, { sessionId: deleted.id }),
            event('team', end - 2 * day, { source: TEAM_CREDENTIAL_ONLY_USAGE_SOURCES[0], totalTokens: 50_000 }),
            event('exclusive-end', end, { totalTokens: 50_000 }),
        ] });
        await db.usageReport.createMany({ data: [legacy, competing].map((session, index) => ({
            accountId: account.id, sessionId: session.id, key: 'v02-accounting',
            data: { tokens: { total: index ? 80_000 : 7, input: index ? 80_000 : 7 }, cost: { total: 0.07 } },
            createdAt: new Date(start - 3 * day), updatedAt: new Date(start + 3 * day),
        })) });
        const request = (startMs: number, endMs: number, sessionId?: string) => UsageAnalyticsQueryRequestSchema.parse({
            dateRange: { startMs, endMs }, filters: sessionId ? { sessionIds: [sessionId] } : undefined,
            breakdowns: ['model', 'source'], includeActivity: true, includeSeries: true, includePriceCatalog: true,
            includeMessageStats: false,
        });
        function withUnorderedCoverage(value: UsageAnalyticsQueryResponse): UsageAnalyticsQueryResponse {
            if (!value.coverage) return value;
            return { ...value, coverage: { ...value.coverage, sources: [...value.coverage.sources]
                .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))) } };
        }
        async function compare(query: ReturnType<typeof request>) {
            const { candidate, reference } = await inTx(async tx => ({
                candidate: await captureUsageAnalyticsInTx(tx, account.id, query),
                // Use the entire retained prefix independently of candidate-body or scope selection.
                reference: {
                    rows: await loadUsageEventsForQuery(tx, account.id, query),
                    legacyReports: await loadRetainedLegacyUsageReports(tx, account.id, query),
                    priceCatalog: await captureUsageModelPriceCatalogInTx(tx),
                    messageCountsBySession: query.includeMessageStats || query.includeInsights
                        ? await loadUsageMessageCountsBySessionInTx(tx, account.id, query) : undefined,
                },
            }), { readOnly: true, isolationLevel: 'Serializable' });
            const referenceAnswer = await projectUsageAnalyticsAsync(reference, query);
            const candidateAnswer = await projectUsageAnalyticsAsync(candidate, query);
            expect(withUnorderedCoverage(candidateAnswer)).toEqual(withUnorderedCoverage(referenceAnswer));
            return referenceAnswer;
        }

        const detail = request(start, end);
        const first = await compare(detail);
        expect(first.totals.tokens.total).toBeGreaterThan(25);
        expect(first.totals.tokens.total).toBeLessThan(100);
        expect(first.coverage?.sources?.length).toBeGreaterThan(0);
        expect((await compare(request(start, end, legacy.id))).totals.tokens.total).toBe(7);
        expect((await compare(request(end - day, end))).totals.tokens.total).toBe(0);
        expect((await compare(request(start - 10 * day, start - day))).totals.tokens.total).toBe(100);
        expect((await compare(request(start - 20 * day, start - 10 * day))).totals.tokens.total).toBe(0);

        await db.usageEvent.update({ where: { id: 'window-reference-overlap-runtime' },
            data: { inputTokens: 8, totalTokens: 8, reportedCostUsd: 0.08 } });
        const corrected = await compare(detail);
        expect(corrected.totals.tokens.total).toBe((first.totals.tokens.total ?? 0) + 3);
        await db.usageEvent.create({ data: cumulative('late-anchor', start - day, 105, 'before-restart', 8, 'before-reset') });
        const withLateAnchor = await compare(detail);
        expect(withLateAnchor.totals.tokens.total).toBe((corrected.totals.tokens.total ?? 0) - 5);
        await db.session.delete({ where: { id: deleted.id } });
        const afterDeletion = await compare(detail);
        expect(afterDeletion.totals.tokens.total).toBe(withLateAnchor.totals.tokens.total);
        expect((await compare(request(start, end, deleted.id))).totals.tokens.total).toBe(0);

        // Preserve sparse category and cost baselines, decreasing counters in
        // one epoch, settlement, and a later snapshot from the same subject.
        const sparse = (key: string, at: number, values: Partial<Prisma.UsageEventCreateManyInput>) =>
            event(key, at, { scope: 'session_cumulative', isCumulative: true, source: 'native',
                metadata: facts('native', 'sparse-native-no-Session', { counterEpoch: 'same-epoch' }), ...values });
        await db.usageEvent.createMany({ data: [
            sparse('sparse-baseline', start - day, { inputTokens: 45, outputTokens: 5, totalTokens: 50 }),
            sparse('sparse-snapshot', start + day, { inputTokens: null, outputTokens: 8, totalTokens: 53,
                reportedCostUsd: null }),
            sparse('decrease-reset', start + 2 * day, { inputTokens: 1, outputTokens: null, totalTokens: 1 }),
            sparse('native-final', start + 3 * day, { scope: 'session_final', inputTokens: 7, totalTokens: 7 }),
            sparse('native-post-final', start + 4 * day, { inputTokens: 20, totalTokens: 20 }),
            event('delayed-duplicate', start + 5 * day, { sessionId: competing.id, inputTokens: 6, totalTokens: 6,
                metadata: facts('runtime', 'overlap', { inferenceId: 'one-inference',
                    runtimeEventOrder: { runtimeIncarnationId: 'same-runtime', sequence: 1 } }) }),
        ] });
        await compare(detail);
        await compare({ ...detail, dateRange: { startMs: start + day, endMs: end + day } });
        await db.usageEvent.deleteMany({ where: { accountId: account.id, observedAt: { lt: new Date(start) } } });
        await compare(detail);
        const historicalCoverage = await compare(request(end - day, end));
        expect(historicalCoverage.coverage?.sources.length).toBeGreaterThan(0);

        const activity = { ...detail, includeMessageStats: true, includeInsights: true,
            includeModelTimeline: true, includeLeaders: true };
        const noMessages = await compare(activity);
        expect(noMessages.messageStats?.messageCount).toBe(0);
        await db.sessionMessage.create({ data: { sessionId: competing.id, seq: 1, content: 'fixture',
            createdAt: new Date(start + 5 * day) } });
        expect((await compare(activity)).messageStats?.messageCount).toBe(1);

        applyEnvValues({ HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED: 'true' });
        const catalog = (inputUsdPerMillion: number) => JSON.stringify({ v: 1,
            models: { 'synthetic-priced': { inputUsdPerMillion, outputUsdPerMillion: 4 } },
            provenance: { source: 'litellm', origin: 'fetched', asOfMs: 1000,
                revision: 'differential-catalog', fetchStatus: 'ready' } });
        try {
            await db.simpleCache.create({ data: { key: USAGE_MODEL_PRICE_CACHE_KEY, value: catalog(2) } });
            const priceQuery = { ...detail, costMode: 'api_equivalent' as const };
            const beforeTariff = await compare(priceQuery);
            await db.simpleCache.update({ where: { key: USAGE_MODEL_PRICE_CACHE_KEY }, data: { value: catalog(3) } });
            expect((await compare(priceQuery)).costPresentation?.effectiveUsd)
                .not.toBe(beforeTariff.costPresentation?.effectiveUsd);
        } finally {
            await db.simpleCache.deleteMany({ where: { key: USAGE_MODEL_PRICE_CACHE_KEY } });
            applyEnvValues({ HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED: 'false' });
        }
    });

    it('reads full bodies only for demanded histories while retaining thin historical coverage', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        await db.$executeRaw`INSERT INTO "UsageEvent" ("id", "accountId", "observedAt", "agentId", "source", "scope",
            "inputTokens", "totalTokens", "estimatedCostUsd", "updatedAt")
            SELECT 'scale-' || n::text, ${account.id}, to_timestamp(n) AT TIME ZONE 'UTC', 'codex', 'runtime',
                'turn_delta', 1, 1, 0.01, now() FROM generate_series(1, 101518) AS n`;
        await db.$executeRawUnsafe('ANALYZE "UsageEvent"');
        const request = UsageAnalyticsQueryRequestSchema.parse({
            dateRange: { startMs: 68017_000, endMs: 101519_000 },
        });
        const count: EventReadCount = { reads: 0, ormRows: 0, rowCounts: [], metadataRows: 0, bodyRows: 0 };
        const captured = await inTx(tx => captureUsageAnalyticsInTx(countUsageEventReads(tx, count),
            account.id, request), { readOnly: true, isolationLevel: 'Serializable' });
        // Option A ruling: complete demanded histories, rather than all historical bodies.
        expect(count.bodyRows).toBe(33_502);
        expect(captured.rows).toHaveLength(33_502);
        expect(prepareUsageAnalyticsSnapshot(captured, request).rows).toHaveLength(33_502);
        const baselineRows = await inTx(tx => loadUsageEventsForQuery(tx, account.id, request),
            { readOnly: true, isolationLevel: 'Serializable' });
        expect(baselineRows).toHaveLength(101_518);
        expect(projectUsageAnalytics(captured, request)).toEqual(projectUsageAnalytics({
            rows: baselineRows, legacyReports: captured.legacyReports, priceCatalog: captured.priceCatalog,
            messageCountsBySession: undefined,
        }, request));
        expect(count).toMatchObject({ reads: 1, ormRows: 0, rowCounts: [101_518], metadataRows: 101_518, bodyRows: 33_502 });
    });
});
