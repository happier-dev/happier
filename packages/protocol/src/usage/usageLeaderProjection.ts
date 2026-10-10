import type { UsageAnalyticsContribution, UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { addUsageCostForMode, addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens, withEffectiveUsageCost } from './usageAggregation.js';
import { resolveEffectiveUsageCostUsd, resolveUsageContributionDimensionKey, type UsageCostMode } from './usageCost.js';

export type UsageLeaderDimension = Parameters<typeof resolveUsageContributionDimensionKey>[1];
export type UsageLeaderContribution = Pick<UsageAnalyticsContribution,
    'sessionId' | 'agentId' | 'backendMode' | 'modelId' | 'projectKey' | 'workspaceId' | 'source' | 'tokens' | 'cost'>
    & { machineId?: string | null; eventCount: number };
type UsageLeader = NonNullable<NonNullable<UsageAnalyticsQueryResponse['leaders']>['models']>[number];

/** Server and private client reprojection rank the same complete candidate population. */
export function buildUsageLeaderList(rows: readonly UsageLeaderContribution[], dimension: UsageLeaderDimension, topLimit: number,
    mode: UsageCostMode, labels: ReadonlyMap<string, string | undefined> = new Map()): UsageLeader[] | undefined {
    const grouped = new Map<string, UsageLeader & { tokens: UsageLeaderContribution['tokens']; cost: UsageLeaderContribution['cost'] }>();
    for (const row of rows) {
        const key = resolveUsageContributionDimensionKey(row, dimension) ?? 'unknown';
        const existing = grouped.get(key) ?? { key, label: labels.get(key) ?? key, eventCount: 0,
            tokens: createEmptyUsageTokens(), cost: createEmptyUsageCost() };
        existing.eventCount += row.eventCount;
        existing.tokens = addUsageTokens(existing.tokens, row.tokens);
        existing.cost = addUsageCostForMode(existing.cost, row.cost, mode);
        grouped.set(key, existing);
    }
    if (!grouped.size) return undefined;
    return [...grouped.values()].sort((left, right) => right.tokens.total - left.tokens.total
        || resolveEffectiveUsageCostUsd(right.cost, mode) - resolveEffectiveUsageCostUsd(left.cost, mode)
        || right.eventCount - left.eventCount || left.key.localeCompare(right.key))
        .slice(0, topLimit).map(leader => ({ ...leader, cost: withEffectiveUsageCost(leader.cost, mode) }));
}

/** Older contributions lack witnessed counts; keep their candidates and mark ranking incomplete. */
export function reprojectUsageLeaders(value: UsageAnalyticsQueryResponse, contributions: readonly UsageAnalyticsContribution[], mode: UsageCostMode,
    projectCost: (raw: UsageLeaderContribution['cost'], rows: readonly UsageAnalyticsContribution[]) => UsageLeaderContribution['cost']):
    Pick<UsageAnalyticsQueryResponse, 'leaders' | 'modelTimeline' | 'engineTimeline' | 'coverage'> {
    let incomplete = false;
    const project = (entries: UsageLeader[] | undefined, rows: readonly UsageAnalyticsContribution[], dimension: UsageLeaderDimension) => {
        if (!entries) return undefined;
        if (rows.every(row => row.eventCount !== undefined)) {
            return buildUsageLeaderList(rows.map(row => ({ ...row, eventCount: row.eventCount! })), dimension, entries.length, mode,
                new Map(entries.map(entry => [entry.key, entry.label]))) ?? [];
        }
        incomplete = true;
        return entries.map(entry => ({ ...entry, ...(entry.cost ? { cost: projectCost(entry.cost,
            rows.filter(row => (resolveUsageContributionDimensionKey(row, dimension) ?? 'unknown') === entry.key)) } : {}) }));
    };
    const leaders = value.leaders && { ...value.leaders };
    const dimensions = { agents: 'agent', models: 'model', sessions: 'session', projects: 'project', workspaces: 'workspace', engines: 'engine' } as const;
    if (leaders) for (const key of Object.keys(dimensions) as (keyof typeof dimensions)[]) leaders[key] = project(leaders[key], contributions, dimensions[key]);
    const timeline = (buckets: UsageAnalyticsQueryResponse['modelTimeline'], dimension: 'model' | 'engine') => buckets?.map(bucket => ({ ...bucket,
        leaders: project(bucket.leaders, contributions.filter(row => row.observedAtMs >= bucket.bucketStartMs && row.observedAtMs < bucket.bucketEndMs), dimension) ?? [] }));
    const modelTimeline = timeline(value.modelTimeline, 'model');
    const engineTimeline = timeline(value.engineTimeline, 'engine');
    const coverage = incomplete && value.coverage ? { ...value.coverage,
        status: value.coverage.status === 'complete' ? 'partial' as const : value.coverage.status,
        reasons: [...new Set([...value.coverage.reasons, 'ranked_truncation' as const])],
        ranked: value.coverage.ranked.map(entry => ({ ...entry, complete: false })),
    } : value.coverage;
    return { leaders, modelTimeline, engineTimeline, coverage };
}
