import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyPostgresMigrations } from '../../../scripts/prismaMigrations';
import { openPgliteMigrationSession, type PgliteMigrationSession } from '../../../scripts/pgliteMigrationSession';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { applyEnvValues, restoreEnv, snapshotEnv } from '@/testkit/env';
import { TEAM_CREDENTIAL_ONLY_USAGE_SOURCES } from './usageSourceClassifier';
import { captureUsageAnalyticsInTx, projectUsageAnalytics } from './usageQueryService';
import { loadUsageEventsForQuery } from './query/loadUsageEventsForQuery';
import { prepareUsageAnalyticsSnapshot, projectUsageAnalyticsPopulation } from './query/projectUsageAnalyticsPopulation';

type EventReadCount = { reads: number; ormRows: number; rowCounts?: number[]; metadataRows?: number };

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
                    count.reads += 1;
                    count.rowCounts?.push(rows.length);
                    if (count.metadataRows !== undefined && rows[0] && Object.hasOwn(rows[0], 'metadata')) {
                        count.metadataRows += rows.length;
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
        expect(projectUsageAnalytics(empty, UsageAnalyticsQueryRequestSchema.parse({ dateRange: { endMs: 100 } }))
            .totals.tokens.total).toBe(0);
    });

    it('captures history in one SQL read and hydrates window subjects after commit', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        await db.$executeRaw`INSERT INTO "UsageEvent" ("id", "accountId", "observedAt", "agentId", "source", "scope",
            "inputTokens", "totalTokens", "estimatedCostUsd", "updatedAt")
            SELECT 'scale-' || n::text, ${account.id}, to_timestamp(n) AT TIME ZONE 'UTC', 'codex', 'runtime',
                'turn_delta', 1, 1, 0.01, now() FROM generate_series(1, 33658) AS n`;
        const request = UsageAnalyticsQueryRequestSchema.parse({
            dateRange: { startMs: 26397_000, endMs: 33659_000 },
        });
        const count: EventReadCount = { reads: 0, ormRows: 0, rowCounts: [], metadataRows: 0 };
        const captured = await inTx(tx => captureUsageAnalyticsInTx(countUsageEventReads(tx, count),
            account.id, request), { readOnly: true, isolationLevel: 'Serializable' });
        expect(captured.rows).toHaveLength(33_658);
        expect(prepareUsageAnalyticsSnapshot(captured, request).rows).toHaveLength(7_262);
        const baselineRows = await inTx(tx => loadUsageEventsForQuery(tx, account.id, request),
            { readOnly: true, isolationLevel: 'Serializable' });
        expect(baselineRows).toHaveLength(33_658);
        expect(projectUsageAnalytics(captured, request)).toEqual(projectUsageAnalytics({
            rows: baselineRows, legacyReports: captured.legacyReports, priceCatalog: captured.priceCatalog,
            messageCountsBySession: undefined,
        }, request));
        expect(count).toEqual({ reads: 1, ormRows: 0, rowCounts: [33_658], metadataRows: 33_658 });
    });
});
