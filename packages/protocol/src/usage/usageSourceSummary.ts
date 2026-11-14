import type { UsageAnalyticsTokens, UsageAnalyticsSourceContext } from './usageAnalyticsContracts.js';
import { addUsageMeasurements, resolveUsageMeasuredTokens } from './usageAggregation.js';

interface ExecutionContribution {
    tokens: Pick<UsageAnalyticsTokens, 'total'> & Partial<UsageAnalyticsTokens>;
    sourceContext?: Pick<UsageAnalyticsSourceContext, 'execution'>;
}

export interface UsageExecutionSourceSummary<T extends ExecutionContribution> {
    /** Coverage of execution attribution for these supplied reconciled contributions, not history completeness. */
    coverage: 'complete' | 'partial' | 'unknown';
    totalTokens: number | null;
    tokensFromParts?: true;
    groups: Array<{ execution: UsageAnalyticsSourceContext['execution']; tokens: number | null; tokensFromParts?: true; share: number | null; contributions: T[] }>;
}

/** Capture location, source names and Session linkage cannot substitute for witnessed execution. */
export function summarizeUsageExecutionSources<T extends ExecutionContribution>(
    contributions: readonly T[] | undefined,
): UsageExecutionSourceSummary<T> {
    if (!contributions) return { coverage: 'unknown', totalTokens: null, groups: [] };
    const groups = new Map<UsageAnalyticsSourceContext['execution'], { tokens: number | null; tokensFromParts?: true; contributions: T[] }>();
    let totalTokens: number | null = contributions.length === 0 ? 0 : null;
    let tokensFromParts = false;
    for (const row of contributions) {
        const execution = row.sourceContext?.execution ?? 'unknown';
        const group = groups.get(execution) ?? { tokens: null, contributions: [] };
        const measured = resolveUsageMeasuredTokens(row.tokens);
        group.tokens = addUsageMeasurements(group.tokens, measured.total);
        if (measured.fromParts) group.tokensFromParts = true;
        group.contributions.push(row);
        groups.set(execution, group);
        totalTokens = addUsageMeasurements(totalTokens, measured.total);
        tokensFromParts ||= measured.fromParts;
    }
    return {
        coverage: groups.has('unknown') ? groups.size === 1 ? 'unknown' : 'partial' : 'complete',
        totalTokens,
        ...(tokensFromParts ? { tokensFromParts: true } : {}),
        groups: (['happier', 'outside', 'unknown'] as const).flatMap(execution => {
            const group = groups.get(execution);
            return group ? [{ execution, ...group, share: totalTokens !== null && totalTokens > 0 && group.tokens !== null ? group.tokens / totalTokens : null }] : [];
        }),
    };
}
