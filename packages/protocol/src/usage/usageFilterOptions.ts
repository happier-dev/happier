import type { UsageAnalyticsBreakdownDimension, UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import type { UsageQueryResultSlice } from './resolveUsagePageAggregation.js';

export type UsageScopeFilterField = 'sources' | 'agents' | 'machines' | 'projects';
export const usageScopeFilterDimensions = {
  sources: 'source', agents: 'agent', machines: 'machine', projects: 'project',
} as const satisfies Readonly<Record<UsageScopeFilterField, UsageAnalyticsBreakdownDimension>>;

/** Reused results keep the same scope metadata and dimension order as a direct query. */
export function selectUsageScopeKeys(inventory: UsageAnalyticsQueryResponse['scopeKeys'],
  dimensions: readonly UsageAnalyticsBreakdownDimension[] | undefined): UsageAnalyticsQueryResponse['scopeKeys'] {
  const selected = (dimensions ?? []).flatMap(dimension => {
    const entry = inventory?.find(row => row.dimension === dimension);
    return entry ? [entry] : [];
  });
  return selected.length ? selected : undefined;
}

/** Engine timeline keys carry the Agent id before an optional backend mode. */
export function agentIdFromEngineKey(key: string): string {
  const separator = key.indexOf(':');
  return separator === -1 ? key : key.slice(0, separator);
}

/**
 * Both ordinary inputs and the Usage toolbar consume the admitted accounting inventory. `anchorOf`
 * (`createProjectAnchorOfKeyV1`, owner 11-08) lists usage a checkout was stamped with under the Project it belongs to now.
 */
export function readUsageScopeOptions(slices: readonly UsageQueryResultSlice[], field: UsageScopeFilterField,
  selected: readonly string[] = [], anchorOf?: (key: string) => string): Map<string, string> {
  const labels = new Map<string, string>();
  const optionKey = (key: string) => field === 'projects' && anchorOf ? anchorOf(key) : key;
  for (const slice of slices) {
    if (field === 'agents') for (const bucket of slice.accounting?.engineTimeline ?? []) for (const entry of bucket.leaders) {
      const agentId = agentIdFromEngineKey(entry.key);
      if (!labels.has(agentId)) labels.set(agentId, agentId);
    }
    for (const entry of slice.accounting?.breakdowns?.[usageScopeFilterDimensions[field]] ?? []) {
      const key = optionKey(entry.key);
      // A grouped Project keeps the label its anchor's own entry carries.
      labels.set(key, (key === entry.key ? entry.label : undefined) ?? labels.get(key) ?? entry.label ?? key);
    }
    // Ranked entries supply labels, not membership. The producer's complete
    // identities retain every member of a folded group below the chart cutoff.
    for (const inventory of slice.accounting?.scopeKeys ?? []) {
      if (inventory.dimension !== usageScopeFilterDimensions[field]) continue;
      for (const rawKey of inventory.keys) {
        const key = optionKey(rawKey);
        if (!labels.has(key)) labels.set(key, key);
      }
    }
    if (field === 'sources') for (const source of slice.accounting?.coverage?.sources ?? []) {
      if (!labels.has(source.source)) labels.set(source.source, source.source);
    }
    if (field === 'machines') for (const source of slice.accounting?.coverage?.sources ?? []) {
      if (source.machineId && !labels.has(source.machineId)) labels.set(source.machineId, source.machineId);
    }
  }
  for (const value of selected) if (!labels.has(value)) labels.set(value, value);
  return labels;
}
