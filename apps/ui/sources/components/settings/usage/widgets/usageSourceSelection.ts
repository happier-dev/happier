import type { UsageQueryResultSlice, UsageQuerySourceState } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';

const HOW_YOU_WORK = ['how_you_work'] as const;
const ACCOUNTING = ['accounting'] as const;

/** The admitted query decides whether the chart's measure consumes private activity. */
export function readUsageChartSources(slice: UsageQueryResultSlice): readonly string[] {
  return slice.shownQuery.includeSessionEvidence ? HOW_YOU_WORK : ACCOUNTING;
}

/** The facts and coverage line share the same source dependencies, including accounting's named coverage. */
export function readUsageSourceStates(slice: UsageQueryResultSlice, sources: readonly string[]): UsageQuerySourceState[] {
  const accounting = sources.includes('accounting') ? slice.accounting?.coverage : undefined;
  const dependent = new Set([...sources, ...(accounting?.sources.map(source => source.source) ?? [])]);
  const quotaRequested = sources.includes('quota');
  return slice.sources.filter(source => dependent.has(source.source)
    || quotaRequested && source.source.startsWith('quota:'));
}
