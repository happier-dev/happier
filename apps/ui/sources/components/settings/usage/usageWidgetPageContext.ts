import { normalizeUsageQuery, USAGE_QUERY_INPUT_FIELDS, UsageQuerySchema, usageAnalyticsRequestToQuery, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { projectNativeJsonValueForTransport, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WidgetBindingResolutionInputV1 } from '@happier-dev/protocol/widgets';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { t } from '@/text';
import { buildUsageFocusFilters } from '@/sync/api/account/usageFocusFilters';
import type { UsageFilterState } from '@/sync/api/account/usageAnalytics';
import { getUsagePeriodDefinition, type UsagePeriod } from '@/sync/api/account/usagePeriods';
import { UsageWidgetPageScopeSchema } from './usageRouteParams';
import { formatUsageCalendarPeriod } from '@/sync/domains/usage/usageCalendarPresentation';

export type UsageWidgetPageScope = Pick<UsageQuery, 'period' | 'agents' | 'machines' | 'projects' | 'sources' | 'session' | 'costBasis'>;
/** `period` is present only when the route carried one; the page's default is `resolveUsagePageDefaultPeriod`. */
export type UsageWidgetPageInitialFilters = Omit<UsageFilterState, 'period'> & Readonly<{ period?: UsagePeriod; scope?: UsageWidgetPageScope; layoutId?: string;
    queryOverrides?: UsageWidgetQueryOverrides }>;

/** The one default period: the account page opens on the last 7 days, a Session's own page on the whole Session. */
export function resolveUsagePageDefaultPeriod(sessionId?: string): UsagePeriod {
    return sessionId === undefined ? '7days' : 'all';
}
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

/** Empty scopes remain runtime binding values; editor slot availability is projected separately. */
export function readUsageWidgetPageContext(scope: UsageWidgetPageScope): WidgetBindingResolutionInputV1['context'] {
    return { period: [projectNativeJsonValueForTransport(scope.period)], agents: [scope.agents], machines: [scope.machines], projects: [scope.projects],
        sources: [scope.sources], session: [scope.session], costBasis: [scope.costBasis] };
}

/** Inventory keeps the page period and Session while listing every value of the other scopes. */
export function buildUsageWidgetPageInventoryQuery(clauses: UsageWidgetQueryOverrides,
    context: WidgetBindingResolutionInputV1['context']): UsageQuery {
    return normalizeUsageQuery({
        ...clauses,
        ...Object.fromEntries(Object.entries(context).map(([path, values]) => [path, values[0]])),
        agents: [], machines: [], projects: [], sources: [], metric: 'tokens', breakdown: ['agent', 'machine', 'project', 'source'],
    });
}

const SCOPE_NOUN_KEYS = {
    agents: 'usage.board.page.filterAgents',
    machines: 'usage.board.page.filterMachines',
    projects: 'usage.board.page.filterProjects',
    sources: 'usage.board.page.filterSources',
} as const;
const COST_BASIS_KEYS = {
    auto: 'usage.board.page.costBasisAuto',
    reported: 'usage.board.page.costBasisReported',
    estimated: 'usage.board.page.costBasisEstimated',
    api_equivalent: 'widgetAdd.inputLabels.apiEquivalent',
} as const;

/** What the page shows after a follow chip's source: its value, never a field noun or id. */
export function describeUsageWidgetSlotValue(path: string, value: JsonValue | undefined, _period: UsagePeriod): string {
    if (path === 'period' && value !== undefined) {
        const period = UsageQuerySchema.shape.period.safeParse(value);
        if (period.success) return formatUsageCalendarPeriod(period.data);
    }
    if (path === 'costBasis' && typeof value === 'string' && Object.hasOwn(COST_BASIS_KEYS, value)) {
        return t(COST_BASIS_KEYS[value as keyof typeof COST_BASIS_KEYS]);
    }
    if (path === 'session') {
        return typeof value === 'string' ? t('usage.board.page.slotSession')
            : t('usage.board.page.filterAllOf', { what: t('usage.board.page.dimensionSession').toLocaleLowerCase() });
    }
    if (Object.hasOwn(SCOPE_NOUN_KEYS, path) && Array.isArray(value)) {
        return value.length === 0
            ? t('usage.board.page.filterAllOf', { what: t(SCOPE_NOUN_KEYS[path as keyof typeof SCOPE_NOUN_KEYS]).toLocaleLowerCase() })
            : t('usage.board.page.filterCount', { count: value.length });
    }
    return t('widgetAdd.thisPage');
}

/** The binder re-resolves page-follow values on every read; this only names their source and value. */
export function usageWidgetSurfaceContext(providedContext: WidgetBindingResolutionInputV1['context'], period: UsagePeriod, sessionId?: string): WidgetSurfaceContext {
    return { slots: Object.fromEntries(
        USAGE_QUERY_INPUT_FIELDS.filter(field => field.contextMode === 'follow'
            && Object.hasOwn(providedContext, field.path)).map(field => {
            const values = providedContext[field.path];
            const value = values?.length === 1 ? values[0] : undefined;
            const label = field.path === 'session' && typeof value === 'string' ? t('usage.board.page.slotSession') : t('widgetAdd.thisPage');
            return [field.path, { label, value: values?.length === 1 ? { value: values[0]!, label: describeUsageWidgetSlotValue(field.path, value, period) } : null,
                // Saved page presets retain the admitted unfiltered Session scope for reads,
                // while the Account page offers no Session picker.
                ...(field.path === 'session' && sessionId === undefined ? { offered: false as const } : {}) }];
        }),
    ) };
}

export function resolveUsageWidgetPeriod(period: UsagePeriod, _nowMs: number, _timeZoneOffsetMinutes: number): Pick<UsageQuery, 'period' | 'granularity'> {
    return { period: { relative: period },
        granularity: getUsagePeriodDefinition(period).granularity };
}

/** The route supplies an already normalized, hydrated and admitted Session identity. */
export function resolveUsageWidgetPageInitialQuery(input: Readonly<{
    initialFilters?: UsageWidgetPageInitialFilters;
    sessionId?: string;
    nowMs: number;
    timeZoneOffsetMinutes: number;
}>): UsageQuery & Readonly<{ metric: UsageFilterState['metric'] }> {
    const filters = input.initialFilters;
    const metric = filters?.metric ?? 'tokens';
    // A Session's own page reads that Session over its whole life unless its route narrowed the period (a Work autopsy link).
    const period = filters?.period ?? resolveUsagePageDefaultPeriod(input.sessionId);
    const query = usageAnalyticsRequestToQuery({
        granularity: getUsagePeriodDefinition(period).granularity,
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
    }, { metric });
    return { ...UsageQuerySchema.parse({ ...query, ...resolveUsageWidgetPeriod(period, input.nowMs, input.timeZoneOffsetMinutes),
        ...filters?.queryOverrides, ...filters?.scope,
        ...(input.sessionId === undefined ? {} : { session: input.sessionId }) }), metric };
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
