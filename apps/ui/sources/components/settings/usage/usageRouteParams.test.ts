import { describe, expect, it } from 'vitest';
import { buildUsageRouteParams, resolveUsagePageInitialFilters } from './usageRouteParams';
import { applyUsageWidgetPageScope, readUsageWidgetPageContext, readUsageWidgetPageScope, resolveUsageWidgetPageInitialQuery,
    resolveUsageWidgetPeriod } from './usageWidgetPageContext';

describe('Usage route filter owner', () => {
    it('retains the exact query calendar and supported clauses through a scoped Session detail route', () => {
        const route = resolveUsagePageInitialFilters({ metric: 'cost', scope: JSON.stringify({ period: { startMs: 1000, endMs: 2000 }, costBasis: 'reported', session: 's1' }),
            queryOverrides: JSON.stringify({ timeZoneOffsetMinutes: -330, granularity: 'week', modelIds: ['specific-model'], workspaceIds: ['workspace'], backendModes: ['acp'], includeActivity: true }) });
        const query = resolveUsageWidgetPageInitialQuery({ initialFilters: route, sessionId: 's1', nowMs: Date.parse('2026-10-09T12:00:00Z'), timeZoneOffsetMinutes: 120 });
        expect(query).toMatchObject({ period: { startMs: 1000, endMs: 2000 }, session: 's1', costBasis: 'reported', metric: 'cost',
            timeZoneOffsetMinutes: -330, granularity: 'week', modelIds: ['specific-model'], workspaceIds: ['workspace'], backendModes: ['acp'], includeActivity: true });
        const roundtrip = resolveUsagePageInitialFilters(buildUsageRouteParams(route));
        expect(roundtrip).toEqual(route);
        expect(resolveUsagePageInitialFilters({ queryOverrides: JSON.stringify({ session: 'other', timeZoneOffsetMinutes: -330 }) })).not.toHaveProperty('queryOverrides');
    });
    it('preserves existing route initialization and rejects malformed scope', () => {
        expect(resolveUsagePageInitialFilters({ period: ['today', 'year'], metric: 'cost', costMode: 'reported', scope: '{broken' })).toEqual({
            period: 'today', metric: 'cost', costMode: 'reported', focus: null,
        });
    });

    it('roundtrips independently selected scope fields without turning metric into page context', () => {
        const scope = { period: { startMs: 1000, endMs: 2000 }, agents: ['codex'], machines: ['machine-a'],
            projects: ['opaque-project'], sources: ['native'], session: null, costBasis: 'estimated' as const };
        const filters = { period: '7days' as const, metric: 'cost' as const, costMode: 'estimated' as const,
            focus: null, scope, layoutId: 'my-view' };
        const params = buildUsageRouteParams(filters);
        const parsed = resolveUsagePageInitialFilters(params);
        expect(parsed).toEqual(filters);
        expect(JSON.parse(params.scope!)).not.toHaveProperty('metric');
        expect(JSON.parse(params.scope!)).not.toHaveProperty('breakdown');
    });

    it('roundtrips explicit unfiltered arrays and the absent Session value', () => {
        const scope = { period: {}, agents: [], machines: [], projects: [], sources: [], session: null, costBasis: 'auto' as const };
        expect(resolveUsagePageInitialFilters(buildUsageRouteParams({ scope })).scope).toEqual(scope);
    });

    it('uses admitted Session scalar and cannot widen it through route or filter input', () => {
        const query = resolveUsageWidgetPageInitialQuery({ sessionId: 'admitted-session', nowMs: Date.parse('2026-10-09T12:00:00Z'),
            timeZoneOffsetMinutes: 120, initialFilters: resolveUsagePageInitialFilters({ metric: 'cost',
                scope: JSON.stringify({ session: 'other-session' }) }) });
        expect(query.session).toBe('admitted-session');
        expect(query.metric).toBe('cost');
        const next = applyUsageWidgetPageScope(query, { session: null, machines: ['machine-a'], costBasis: 'reported' }, 'admitted-session');
        expect(next.session).toBe('admitted-session');
        expect(next.machines).toEqual(['machine-a']);
        expect(next.costBasis).toBe('reported');
        expect(next.metric).toBe('cost');
    });

    it('offers every unfiltered scope as a value while presentation stays widget owned', () => {
        const query = resolveUsageWidgetPageInitialQuery({ nowMs: Date.parse('2026-10-09T12:00:00Z'), timeZoneOffsetMinutes: 120 });
        expect(readUsageWidgetPageContext(readUsageWidgetPageScope(query))).toEqual({ period: [query.period], agents: [[]], machines: [[]],
            projects: [[]], sources: [[]], session: [null], costBasis: ['auto'] });
        const today = resolveUsageWidgetPeriod('today', Date.parse('2026-10-09T00:30:00Z'), 120);
        expect(today).toEqual({ period: { startMs: Date.parse('2026-10-08T22:00:00Z') }, granularity: 'hour' });
        expect(resolveUsageWidgetPeriod('year', Date.parse('2026-10-09T12:00:00Z'), 120).granularity).toBe('month');
    });

    it('requests the real series, rhythm, insights and model timeline facts consumed by the widget inventory', () => {
        const query = resolveUsageWidgetPageInitialQuery({ nowMs: Date.parse('2026-10-09T12:00:00Z'), timeZoneOffsetMinutes: 120 });
        expect(query).toMatchObject({ includeSeries: true, includeInsights: true, includeActivity: true, includeLeaders: true,
            includeModelTimeline: true, includeMessageStats: true, activityResolution: 'both' });
    });
});
