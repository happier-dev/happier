import * as React from 'react';
import { UsageQuerySchema, getUsageQueryKey, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useOptionalCurrentUiContextReader, usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import type { CurrentUiContextMountedEnrichment, CurrentUiContextMountedCommand } from '@/components/appShell/currentUiContext/currentUiContextModel';
import { executeMountedCurrentUiContextCommand } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useCurrentUiContextComposedCommands, useCurrentUiContextLocalCommandDefinitions } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { USAGE_PERIODS, getUsagePeriodDefinition, type UsagePeriod } from '@/sync/api/account/usagePeriods';
import { t } from '@/text';
import { applyUsageWidgetPageScope, describeUsageWidgetSlotValue, readUsageWidgetPageContext, readUsageWidgetPageScope, readUsageWidgetQueryOverrides, resolveUsageWidgetPageInitialQuery,
    resolveUsageWidgetPeriod, type UsageWidgetPageInitialFilters, type UsageWidgetPageScope, type UsageWidgetQueryOverrides } from './usageWidgetPageContext';

export type UsageWidgetPageContextInput = Readonly<{
    authority: ServerAccountScopeLifetime | null;
    initialFilters?: UsageWidgetPageInitialFilters;
    /** Comes from the existing Session route's successful scope/hydration admission. */
    sessionId?: string;
    active?: boolean;
    nowMs?: number;
    timeZoneOffsetMinutes?: number;
    onFiltersChange?: (filters: UsageWidgetPageInitialFilters) => void;
}>;

export type UsageWidgetPageContextState = Readonly<{
    scope: UsageWidgetPageScope;
    providedContext: ReturnType<typeof readUsageWidgetPageContext>;
    queryOverrides: UsageWidgetQueryOverrides;
    initialMetric: UsageQuery['metric'];
    /** Route intent only; the area binding remains the selected-layout owner. */
    initialLayoutId: string | null;
    period: UsagePeriod;
    isCurrent: boolean;
    setScope(patch: Partial<UsageWidgetPageScope>): boolean;
    setPeriod(period: UsagePeriod): boolean;
}>;

/** One page filter state; widgets keep presentation inputs and area owns layout selection. */
export function useUsageWidgetPageContext(input: UsageWidgetPageContextInput): UsageWidgetPageContextState {
    // Named-layout navigation belongs to the area and must not restart the page's period.
    const initialKey = JSON.stringify(input.initialFilters ? { ...input.initialFilters, layoutId: undefined } : null);
    const initialize = () => ({
        authority: input.authority,
        initialKey,
        sessionId: input.sessionId,
        query: resolveUsageWidgetPageInitialQuery({ initialFilters: input.initialFilters, sessionId: input.sessionId,
            nowMs: input.nowMs ?? Date.now(), timeZoneOffsetMinutes: input.timeZoneOffsetMinutes ?? -new Date().getTimezoneOffset() }),
        period: input.initialFilters?.period ?? '7days' as UsagePeriod,
        edited: false,
        retired: false,
    });
    const [state, setState] = React.useState(initialize);
    const isCurrent = input.active !== false && state.authority === input.authority && !state.retired
        && state.sessionId === input.sessionId && state.initialKey === initialKey && input.authority?.isCurrent() === true;
    const canChange = React.useCallback(() => input.active !== false && input.authority?.isCurrent() === true,
        [input.active, input.authority]);

    // Reconcile route intent before children commit. A URL echo of page-owned filters
    // must not commit an inactive publication and retire otherwise unchanged commands.
    if (state.authority !== input.authority || state.sessionId !== input.sessionId || state.initialKey !== initialKey) {
        setState(initialize());
    }
    React.useLayoutEffect(() => {
        const authority = input.authority;
        if (!authority) return;
        const subscription = authority.onRetire(() => setState(current => current.authority === authority && !current.retired
            ? { ...current, retired: true } : current));
        return () => subscription.dispose();
    }, [input.authority]);

    const setScope = React.useCallback((patch: Partial<UsageWidgetPageScope>): boolean => {
        if (!canChange()) return false;
        setState(current => {
            if (!canChange() || current.authority !== input.authority || current.retired
                || current.sessionId !== input.sessionId || current.initialKey !== initialKey) return current;
            const query = { ...applyUsageWidgetPageScope(current.query, patch, input.sessionId), metric: current.query.metric };
            return getUsageQueryKey(query) === getUsageQueryKey(current.query) ? current : { ...current, query, edited: true };
        });
        return true;
    }, [canChange, input.authority, input.sessionId, initialKey]);
    const setPeriod = React.useCallback((period: UsagePeriod): boolean => {
        if (!canChange()) return false;
        setState(current => {
            if (!canChange() || current.authority !== input.authority || current.retired
                || current.sessionId !== input.sessionId || current.initialKey !== initialKey) return current;
            const query = { ...UsageQuerySchema.parse({ ...current.query,
                ...resolveUsageWidgetPeriod(period, input.nowMs ?? Date.now(), current.query.timeZoneOffsetMinutes) }), metric: current.query.metric };
            return current.period === period && getUsageQueryKey(query) === getUsageQueryKey(current.query)
                ? current : { ...current, query, period, edited: true };
        });
        return true;
    }, [canChange, input.authority, input.nowMs, input.sessionId, initialKey]);
    const scope = React.useMemo(() => readUsageWidgetPageScope(state.query), [state.query]);
    const providedContext = React.useMemo(() => isCurrent ? readUsageWidgetPageContext(scope) : {}, [isCurrent, scope]);
    const queryOverrides = React.useMemo<UsageWidgetQueryOverrides>(() => readUsageWidgetQueryOverrides(state.query), [state.query]);
    const onFiltersChange = React.useRef(input.onFiltersChange);
    React.useLayoutEffect(() => { onFiltersChange.current = input.onFiltersChange; }, [input.onFiltersChange]);
    React.useEffect(() => {
        if (isCurrent && state.edited) onFiltersChange.current?.({ period: state.period, metric: state.query.metric,
            costMode: scope.costBasis, focus: null, scope, queryOverrides });
    }, [isCurrent, state.edited, state.period, state.query.metric, scope, queryOverrides]);

    return { scope, providedContext, queryOverrides, initialMetric: state.query.metric,
        initialLayoutId: input.initialFilters?.layoutId ?? null, period: state.period,
        isCurrent, setScope, setPeriod };
}

export type UsageWidgetPagePublicationInput = Readonly<{
    page: UsageWidgetPageContextState;
    authority: ServerAccountScopeLifetime | null;
    active?: boolean;
    layoutId?: string;
    layouts?: readonly Readonly<{ id: string; name: string }>[];
    /** Incumbent analytics availability; an unknown inventory is supplied as []. */
    costBasisOptions: readonly UsageWidgetPageScope['costBasis'][];
    /** The existing area Action has no cancellation port; true means acknowledged success. */
    selectLayout?: (layoutId: string) => boolean | Promise<boolean>;
    filterCommands?: readonly Readonly<{ field: string; id: string; title: string; invoke(): boolean | Promise<boolean> }>[];
}>;

function pageCommandKey(kind: string, ...ids: string[]): string {
    return JSON.stringify([kind, ...ids]);
}

/** Called after the area binding, so its inventory/selection stays at the platform owner. */
export function usePublishUsageWidgetPageContext(input: UsageWidgetPagePublicationInput): Readonly<{
    selectLayout(layoutId: string, signal?: AbortSignal): Promise<boolean>;
    selectPeriod(period: UsagePeriod): Promise<boolean>;
    selectCostBasis(costBasis: UsageWidgetPageScope['costBasis']): Promise<boolean>;
    selectFilter(field: string, id: string): Promise<boolean>;
}> {
    const { page } = input;
    const descendantCommands = useCurrentUiContextComposedCommands();
    const reader = useOptionalCurrentUiContextReader();
    const { execute } = useMountedActionExecution(input.authority?.scope, { openOnRequest: true });
    const latest = React.useRef(input);
    latest.current = input;
    const mounted = React.useRef(true);
    React.useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const canChange = React.useCallback(() => mounted.current && latest.current.active !== false && latest.current.page.isCurrent
        && latest.current.authority === input.authority && input.authority?.isCurrent() === true,
        [input.authority]);
    const applyLayout = React.useCallback(async (layoutId: string, signal?: AbortSignal): Promise<boolean> => {
        const current = latest.current;
        if (!canChange() || signal?.aborted || !current.selectLayout || !current.layouts?.some(layout => layout.id === layoutId)) return false;
        const selected = await current.selectLayout(layoutId);
        // Selection can itself retire its published descriptor. Its known
        // success survives that republish, but never a Home/Account retirement.
        if (!selected || !canChange()) return false;
        return true;
    }, [canChange]);

    const definitions = useCurrentUiContextLocalCommandDefinitions([
        ...USAGE_PERIODS.map(period => ({ key: pageCommandKey('period', period),
            title: t(getUsagePeriodDefinition(period).translationKey), invoke: () => page.setPeriod(period) })),
        ...input.costBasisOptions.map(costBasis => ({ key: pageCommandKey('cost', costBasis),
            title: describeUsageWidgetSlotValue('costBasis', costBasis, page.period), invoke: () => page.setScope({ costBasis }) })),
        ...(input.filterCommands ?? []).map(({ field, id, title, invoke }) => ({ key: pageCommandKey('filter', field, id), title, invoke })),
        ...(input.layouts ?? []).map(layout => ({ key: pageCommandKey('layout', layout.id), title: layout.name, invoke: () => applyLayout(layout.id) })),
    ], canChange);
    const publication = React.useMemo(() => {
        if (!canChange()) return null;
        const enrichment: CurrentUiContextMountedEnrichment = {
            entity: { kind: 'usage_summary', label: t('usage.summary.title'), summary: t(getUsagePeriodDefinition(page.period).translationKey) },
            detail: JSON.stringify({ scope: page.scope, layoutId: input.layoutId ?? null }),
            commands: [...definitions, ...descendantCommands],
        };
        return { enrichment, definitions };
    }, [canChange, input.active, page.isCurrent, page.period, page.scope, input.layoutId, definitions, descendantCommands]);
    usePublishCurrentUiContext(publication?.enrichment ?? null);
    const currentPublication = React.useRef(publication);
    React.useLayoutEffect(() => { currentPublication.current = publication; }, [publication]);
    const invoke = React.useCallback(async (command: CurrentUiContextMountedCommand | undefined): Promise<boolean> => {
        if (!canChange()) return false;
        return (await executeMountedCurrentUiContextCommand({ reader, command, execute })).ok;
    }, [canChange, execute, reader]);
    // Menus close before invoking their queued callback. Resolve its semantic intent
    // from the committed publication, never the retired descriptor captured at close.
    // The current-context owner retires commands when their declaration or authority changes.
    const selectLayout = React.useCallback((id: string, signal?: AbortSignal) => signal?.aborted ? Promise.resolve(false)
        : invoke(currentPublication.current?.definitions.find(row => row.key === pageCommandKey('layout', id))?.command), [invoke]);
    const selectPeriod = React.useCallback((id: UsagePeriod) => invoke(currentPublication.current?.definitions.find(row => row.key === pageCommandKey('period', id))?.command), [invoke]);
    const selectCostBasis = React.useCallback((id: UsageWidgetPageScope['costBasis']) => invoke(currentPublication.current?.definitions.find(row => row.key === pageCommandKey('cost', id))?.command), [invoke]);
    const selectFilter = React.useCallback((field: string, id: string) => invoke(currentPublication.current?.definitions.find(row => row.key === pageCommandKey('filter', field, id))?.command), [invoke]);
    return { selectLayout, selectPeriod, selectCostBasis, selectFilter };
}
