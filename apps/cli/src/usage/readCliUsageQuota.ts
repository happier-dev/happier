import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import { getUsageQueryKey, resolveUsageQueryPeriod, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { projectUsageQuotaCoverage, projectUsageQuotaSourceCoverage, type UsageQuotaCoverageRead, type UsageQuotaSourceSnapshot } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';

type ReadQuota = NonNullable<NonNullable<ActionExecutorDeps['usageActions']>['readQuota']>;

/** Share equivalent finite reads without attaching another period's page or continuation. */
export async function readCliUsageQuota(input: Readonly<{
  queries: readonly UsageQuery[];
  sources: readonly Parameters<ReadQuota>[0]['source'][];
  nowMs: number;
  context: ActionExecutorContext;
  readQuota: ReadQuota;
}>): Promise<ReadonlyMap<string, UsageQuotaSourceSnapshot>> {
  const groups = new Map<string, { history?: NonNullable<Parameters<ReadQuota>[0]['history']>; queries: UsageQuery[] }>();
  for (const query of input.queries) {
    if (query.includeQuota === false) continue;
    const period = resolveUsageQueryPeriod(query, input.nowMs);
    const range = { startAtMs: period.startMs ?? 0, endAtMs: period.endMs ?? input.nowMs };
    // Keep quota.get's finite-page contract; a cursor is evidence of partial coverage.
    const history = query.includeQuotaHistory && range.endAtMs > range.startAtMs ? { range, pageSize: 100 } : undefined;
    const key = history ? `${range.startAtMs}:${range.endAtMs}` : 'head';
    const group = groups.get(key);
    if (group) group.queries.push(query);
    else groups.set(key, { history, queries: [query] });
  }
  const snapshots = await Promise.all([...groups.values()].map(async group => {
    const rows = await Promise.all(input.sources.map(async (source): Promise<UsageQuotaCoverageRead> => {
      const result = await input.readQuota({ source, ...(group.history ? { history: group.history } : {}) }, input.context);
      const settledAtMs = Date.now();
      const sourceKey = `quota:${createCanonicalJsonSigningInput(source)}`;
      if ('ok' in result) return { value: null, state: { source: sourceKey,
        status: result.errorCode === 'unsupported' ? 'unsupported' : 'error',
        errorCode: result.errorCode ?? 'usage_quota_read_failed',
      } };
      return { value: result, state: projectUsageQuotaSourceCoverage(sourceKey, result, settledAtMs, group.history !== undefined) };
    }));
    const snapshot = projectUsageQuotaCoverage(rows, 'available');
    return group.queries.map(query => [getUsageQueryKey(query), snapshot] as const);
  }));
  return new Map(snapshots.flat());
}
