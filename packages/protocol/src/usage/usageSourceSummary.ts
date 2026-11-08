import type { UsageAnalyticsContribution, UsageAnalyticsSourceContext } from './usageAnalyticsContracts.js';

interface ExecutionContribution {
    tokens: Pick<UsageAnalyticsContribution['tokens'], 'total'>;
    sourceContext?: Pick<UsageAnalyticsSourceContext, 'execution'>;
}

export interface UsageExecutionSourceSummary<T extends ExecutionContribution> {
    /** Coverage of execution attribution for these supplied reconciled contributions, not history completeness. */
    coverage: 'complete' | 'partial' | 'unknown';
    totalTokens: number | null;
    groups: Array<{ execution: UsageAnalyticsSourceContext['execution']; tokens: number; share: number | null; contributions: T[] }>;
}

/** Capture location, source names and Session linkage cannot substitute for witnessed execution. */
export function summarizeUsageExecutionSources<T extends ExecutionContribution>(
    contributions: readonly T[] | undefined,
): UsageExecutionSourceSummary<T> {
    if (!contributions) return { coverage: 'unknown', totalTokens: null, groups: [] };
    const groups = new Map<UsageAnalyticsSourceContext['execution'], { tokens: number; contributions: T[] }>();
    let totalTokens = 0;
    for (const row of contributions) {
        const execution = row.sourceContext?.execution ?? 'unknown';
        const group = groups.get(execution) ?? { tokens: 0, contributions: [] };
        group.tokens += row.tokens.total;
        group.contributions.push(row);
        groups.set(execution, group);
        totalTokens += row.tokens.total;
    }
    return {
        coverage: groups.has('unknown') ? groups.size === 1 ? 'unknown' : 'partial' : 'complete',
        totalTokens,
        groups: (['happier', 'outside', 'unknown'] as const).flatMap(execution => {
            const group = groups.get(execution);
            return group ? [{ execution, ...group, share: totalTokens > 0 ? group.tokens / totalTokens : null }] : [];
        }),
    };
}
