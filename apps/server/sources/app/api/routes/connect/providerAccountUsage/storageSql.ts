import type { Prisma } from '@prisma/client';
import { getDbProviderFromEnv, prismaRuntime } from '@/storage/prisma';
import { PROVIDER_ACCOUNT_USAGE_DAY_MS } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';

export function usageSqlName(value: string): Prisma.Sql {
    const quote = getDbProviderFromEnv(process.env, 'postgres') === 'mysql' ? '`' : '"';
    return prismaRuntime.raw(`${quote}${value}${quote}`);
}

export function usageSqlTimestamp(atMs: number): Prisma.Sql {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'sqlite') return prismaRuntime.sql`${atMs}`;
    if (provider === 'mysql') return prismaRuntime.sql`${new Date(atMs)}`;
    return prismaRuntime.sql`${new Date(atMs).toISOString()}::timestamp`;
}

export function usageSqlDayEnd(column: Prisma.Sql): Prisma.Sql {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'sqlite') return prismaRuntime.sql`${column} + ${PROVIDER_ACCOUNT_USAGE_DAY_MS}`;
    if (provider === 'mysql') return prismaRuntime.sql`TIMESTAMPADD(DAY, 1, ${column})`;
    return prismaRuntime.sql`${column} + INTERVAL '1 day'`;
}

export function usageSummaryCoverageCount(): Prisma.Sql {
    const payload = prismaRuntime.sql`s.${usageSqlName('payload')}`;
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'sqlite') return prismaRuntime.sql`json_extract(${payload}, '$.coverage.observationCount')`;
    if (provider === 'mysql') return prismaRuntime.sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${payload}, '$.coverage.observationCount')) AS UNSIGNED)`;
    return prismaRuntime.sql`CAST(${payload} #>> '{coverage,observationCount}' AS BIGINT)`;
}

export function usageObservedAtMs(column: Prisma.Sql): Prisma.Sql {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'sqlite') return column;
    if (provider === 'mysql') return prismaRuntime.sql`(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', ${column}) DIV 1000)`;
    return prismaRuntime.sql`CAST(EXTRACT(EPOCH FROM ${column}) * 1000 AS BIGINT)`;
}

export function usageObservedDayStartMs(column: Prisma.Sql): Prisma.Sql {
    const ms = usageObservedAtMs(column);
    return getDbProviderFromEnv(process.env, 'postgres') === 'sqlite'
        ? prismaRuntime.sql`CAST(${ms} / ${PROVIDER_ACCOUNT_USAGE_DAY_MS} AS BIGINT) * ${PROVIDER_ACCOUNT_USAGE_DAY_MS}`
        : prismaRuntime.sql`FLOOR(${ms} / ${PROVIDER_ACCOUNT_USAGE_DAY_MS}) * ${PROVIDER_ACCOUNT_USAGE_DAY_MS}`;
}

export function usageObservedDayStart(column: Prisma.Sql): Prisma.Sql {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'sqlite') return usageObservedDayStartMs(column);
    if (provider === 'mysql') return prismaRuntime.sql`DATE(${column})`;
    return prismaRuntime.sql`date_trunc('day', ${column})`;
}
