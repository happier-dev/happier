import { getDbProviderFromEnv, prismaRuntime, type TransactionClient } from '@/storage/prisma';
import { ProviderAccountUsageRecordMetadataSchema } from './schemas';
import { ProviderAccountUsagePayloadInvariantError } from './types';
import { usageSqlName as name, usageSqlTimestamp as timestamp, usageSummaryCoverageCount as coverageCount,
    usageObservedDayStart, usageObservedDayStartMs } from './storageSql';

type Storage = Pick<TransactionClient, '$queryRaw' | '$executeRaw'>;
type RecordKey = Readonly<{ accountId: string; recordId: string }>;

/** Read only the server-owned leaf, never the potentially large packed projection. */
export async function readProviderAccountUsagePendingDays(key: RecordKey, storage: Storage): Promise<number[] | undefined> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const metadata = name('metadata');
    const leaf = provider === 'sqlite' ? prismaRuntime.sql`json_extract(${metadata}, '$.daySummaryPendingDays')`
        : provider === 'mysql' ? prismaRuntime.sql`JSON_EXTRACT(${metadata}, '$.daySummaryPendingDays')`
            : prismaRuntime.sql`${metadata} -> 'daySummaryPendingDays'`;
    const rows = await storage.$queryRaw<Array<{ pendingDays: unknown }>>(prismaRuntime.sql`SELECT ${leaf} AS ${name('pendingDays')}
        FROM ${name('ProviderAccountUsageRecord')} WHERE ${name('accountId')} = ${key.accountId} AND ${name('recordId')} = ${key.recordId}`);
    const raw = rows[0]?.pendingDays;
    if (raw === null || raw === undefined) return undefined;
    try { return ProviderAccountUsageRecordMetadataSchema.shape.daySummaryPendingDays.parse(typeof raw === 'string' ? JSON.parse(raw) : raw); }
    catch { throw new ProviderAccountUsagePayloadInvariantError('Invalid provider usage pending days'); }
}

/** Legacy initialization scans retained detail once, before an explicit [] exists. */
export async function readProviderAccountUsageLegacyPendingDays(key: RecordKey & Readonly<{ range?: { startAtMs: number; endAtMs: number } }>, storage: Storage): Promise<number[]> {
    const observed = prismaRuntime.sql`h.${name('observedAt')}`;
    const range = key.range ? prismaRuntime.sql`AND ${observed} >= ${timestamp(key.range.startAtMs)} AND ${observed} < ${timestamp(key.range.endAtMs)}` : prismaRuntime.empty;
    const rows = await storage.$queryRaw<Array<{ dayStartAtMs: number | bigint }>>(prismaRuntime.sql`
        SELECT DISTINCT ${usageObservedDayStartMs(observed)} AS ${name('dayStartAtMs')}
        FROM ${name('ProviderAccountUsageHistory')} h
        WHERE h.${name('accountId')} = ${key.accountId} AND h.${name('recordId')} = ${key.recordId} ${range}
            AND NOT EXISTS (SELECT 1 FROM ${name('ProviderAccountUsageDaySummary')} s
                WHERE s.${name('accountId')} = h.${name('accountId')} AND s.${name('recordId')} = h.${name('recordId')}
                    AND s.${name('dayStartAt')} = ${usageObservedDayStart(observed)} AND ${coverageCount()} > 0)
        ORDER BY ${name('dayStartAtMs')}`);
    return rows.map(row => Number(row.dayStartAtMs));
}

export async function setProviderAccountUsagePendingDays(key: RecordKey, days: readonly number[], storage: Pick<Storage, '$executeRaw'>): Promise<void> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const metadata = name('metadata');
    const value = JSON.stringify(days);
    const updated = provider === 'sqlite' ? prismaRuntime.sql`json_set(COALESCE(${metadata}, '{}'), '$.daySummaryPendingDays', json(${value}))`
        : provider === 'mysql' ? prismaRuntime.sql`JSON_SET(COALESCE(${metadata}, JSON_OBJECT()), '$.daySummaryPendingDays', CAST(${value} AS JSON))`
            : prismaRuntime.sql`jsonb_set(COALESCE(${metadata}, '{}'::jsonb), '{daySummaryPendingDays}', ${value}::jsonb)`;
    await storage.$executeRaw(prismaRuntime.sql`UPDATE ${name('ProviderAccountUsageRecord')} SET ${metadata} = ${updated}
        WHERE ${name('accountId')} = ${key.accountId} AND ${name('recordId')} = ${key.recordId}`);
}

export async function appendProviderAccountUsagePendingDay(key: RecordKey & Readonly<{ dayStartAtMs: number; knownPendingDays: readonly number[] }>,
    storage: Pick<Storage, '$executeRaw'>): Promise<void> {
    if (key.knownPendingDays.includes(key.dayStartAtMs)) return;
    const days = [...key.knownPendingDays, key.dayStartAtMs].sort((left, right) => left - right);
    await setProviderAccountUsagePendingDays(key, days, storage);
}

export async function clearProviderAccountUsagePendingDay(key: RecordKey & Readonly<{ dayStartAtMs: number }>, storage: Storage): Promise<void> {
    const days = await readProviderAccountUsagePendingDays(key, storage);
    if (days?.includes(key.dayStartAtMs)) await setProviderAccountUsagePendingDays(key, days.filter(day => day !== key.dayStartAtMs), storage);
}

/** All writers acquire current record before summary, matching accepted retention. */
export async function lockProviderAccountUsageCurrentRecord(key: RecordKey, storage: Storage): Promise<void> {
    await storage.$executeRaw(prismaRuntime.sql`UPDATE ${name('ProviderAccountUsageRecord')} SET ${name('recordId')} = ${name('recordId')}
        WHERE ${name('accountId')} = ${key.accountId} AND ${name('recordId')} = ${key.recordId}`);
}
