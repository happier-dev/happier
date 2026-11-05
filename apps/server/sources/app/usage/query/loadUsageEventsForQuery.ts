import type { Prisma } from '@prisma/client';
import type { UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { Tx } from '@/storage/inTx';
import { getDbProviderFromEnv, prismaRuntime } from '@/storage/prisma';
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import { TEAM_CREDENTIAL_ONLY_USAGE_SOURCES } from '../usageSourceClassifier';
import { legacyUsageReportCanonicalOrder } from '../legacyUsageReportSchema';
import type { ScopedUsageEvidenceRow } from './scopedUsageEventRow';

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
    & Pick<ScopedUsageEvidenceRow, 'metadata'>;

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
    request: Pick<UsageAnalyticsQueryRequest, 'dateRange'>): Promise<UsageQueryEvent[]> {
    // A range start or dimension filter would remove baselines/overlapping
    // producers before the canonical reconciler has compared their evidence.
    const endMs = request.dateRange?.endMs;
    if (resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres')) === 'postgres') {
        // Both transports consume this one select. Only these constant schema
        // identifiers enter raw SQL; Account, source and date values stay bound.
        const columns = prismaRuntime.join(Object.keys(usageEventSelect).map(key => key === 'metadata'
            // Root text keeps stored JSON strings compatible with the canonical one-pass metadata parser.
            ? prismaRuntime.raw('"metadata" #>> \'{}\' AS "metadata"') : prismaRuntime.raw(`"${key}"`)));
        // These columns are timestamp without time zone. A raw Date parameter
        // is timestamptz and would shift the bound on non-UTC connections.
        const end = endMs === undefined ? prismaRuntime.empty
            : prismaRuntime.sql`AND "observedAt" < CAST(${new Date(endMs).toISOString()} AS timestamp)`;
        return await tx.$queryRaw<UsageQueryEvent[]>(prismaRuntime.sql`
            SELECT ${columns} FROM "UsageEvent"
            WHERE "accountId" = ${accountId} ${end}
              AND "source" NOT IN (${prismaRuntime.join([...TEAM_CREDENTIAL_ONLY_USAGE_SOURCES])})
            ORDER BY "observedAt" ASC`);
    }
    return await tx.usageEvent.findMany({
        where: { accountId,
            observedAt: endMs === undefined ? undefined : { lt: new Date(endMs) },
            source: { notIn: [...TEAM_CREDENTIAL_ONLY_USAGE_SOURCES] } },
        orderBy: { observedAt: 'asc' },
        select: usageEventSelect,
    });
}
