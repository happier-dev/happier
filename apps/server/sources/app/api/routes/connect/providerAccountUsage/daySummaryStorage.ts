import type { Prisma } from '@prisma/client';
import { getDbProviderFromEnv, prismaRuntime, type TransactionClient } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { PROVIDER_ACCOUNT_USAGE_DAY_MS, StoredProviderAccountUsageDaySummaryV1Schema,
    type StoredProviderAccountUsageDaySummaryV1,
    type ProviderAccountUsageDaySummaryReadV1Schema, type ProviderAccountUsageDaySummaryResponseV1Schema,
    type ProviderAccountUsageDaySummaryWriteV1Schema } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import type { z } from 'zod/mini';
import { ProviderAccountUsagePayloadInvariantError } from './types';
import { readProviderAccountUsageHistoryCoverage, sameProviderAccountUsageHistoryCoverage } from './historyCoverage';
import { clearProviderAccountUsagePageProjection } from './recordStorage';
import { readProviderAccountUsagePendingDays, readProviderAccountUsageLegacyPendingDays,
    clearProviderAccountUsagePendingDay, lockProviderAccountUsageCurrentRecord } from './daySummaryPendingStorage';
import { usageSqlName as name, usageSqlTimestamp as timestamp, usageSqlDayEnd as dayEnd,
    usageSummaryCoverageCount as coverageCount, usageObservedAtMs } from './storageSql';

type SummaryStorage = Pick<TransactionClient, 'providerAccountUsageDaySummary' | 'providerAccountUsageHistory' | '$queryRaw' | '$executeRaw'>;
type Read = z.infer<typeof ProviderAccountUsageDaySummaryReadV1Schema>;
type Write = z.infer<typeof ProviderAccountUsageDaySummaryWriteV1Schema>;
type Response = z.infer<typeof ProviderAccountUsageDaySummaryResponseV1Schema>;
export interface ProviderAccountUsageDayKey { accountId: string; recordId: string; dayStartAtMs: number }

function atMs(value: Date | number | bigint): number { return value instanceof Date ? value.getTime() : Number(value); }

function parsePayload(payload: unknown): StoredProviderAccountUsageDaySummaryV1 {
    const parsed = StoredProviderAccountUsageDaySummaryV1Schema.safeParse(payload);
    if (!parsed.success) throw new ProviderAccountUsagePayloadInvariantError('Invalid provider usage day summary');
    return parsed.data;
}

function dayWhere(key: ProviderAccountUsageDayKey) {
    return { accountId: key.accountId, recordId: key.recordId,
        observedAt: { gte: new Date(key.dayStartAtMs), lt: new Date(key.dayStartAtMs + PROVIDER_ACCOUNT_USAGE_DAY_MS) } };
}

/** Select only missing day intervals; completed detail is never grouped again. */
async function readMissingCoverage(params: Readonly<{ accountId: string; recordId: string;
    intervals: readonly Readonly<{ startAtMs: number; endAtMs: number }>[] }>, storage: SummaryStorage) {
    const observed = name('observedAt');
    const observedMs = usageObservedAtMs(observed);
    const rows: Array<{ dayStartAtMs: number; coverage: StoredProviderAccountUsageDaySummaryV1['coverage'] }> = [];
    // Each interval is one pending UTC day. Independent range seeks avoid an
    // OR plan that scans all retained detail between nonadjacent pending days.
    for (const chunk of portableQueryChunks({ values: params.intervals, bindingsPerValue: 5, compoundSelectsPerValue: 1 })) {
        const days = chunk.map(range => prismaRuntime.sql`
            SELECT ${range.startAtMs} AS ${name('dayStartAtMs')}, ${name('id')}, ${observedMs} AS ${name('observedAtMs')},
                COUNT(*) OVER () AS ${name('observationCount')},
                ROW_NUMBER() OVER (ORDER BY ${observed} DESC, ${name('id')} DESC) AS ${name('position')}
            FROM ${name('ProviderAccountUsageHistory')}
            WHERE ${name('accountId')} = ${params.accountId} AND ${name('recordId')} = ${params.recordId}
                AND ${observed} >= ${timestamp(range.startAtMs)} AND ${observed} < ${timestamp(range.endAtMs)}`);
        const grouped = await storage.$queryRaw<Array<{ dayStartAtMs: number | bigint; id: string; observedAtMs: number | bigint; observationCount: number | bigint }>>(prismaRuntime.sql`
            SELECT ${name('dayStartAtMs')}, ${name('id')}, ${name('observedAtMs')}, ${name('observationCount')}
            FROM (${prismaRuntime.join(days, ' UNION ALL ')}) ranked
            WHERE ${name('position')} = 1`);
        rows.push(...grouped.map(row => ({ dayStartAtMs: Number(row.dayStartAtMs), coverage: {
            observationCount: Number(row.observationCount), frontier: { id: row.id, observedAtMs: Number(row.observedAtMs) },
        } })));
    }
    return rows.sort((left, right) => left.dayStartAtMs - right.dayStartAtMs);
}

/** Backfill legacy clock proofs by key, without loading completed ciphertext bodies. */
async function readLegacyClockSummaryDays(params: Readonly<{ accountId: string; recordId: string; range?: { startAtMs: number; endAtMs: number } }>, storage: SummaryStorage) {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const payload = name('payload');
    const version = provider === 'sqlite' ? prismaRuntime.sql`CAST(json_extract(${payload}, '$.clockBoundsVersion') AS TEXT)`
        : provider === 'mysql' ? prismaRuntime.sql`JSON_UNQUOTE(JSON_EXTRACT(${payload}, '$.clockBoundsVersion'))`
            : prismaRuntime.sql`${payload} ->> 'clockBoundsVersion'`;
    const range = params.range ? prismaRuntime.sql`AND ${name('dayStartAt')} >= ${timestamp(params.range.startAtMs)} AND ${name('dayStartAt')} < ${timestamp(params.range.endAtMs)}` : prismaRuntime.empty;
    const rows = await storage.$queryRaw<Array<{ dayStartAt: Date | number | bigint }>>(prismaRuntime.sql`
        SELECT ${name('dayStartAt')} FROM ${name('ProviderAccountUsageDaySummary')}
        WHERE ${name('accountId')} = ${params.accountId} AND ${name('recordId')} = ${params.recordId}
            ${range} AND COALESCE(${version}, '') <> '1' ORDER BY ${name('dayStartAt')}`);
    return rows.map(row => atMs(row.dayStartAt));
}

/** Coverage readers retain stored prefixes and expose pending work; producers load only missing bodies and predecessors. */
export async function readProviderAccountUsageDaySummaries(params: Readonly<{ accountId: string }> & Read,
    storage: SummaryStorage): Promise<Response> {
    const range = params.range ? {
        startAtMs: Math.floor(params.range.startAtMs / PROVIDER_ACCOUNT_USAGE_DAY_MS) * PROVIDER_ACCOUNT_USAGE_DAY_MS,
        endAtMs: Math.ceil(params.range.endAtMs / PROVIDER_ACCOUNT_USAGE_DAY_MS) * PROVIDER_ACCOUNT_USAGE_DAY_MS,
    } : undefined;
    const where = { accountId: params.accountId, recordId: params.recordId,
        ...(range ? { dayStartAt: { gte: new Date(range.startAtMs), lt: new Date(range.endAtMs) } } : {}) };
    let missingDays: Response['missingDays'] = [];
    if (params.includeMissingDays || params.includeCoverage) {
        const pending = await readProviderAccountUsagePendingDays(params, storage)
            ?? await readProviderAccountUsageLegacyPendingDays({ ...params, range }, storage);
        const legacy = params.includeMissingDays && params.requireClockBounds
            ? await readLegacyClockSummaryDays({ ...params, range }, storage) : [];
        const days = legacy.length ? [...new Set([...pending, ...legacy])] : pending;
        const intervals = days.filter(day => !range || day >= range.startAtMs && day < range.endAtMs)
            .map(day => ({ startAtMs: day, endAtMs: day + PROVIDER_ACCOUNT_USAGE_DAY_MS }));
        missingDays = await readMissingCoverage({ ...params, intervals }, storage);
        if (legacy.length) {
            const retainedDays = new Set(missingDays.map(day => day.dayStartAtMs));
            missingDays.push(...legacy.filter(day => !retainedDays.has(day)).map(dayStartAtMs => ({
                dayStartAtMs, coverage: { observationCount: 0, frontier: null },
            })));
            missingDays.sort((left, right) => left.dayStartAtMs - right.dayStartAtMs);
        }
    }
    if (!params.includeMissingDays) {
        const rows = await storage.providerAccountUsageDaySummary.findMany({ where, orderBy: { dayStartAt: 'asc' }, select: { dayStartAt: true, payload: true } });
        return { summaries: rows.map(row => ({ dayStartAtMs: row.dayStartAt.getTime(), payload: parsePayload(row.payload) })), missingDays };
    }
    const requiredDays = new Set<number>();
    const predecessors = new Map<number, number>();
    // One set-based lookup seeks the predecessor for each actual missing day;
    // no completed historical key range is enumerated on normal writes.
    for (const chunk of portableQueryChunks({ values: missingDays, bindingsPerValue: 1, fixedBindings: 2, compoundSelectsPerValue: 1 })) {
        const days = chunk.map(day => prismaRuntime.sql`SELECT ${timestamp(day.dayStartAtMs)} AS ${name('dayStartAt')}`);
        const rows = await storage.$queryRaw<Array<{ dayStartAt: Date | number | bigint; precedingDayStartAt: Date | number | bigint | null }>>(prismaRuntime.sql`
            SELECT m.${name('dayStartAt')}, (SELECT MAX(s.${name('dayStartAt')}) FROM ${name('ProviderAccountUsageDaySummary')} s
                WHERE s.${name('accountId')} = ${params.accountId} AND s.${name('recordId')} = ${params.recordId}
                    AND s.${name('dayStartAt')} < m.${name('dayStartAt')}) AS ${name('precedingDayStartAt')}
            FROM (${prismaRuntime.join(days, ' UNION ALL ')}) m`);
        for (const row of rows) {
            const day = atMs(row.dayStartAt);
            requiredDays.add(day);
            if (row.precedingDayStartAt !== null) { const preceding = atMs(row.precedingDayStartAt);
                predecessors.set(day, preceding); requiredDays.add(preceding); }
        }
    }
    const bodies = new Map<number, StoredProviderAccountUsageDaySummaryV1>();
    for (const chunk of portableQueryChunks({ values: [...requiredDays], bindingsPerValue: 1, fixedBindings: 2 })) {
        const rows = await storage.providerAccountUsageDaySummary.findMany({ where: { accountId: params.accountId, recordId: params.recordId,
            dayStartAt: { in: chunk.map(day => new Date(day)) } }, select: { dayStartAt: true, payload: true } });
        for (const row of rows) bodies.set(row.dayStartAt.getTime(), parsePayload(row.payload));
    }
    return { summaries: missingDays.flatMap(day => { const payload = bodies.get(day.dayStartAtMs); return payload ? [{ dayStartAtMs: day.dayStartAtMs, payload }] : []; }),
        missingDays: missingDays.map(day => { const preceding = predecessors.get(day.dayStartAtMs); const payload = preceding === undefined ? undefined : bodies.get(preceding);
            return { ...day, ...(payload && preceding !== undefined ? { precedingSummary: { dayStartAtMs: preceding, payload } } : {}) }; }) };
}

/** All summary mutation paths acquire this row after the current record row. */
async function lockSummary(key: ProviderAccountUsageDayKey, storage: SummaryStorage) {
    await storage.providerAccountUsageDaySummary.updateMany({ where: { accountId: key.accountId, recordId: key.recordId, dayStartAt: new Date(key.dayStartAtMs) },
        data: { dayStartAt: new Date(key.dayStartAtMs) } });
}

export async function writeProviderAccountUsageDaySummary(params: Readonly<{ accountId: string; value: Write }>, storage: SummaryStorage): Promise<boolean> {
    const key = { accountId: params.accountId, recordId: params.value.recordId, dayStartAtMs: params.value.dayStartAtMs };
    await lockProviderAccountUsageCurrentRecord(key, storage);
    await lockSummary(key, storage);
    const coverage = await readProviderAccountUsageHistoryCoverage(dayWhere(key), storage);
    if (!sameProviderAccountUsageHistoryCoverage(params.value.payload.coverage, coverage)) return false;
    const data = { accountId: key.accountId, recordId: key.recordId, dayStartAt: new Date(key.dayStartAtMs), payload: params.value.payload as Prisma.InputJsonValue };
    await storage.providerAccountUsageDaySummary.upsert({ where: { accountId_recordId_dayStartAt: {
        accountId: key.accountId, recordId: key.recordId, dayStartAt: data.dayStartAt } }, create: data, update: { payload: data.payload } });
    await clearProviderAccountUsagePendingDay(key, storage);
    return true;
}

export async function readExpiredProviderAccountUsageSummaryDays(params: Readonly<{ cutoff: Date; limit: number; after?: ProviderAccountUsageDayKey }>, storage: SummaryStorage) {
    const after = params.after;
    const mysql = getDbProviderFromEnv(process.env, 'postgres') === 'mysql';
    // Match the SQL-owned pending-day index. MySQL functional indexes retain
    // NULL entries; the identical CASE expression excludes compacted days.
    const pendingDay = mysql ? prismaRuntime.sql`(CASE WHEN ${coverageCount()} > 0 THEN s.${name('dayStartAt')} ELSE NULL END)`
        : prismaRuntime.sql`s.${name('dayStartAt')}`;
    const positive = mysql ? prismaRuntime.empty : prismaRuntime.sql`AND ${coverageCount()} > 0`;
    const cursor = after ? prismaRuntime.sql`AND (${pendingDay} > ${timestamp(after.dayStartAtMs)}
        OR (${pendingDay} = ${timestamp(after.dayStartAtMs)} AND s.${name('accountId')} > ${after.accountId})
        OR (${pendingDay} = ${timestamp(after.dayStartAtMs)} AND s.${name('accountId')} = ${after.accountId} AND s.${name('recordId')} > ${after.recordId}))` : prismaRuntime.empty;
    const rows = await storage.$queryRaw<Array<{ accountId: string; recordId: string; dayStartAt: Date | number | bigint }>>(prismaRuntime.sql`
        SELECT s.${name('accountId')}, s.${name('recordId')}, s.${name('dayStartAt')}
        FROM ${name('ProviderAccountUsageDaySummary')} s WHERE ${pendingDay} < ${timestamp(params.cutoff.getTime())} ${positive}
            AND EXISTS (SELECT 1 FROM ${name('ProviderAccountUsageHistory')} h
                WHERE h.${name('accountId')} = s.${name('accountId')} AND h.${name('recordId')} = s.${name('recordId')}
                    AND h.${name('observedAt')} >= s.${name('dayStartAt')} AND h.${name('observedAt')} < ${dayEnd(prismaRuntime.sql`s.${name('dayStartAt')}`)}
                    AND h.${name('observedAt')} < ${timestamp(params.cutoff.getTime())}) ${cursor}
        ORDER BY ${pendingDay}, s.${name('accountId')}, s.${name('recordId')} LIMIT ${params.limit}`);
    return rows.map(row => ({ accountId: row.accountId, recordId: row.recordId, dayStartAtMs: atMs(row.dayStartAt) }));
}

/** The server compacts only proven source rows; it never opens or derives summary content. */
export async function pruneProviderAccountUsageSummaryDetail(params: ProviderAccountUsageDayKey & Readonly<{ cutoff: Date; limit: number; dryRun: boolean;
    afterHistory?: Readonly<{ id: string; observedAtMs: number }> }>, storage: SummaryStorage) {
    if (!params.dryRun) {
        // Match accepted-write lock order (record, then summary), without the
        // Account lock. No external await or plaintext rollup happens here.
        await lockProviderAccountUsageCurrentRecord(params, storage);
        await lockSummary(params, storage);
    }
    const row = await storage.providerAccountUsageDaySummary.findUnique({ where: { accountId_recordId_dayStartAt: {
        accountId: params.accountId, recordId: params.recordId, dayStartAt: new Date(params.dayStartAtMs) } }, select: { payload: true } });
    if (!row) return { deleted: 0, hasMoreInDay: false };
    const payload = parsePayload(row.payload);
    // PUT established this proof once. The accepted material owner invalidates
    // it atomically under the same current-record lock; each partial batch can
    // trust it instead of recounting the shrinking day repeatedly.
    const coverage = payload.coverage;
    if (coverage.observationCount === 0) return { deleted: 0, hasMoreInDay: false };
    const after = params.afterHistory;
    const rows = await storage.providerAccountUsageHistory.findMany({ where: { ...dayWhere(params),
        observedAt: { gte: new Date(params.dayStartAtMs), lt: new Date(Math.min(params.cutoff.getTime(), params.dayStartAtMs + PROVIDER_ACCOUNT_USAGE_DAY_MS)) },
        ...(after ? { OR: [{ observedAt: { gt: new Date(after.observedAtMs) } }, { observedAt: new Date(after.observedAtMs), id: { gt: after.id } }] } : {}),
    }, orderBy: [{ observedAt: 'asc' }, { id: 'asc' }], take: params.limit + 1, select: { id: true, observedAt: true } });
    const selected = rows.slice(0, params.limit);
    const last = selected.at(-1);
    const result = { deleted: selected.length, hasMoreInDay: rows.length > params.limit,
        ...(last ? { afterHistory: { id: last.id, observedAtMs: last.observedAt.getTime() } } : {}) };
    if (params.dryRun || selected.length === 0) return result;
    let deleted = 0;
    for (const chunk of portableQueryChunks({ values: selected.map(row => row.id), bindingsPerValue: 1, fixedBindings: 2 })) {
        deleted += (await storage.providerAccountUsageHistory.deleteMany({ where: { accountId: params.accountId, recordId: params.recordId, id: { in: [...chunk] } } })).count;
    }
    const remaining = coverage.observationCount - deleted;
    await storage.providerAccountUsageDaySummary.update({ where: { accountId_recordId_dayStartAt: {
        accountId: params.accountId, recordId: params.recordId, dayStartAt: new Date(params.dayStartAtMs) } },
        data: { payload: { ...payload, coverage: { observationCount: remaining, frontier: remaining ? coverage.frontier : null } } as Prisma.InputJsonValue } });
    await clearProviderAccountUsagePageProjection(params, storage);
    return { ...result, deleted };
}
