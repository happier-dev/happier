import type { UsageSourcesActionListV1 } from './usageSources.js';
import { buildQualifiedPluginContributionKey } from '../plugins/contributionKey.js';

type SourceGroup = NonNullable<UsageSourcesActionListV1['summary']>['groups'][number];

/** Broad agent reads conserve status counts and selectors, not private root cards. */
export function projectUsageSourcesDelivery(
  inventory: UsageSourcesActionListV1,
  sourceId: string | undefined,
  surface: string | null | undefined,
): UsageSourcesActionListV1 {
  if ((surface !== 'agent' && surface !== 'mcp') || sourceId !== undefined) return inventory;
  const groups = new Map<string, SourceGroup>();
  for (const source of inventory.sources) {
    const key = JSON.stringify([buildQualifiedPluginContributionKey(source.agent), source.consent, source.status, source.coverage]);
    const selector = { sourceId: source.sourceId,
      ...(source.discoveredFileCount === undefined ? {} : { discoveredFileCount: source.discoveredFileCount }) };
    const group = groups.get(key);
    if (group) {
      group.sourceCount++;
      group.pendingCount += source.pendingCount;
      group.sources.push(selector);
    } else {
      groups.set(key, { agent: source.agent, consent: source.consent, status: source.status, coverage: source.coverage,
        sourceCount: 1, pendingCount: source.pendingCount, sources: [selector] });
    }
  }
  return { sources: [], summary: { sourceCount: inventory.sources.length, groups: [...groups.values()] } };
}
