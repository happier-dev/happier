import type { UsageAnalyticsBreakdownDimension } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { projectUsageAccountingSnapshotPrices, type UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { AppCallsUsageV1 } from '@happier-dev/plugin-sdk/usage';
import { projectUsageCostFactTotals } from '@happier-dev/protocol/usage/usageCostFactTotals';

import { readUsageAppCallsEnvironmentIds } from '@happier-dev/plugin-sdk/usage';
export { readUsageAppCallsEnvironmentIds, usageAppCallsSourceId } from '@happier-dev/plugin-sdk/usage';

/**
 * App calls have no Agent: in Your apps a ranking by agent ranks the Environments that made the calls, which the App
 * slice carries as its sources (one per Environment). Agents' rankings are returned unchanged.
 */
export function resolveUsageShownBreakdown(
  dimensions: readonly UsageAnalyticsBreakdownDimension[],
  sources: readonly string[] | null | undefined,
): readonly UsageAnalyticsBreakdownDimension[] {
  if (readUsageAppCallsEnvironmentIds(sources) === null || !dimensions.includes('agent'))
    return dimensions;
  return [...new Set(dimensions.map((dimension) => (dimension === 'agent' ? 'source' : dimension)))];
}

/**
 * An already admitted App calls read as the result slice the Usage bodies draw, priced the way Usage → Your apps prices
 * it: the accounting snapshot owner applies the viewer's catalog and overrides for the query's cost basis. A host that
 * holds its own collector read (an Environment's LLM calls) shows it through the same bodies instead of its own charts.
 */
export function appCallsUsageSlice(input: Readonly<{
  key: string;
  query: UsageQuery;
  usage: AppCallsUsageV1;
  catalog: UsageModelPriceCatalog;
  viewerOverrides: UsageModelPriceOverridesV1;
  readAtMs: number;
}>): UsageQueryResultSlice {
  const snapshot = projectUsageAccountingSnapshotPrices({ query: input.query, status: 'available', readAtMs: input.readAtMs,
    value: { ...input.usage.accounting, priceCatalog: input.catalog } }, input.viewerOverrides, input.catalog);
  const accounting = snapshot.priceProjection?.value ?? snapshot.value!;
  return {
    key: input.key,
    requestedQuery: input.query,
    shownQuery: input.query,
    accounting,
    costFactTotals: projectUsageCostFactTotals(accounting.costFacts ?? []),
    sources: [{ source: 'accounting', status: 'available', asOfMs: input.readAtMs }],
    pending: false,
  };
}
