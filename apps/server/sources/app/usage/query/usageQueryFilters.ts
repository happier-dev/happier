import type { UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { canonicalUsageModelPriceId } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { resolveUsageContributionDimensionKey } from '@happier-dev/protocol/usage/usageCost';
import { resolveUsageContributionSourceContext, type ScopedUsageContribution } from './resolveScopedUsageContributions';
import { isScopedUsageTurnDelta } from './scopedUsageEventRow';

export type UsageFilterRow = Pick<ScopedUsageContribution,
    'sessionId' | 'agentId' | 'modelId' | 'projectKey' | 'workspaceId' | 'machineId'
    | 'backendMode' | 'source' | 'metadata' | 'accountingEvidence'>;

export type UsageFilterIndexColumn = 'sessionId' | 'agentId' | 'modelKey' | 'projectKey'
    | 'workspaceId' | 'machineId' | 'backendMode' | 'source' | 'execution';

/** Resolve only the canonical operands required by the query's filters. */
export function usageFilterIndexValue(row: UsageFilterRow, field: UsageFilterIndexColumn): string {
    switch (field) {
        case 'sessionId': return row.sessionId ?? 'unknown';
        case 'agentId': return row.agentId ?? 'unknown';
        case 'modelKey': return resolveUsageContributionDimensionKey(row, 'model') ?? 'unknown';
        case 'projectKey': return row.projectKey ?? 'unknown';
        case 'workspaceId': return row.workspaceId ?? 'unknown';
        case 'machineId': return row.machineId ?? 'unknown';
        case 'backendMode': return row.backendMode ?? 'unknown';
        case 'source': return row.source ?? 'unknown';
        case 'execution': return resolveUsageContributionSourceContext(row).execution;
    }
}

export function matchesUsageFilters(row: UsageFilterRow, filters: UsageAnalyticsQueryRequest['filters']): boolean {
    if (!filters) return true;
    const matches = (values: readonly string[] | undefined, field: UsageFilterIndexColumn) =>
        !values?.length || values.includes(usageFilterIndexValue(row, field));
    return matches(filters.sessionIds, 'sessionId')
        && matches(filters.agentIds, 'agentId')
        && (!filters.modelIds?.length || filters.modelIds.some(id =>
            (canonicalUsageModelPriceId(id) ?? 'unknown') === usageFilterIndexValue(row, 'modelKey')))
        && matches(filters.projectKeys, 'projectKey')
        && matches(filters.workspaceIds, 'workspaceId')
        && matches(filters.machineIds, 'machineId')
        && matches(filters.backendModes, 'backendMode')
        && matches(filters.sources, 'source')
        && (filters.execution === undefined || usageFilterIndexValue(row, 'execution') === filters.execution);
}

/** Counter reconciliation may emit an unattributed residual from this observation. */
export function canMatchUsageFilters(row: UsageFilterRow & Pick<ScopedUsageContribution, 'scope' | 'isCumulative'>,
    filters: UsageAnalyticsQueryRequest['filters']): boolean {
    return matchesUsageFilters(row, filters)
        || (!isScopedUsageTurnDelta(row) && matchesUsageFilters({ ...row, modelId: null }, filters));
}
