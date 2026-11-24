import type { UsageAnalyticsBreakdownDimension } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

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
