import type { Prisma } from '@prisma/client';
import type { UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { Tx } from '@/storage/inTx';
import { getDbProviderFromEnv, prismaRuntime } from '@/storage/prisma';
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import { TEAM_CREDENTIAL_ONLY_USAGE_SOURCES } from '../usageSourceClassifier';
import { legacyUsageReportCanonicalOrder } from '../legacyUsageReportSchema';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { ScopedUsageEventDbRow, ScopedUsageEvidenceDbRow } from './scopedUsageEventRow';

export const usageEventSelect = {
    id: true,
    sessionId: true,
    observedAt: true,
    createdAt: true,
    agentId: true,
    backendMode: true,
    modelId: true,
    projectKey: true,
    workspaceId: true,
    machineId: true,
    source: true,
    scope: true,
    isCumulative: true,
    turnId: true,
    externalKey: true,
    metadata: true,
    requestCount: true,
    teamCredentialResourceId: true,
    teamCredentialActorAccountId: true,
    teamCredentialExternalApiKeyId: true,
    teamCredentialSourceCredentialId: true,
    brokerMachineId: true,
    credentialDeliveryMode: true,
    inputTokens: true,
    outputTokens: true,
    reasoningTokens: true,
    cacheReadTokens: true,
    cacheWriteTokens: true,
    totalTokens: true,
    reportedCostUsd: true,
    estimatedCostUsd: true,
    invoiceCostUsd: true,
    billingContext: true,
    costSource: true,
    currency: true,
    costBreakdown: true,
    contextUsedTokens: true,
    contextWindowTokens: true,
} as const satisfies Prisma.UsageEventSelect;

export type UsageQueryEvent = Omit<Prisma.UsageEventGetPayload<{ select: typeof usageEventSelect }>, 'metadata'>
    & Pick<ScopedUsageEventDbRow, 'metadata' | 'accountingEvidence'>;

const usageEventEvidenceSelect = {
    id: true, sessionId: true, observedAt: true, createdAt: true, agentId: true, backendMode: true,
    modelId: true, projectKey: true, workspaceId: true, machineId: true, source: true, metadata: true,
    scope: true, isCumulative: true, teamCredentialResourceId: true, teamCredentialActorAccountId: true,
    teamCredentialExternalApiKeyId: true, teamCredentialSourceCredentialId: true,
} as const satisfies Record<Exclude<keyof ScopedUsageEvidenceDbRow, 'accountingEvidence'>, true>;

function usageEventWhere(accountId: string, endMs: number | undefined): Prisma.UsageEventWhereInput {
    return { accountId, observedAt: endMs === undefined ? undefined : { lt: new Date(endMs) },
        source: { notIn: [...TEAM_CREDENTIAL_ONLY_USAGE_SOURCES] } };
}

/** A covering window can use the single history read instead of evidence plus body hydration. */
export async function hasUsageEventHistoryBefore(tx: Tx, accountId: string, startMs: number): Promise<boolean> {
    return await tx.usageEvent.findFirst({ where: usageEventWhere(accountId, startMs), select: { id: true } }) !== null;
}

function usageEventReadSql(accountId: string, endMs: number | undefined,
    select: typeof usageEventSelect | typeof usageEventEvidenceSelect, eventIds?: readonly string[]) {
    const columns = prismaRuntime.join(Object.keys(select).map(key => key === 'metadata'
        // Root text admits both JSON objects and stored JSON strings through the canonical parser.
        ? prismaRuntime.raw('"metadata" #>> \'{}\' AS "metadata"') : prismaRuntime.raw(`"${key}"`)));
    // Timestamp-without-time-zone bounds must not depend on the connection's time zone.
    const end = endMs === undefined ? prismaRuntime.empty
        : prismaRuntime.sql`AND "observedAt" < CAST(${new Date(endMs).toISOString()} AS timestamp)`;
    // One array bind uses the existing primary key without a provider parameter-count ceiling.
    const ids = eventIds === undefined ? prismaRuntime.empty
        : prismaRuntime.sql`AND "id" = ANY(CAST(${[...eventIds]} AS text[]))`;
    return prismaRuntime.sql`SELECT ${columns} FROM "UsageEvent"
        WHERE "accountId" = ${accountId} ${end} ${ids}
          AND "source" NOT IN (${prismaRuntime.join([...TEAM_CREDENTIAL_ONLY_USAGE_SOURCES])})
        ORDER BY "observedAt" ASC`;
}

/** Historical identity/coverage stays complete while unrelated token and cost bodies stay in storage. */
export async function loadUsageEventEvidenceForQuery(tx: Tx, accountId: string,
    request: Pick<UsageAnalyticsQueryRequest, 'dateRange'>): Promise<ScopedUsageEvidenceDbRow[]> {
    const endMs = request.dateRange?.endMs;
    if (resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres')) === 'postgres') {
        return await tx.$queryRaw<ScopedUsageEvidenceDbRow[]>(usageEventReadSql(accountId, endMs, usageEventEvidenceSelect));
    }
    return await tx.usageEvent.findMany({ where: usageEventWhere(accountId, endMs),
        orderBy: { observedAt: 'asc' }, select: usageEventEvidenceSelect });
}

export async function loadRetainedLegacyUsageReports(tx: Tx, accountId: string,
    request: Pick<UsageAnalyticsQueryRequest, 'dateRange' | 'filters'>) {
    return await tx.usageReport.findMany({ where: {
        accountId,
        sessionId: request.filters?.sessionIds?.length ? { in: request.filters.sessionIds } : undefined,
        updatedAt: request.dateRange?.endMs === undefined ? undefined : { lt: new Date(request.dateRange.endMs) },
    }, orderBy: legacyUsageReportCanonicalOrder,
    select: { id: true, sessionId: true, key: true, data: true, createdAt: true, updatedAt: true } });
}

/** Keep historical replay evidence while avoiding Prisma's per-row model projection on PostgreSQL. */
export async function loadUsageEventsForQuery(tx: Tx, accountId: string,
    request: Pick<UsageAnalyticsQueryRequest, 'dateRange'>, eventIds?: readonly string[]): Promise<UsageQueryEvent[]> {
    // A range start or dimension filter would remove baselines/overlapping
    // producers before the canonical reconciler has compared their evidence.
    const endMs = request.dateRange?.endMs;
    if (eventIds?.length === 0) return [];
    if (resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres')) === 'postgres') {
        return await tx.$queryRaw<UsageQueryEvent[]>(usageEventReadSql(accountId, endMs, usageEventSelect, eventIds));
    }
    const where = usageEventWhere(accountId, endMs);
    if (eventIds === undefined) return await tx.usageEvent.findMany({ where,
        orderBy: { observedAt: 'asc' }, select: usageEventSelect });
    const rows: UsageQueryEvent[] = [];
    for (const ids of portableQueryChunks({ values: eventIds, bindingsPerValue: 1,
        fixedBindings: 1 + (endMs === undefined ? 0 : 1) + TEAM_CREDENTIAL_ONLY_USAGE_SOURCES.length })) {
        rows.push(...await tx.usageEvent.findMany({ where: { ...where, id: { in: [...ids] } },
            orderBy: { observedAt: 'asc' }, select: usageEventSelect }));
    }
    return rows.sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime());
}
