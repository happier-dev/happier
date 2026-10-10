import { UsageQuerySchema, usageAnalyticsRequestToQuery, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { WidgetBindingResolutionInputV1 } from '@happier-dev/protocol/widgets';
import { buildUsageFocusFilters } from '@/sync/api/account/usageFocusFilters';
import type { UsageFilterState } from '@/sync/api/account/usageAnalytics';
import { getUsagePeriodDefinition, resolveUsagePeriodStartTimeSeconds, type UsagePeriod } from '@/sync/api/account/usagePeriods';
import { UsageWidgetPageScopeSchema } from './usageRouteParams';

export type UsageWidgetPageScope = Pick<UsageQuery, 'period' | 'agents' | 'machines' | 'projects' | 'sources' | 'session' | 'costBasis'>;
export type UsageWidgetPageInitialFilters = UsageFilterState & Readonly<{ scope?: UsageWidgetPageScope; layoutId?: string; queryOverrides?: UsageWidgetQueryOverrides }>;
export type UsageWidgetQueryOverrides = Omit<UsageQuery, keyof UsageWidgetPageScope | 'metric' | 'breakdown'>;

export { parseUsageWidgetPageScope } from './usageRouteParams';

export function readUsageWidgetPageScope(query: UsageQuery): UsageWidgetPageScope {
    const { period, agents, machines, projects, sources, session, costBasis } = query;
    return { period, agents, machines, projects, sources, session, costBasis };
}

/** Clauses remain the canonical UsageQuery grammar; only page context and widget presentation are omitted. */
export function readUsageWidgetQueryOverrides(query: UsageQuery): UsageWidgetQueryOverrides {
    const { period: _period, agents: _agents, machines: _machines, projects: _projects, sources: _sources,
        session: _session, costBasis: _costBasis, metric: _metric, breakdown: _breakdown, ...overrides } = query;
    return overrides;
}

/** Empty arrays and absent Session are offered values, rather than missing slots. */
export function readUsageWidgetPageContext(scope: UsageWidgetPageScope): WidgetBindingResolutionInputV1['context'] {
    return { period: [scope.period], agents: [scope.agents], machines: [scope.machines], projects: [scope.projects],
        sources: [scope.sources], session: [scope.session], costBasis: [scope.costBasis] };
}

export function resolveUsageWidgetPeriod(period: UsagePeriod, nowMs: number, timeZoneOffsetMinutes: number): Pick<UsageQuery, 'period' | 'granularity'> {
    return { period: { startMs: resolveUsagePeriodStartTimeSeconds(period, nowMs, timeZoneOffsetMinutes) * 1000 },
        granularity: getUsagePeriodDefinition(period).granularity };
}

/** The route supplies an already normalized, hydrated and admitted Session identity. */
export function resolveUsageWidgetPageInitialQuery(input: Readonly<{
    initialFilters?: UsageWidgetPageInitialFilters;
    sessionId?: string;
    nowMs: number;
    timeZoneOffsetMinutes: number;
}>): UsageQuery {
    const filters = input.initialFilters;
    const query = usageAnalyticsRequestToQuery({
        dateRange: resolveUsageWidgetPeriod(filters?.period ?? '7days', input.nowMs, input.timeZoneOffsetMinutes).period,
        granularity: getUsagePeriodDefinition(filters?.period ?? '7days').granularity,
        timeZoneOffsetMinutes: input.timeZoneOffsetMinutes,
        costMode: filters?.costMode ?? 'auto',
        filters: buildUsageFocusFilters(filters?.focus),
        includeSeries: true,
        includeInsights: true,
        includeActivity: true,
        includeLeaders: true,
        includeModelTimeline: true,
        includeMessageStats: true,
        activityResolution: 'both',
    }, { metric: filters?.metric ?? 'tokens' });
    return UsageQuerySchema.parse({ ...query, ...filters?.queryOverrides, ...filters?.scope,
        ...(input.sessionId === undefined ? {} : { session: input.sessionId }) });
}

/** Session-page changes cannot widen or replace their admitted route scope. */
export function applyUsageWidgetPageScope(query: UsageQuery, patch: Partial<UsageWidgetPageScope>, sessionId?: string): UsageQuery {
    const scope = UsageWidgetPageScopeSchema.parse({ ...readUsageWidgetPageScope(query), ...patch });
    return UsageQuerySchema.parse({ ...query, ...scope, ...(sessionId === undefined ? {} : { session: sessionId }) });
}

/**
 * One scope filter's next selection (lab `d2filter`): an empty list means every value. Choosing from
 * "all" narrows to that one; further choices add or remove; clearing the last one, or choosing every
 * listed value, returns to all. Values the facts no longer list are kept until the viewer removes them.
 */
export function toggleUsageScopeSelection(selected: readonly string[], id: string, options: readonly string[]): string[] {
    const next = selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id];
    if (next.length === 0) return [];
    if (options.length > 0 && options.every(option => next.includes(option))
        && next.every(value => options.includes(value))) return [];
    return [...next].sort();
}
