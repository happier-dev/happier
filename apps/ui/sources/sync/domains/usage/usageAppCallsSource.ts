import type { UsageAnalyticsBreakdownDimension } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
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
 * An already admitted App calls read, priced by the viewer's Usage prices (`projectAppCallsUsageV1`), as the result
 * slice the Usage bodies draw. A host that holds its own collector read (an Environment's LLM calls) shows it through the
 * same bodies as Usage → Your apps, instead of drawing its own charts; the query names the App calls subject.
 */
export function appCallsUsageSlice(input: Readonly<{
  key: string;
  query: UsageQuery;
  usage: AppCallsUsageV1;
  catalog: UsageModelPriceCatalog;
  readAtMs: number;
}>): UsageQueryResultSlice {
  return {
    key: input.key,
    requestedQuery: input.query,
    shownQuery: input.query,
    accounting: { ...input.usage.accounting, priceCatalog: input.catalog },
    costFactTotals: projectUsageCostFactTotals(input.usage.accounting.costFacts ?? []),
    sources: [{ source: 'accounting', status: 'available', asOfMs: input.readAtMs }],
    pending: false,
  };
}
