import * as React from 'react';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { UsageQuerySchema, getUsageQueryKey, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useOptionalCurrentUiContextReader, usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import type { CurrentUiContextMountedEnrichment, CurrentUiContextMountedCommand } from '@/components/appShell/currentUiContext/currentUiContextModel';
import { executeMountedCurrentUiContextCommand } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useCurrentUiContextComposedCommands, useCurrentUiContextLocalCommandDefinitions } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { USAGE_PERIODS, getUsagePeriodDefinition, type UsagePeriod } from '@/sync/api/account/usagePeriods';
import { t } from '@/text';
import type { UsageHistoryModel } from './useUsageHistory';
import { describeUsageHistoryRead } from './widgets/usageBodyKit';
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
    callerContext?: ActionExecutorContext;
    callerQuery?: UsageQuery;
    isCurrent: boolean;
    setScope(patch: Partial<UsageWidgetPageScope>, callerContext?: ActionExecutorContext): boolean;
    setPeriod(period: UsagePeriod, callerContext?: ActionExecutorContext): boolean;
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
        callerContext: undefined as ActionExecutorContext | undefined,
    });
    const [state, setState] = React.useState(initialize);
    const isCurrent = input.active !== false && state.authority === input.authority && !state.retired
        && state.sessionId === input.sessionId && state.initialKey === initialKey && input.authority?.isCurrent() === true;
    const canChange = React.useCallback(() => input.active !== false && input.authority?.isCurrent() === true,
        [input.active, input.authority]);

    // Reconcile route intent before children commit. A URL echo of page-owned filters
    // must not commit an inactive publication and retire otherwise unchanged commands.
    if (state.authority !== input.authority || state.sessionId !== input.sessionId || state.initialKey !== initialKey) {
        const next = initialize();
        const echoesSelection = state.authority === input.authority && state.sessionId === input.sessionId
            && state.period === next.period && getUsageQueryKey(state.query) === getUsageQueryKey(next.query);
        setState(echoesSelection ? { ...state, initialKey } : next);
    }
    React.useLayoutEffect(() => {
        const authority = input.authority;
        if (!authority) return;
        const subscription = authority.onRetire(() => setState(current => current.authority === authority && !current.retired
            ? { ...current, retired: true } : current));
        return () => subscription.dispose();
    }, [input.authority]);

    const setScope = React.useCallback((patch: Partial<UsageWidgetPageScope>, callerContext?: ActionExecutorContext): boolean => {
        if (!canChange()) return false;
        setState(current => {
            if (!canChange() || current.authority !== input.authority || current.retired
                || current.sessionId !== input.sessionId || current.initialKey !== initialKey) return current;
            const query = { ...applyUsageWidgetPageScope(current.query, patch, input.sessionId), metric: current.query.metric };
            return getUsageQueryKey(query) === getUsageQueryKey(current.query) ? current : { ...current, query, callerContext, edited: true };
        });
        return true;
    }, [canChange, input.authority, input.sessionId, initialKey]);
    const setPeriod = React.useCallback((period: UsagePeriod, callerContext?: ActionExecutorContext): boolean => {
        if (!canChange()) return false;
        setState(current => {
            if (!canChange() || current.authority !== input.authority || current.retired
                || current.sessionId !== input.sessionId || current.initialKey !== initialKey) return current;
            const query = { ...UsageQuerySchema.parse({ ...current.query,
                ...resolveUsageWidgetPeriod(period, input.nowMs ?? Date.now(), current.query.timeZoneOffsetMinutes) }), metric: current.query.metric };
            return current.period === period && getUsageQueryKey(query) === getUsageQueryKey(current.query)
                ? current : { ...current, query, period, callerContext, edited: true };
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
        callerContext: state.callerContext, callerQuery: state.callerContext ? state.query : undefined, isCurrent, setScope, setPeriod };
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
    selectLayout?: (layoutId: string, callerContext?: ActionExecutorContext) => boolean | Promise<boolean>;
    retryRead?: (callerContext?: ActionExecutorContext) => void | Promise<unknown>;
    retryLayouts?: (callerContext?: ActionExecutorContext) => Promise<unknown>;
    filterCommands?: readonly Readonly<{ field: string; id: string; title: string; invoke(callerContext?: ActionExecutorContext): boolean | Promise<boolean> }>[];
    /** The shown wide window's history read (`useUsageHistory`); its Read now and Cancel are page commands. */
    history?: UsageHistoryModel | null;
}>;

/**
 * The history read's one header fact. Sessions not read yet and a running read carry their control (Read now,
 * Cancel); Sessions that stay unreadable are quiet partial coverage with no control beside them.
 */
export type UsagePageHistoryFact = Readonly<{ text: string; failed: boolean; label?: string; accessibilityLabel?: string; onPress?(): void }>;

function pageCommandKey(kind: string, ...ids: string[]): string {
    return JSON.stringify([kind, ...ids]);
}

/** Called after the area binding, so its inventory/selection stays at the platform owner. */
export function usePublishUsageWidgetPageContext(input: UsageWidgetPagePublicationInput): Readonly<{
    selectLayout(layoutId: string, signal?: AbortSignal): Promise<boolean>;
    selectPeriod(period: UsagePeriod): Promise<boolean>;
    selectCostBasis(costBasis: UsageWidgetPageScope['costBasis'], callerContext?: ActionExecutorContext): Promise<boolean>;
    selectFilter(field: string, id: string, callerContext?: ActionExecutorContext): Promise<boolean>;
    retryRead(): Promise<boolean>;
    retryLayouts(): Promise<boolean>;
    /** The history read's one fact and control for the page header; null once every Session was read. */
    history: UsagePageHistoryFact | null;
}> {
    const { page } = input;
    const descendantCommands = useCurrentUiContextComposedCommands();
    const reader = useOptionalCurrentUiContextReader();
    const { execute } = useMountedActionExecution(input.authority?.scope);
    const latest = React.useRef(input);
    latest.current = input;
    const mounted = React.useRef(true);
    React.useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const canChange = React.useCallback(() => mounted.current && latest.current.active !== false && latest.current.page.isCurrent
        && latest.current.authority === input.authority && input.authority?.isCurrent() === true,
        [input.authority]);
    const applyLayout = React.useCallback(async (layoutId: string, signal?: AbortSignal, callerContext?: ActionExecutorContext): Promise<boolean> => {
        const current = latest.current;
        if (!canChange() || signal?.aborted || !current.selectLayout || !current.layouts?.some(layout => layout.id === layoutId)) return false;
        // The selection owner admits the effect and acknowledges its outcome.
        // That effect may retire this publication; keep its known settlement.
        return await current.selectLayout(layoutId, callerContext);
    }, [canChange]);

    const describedHistory = describeUsageHistoryRead(input.history?.state ?? null);
    // A page read that failed is said once with one Retry; that Retry rereads the unreadable Sessions too.
    const historyAbsorbed = describedHistory?.failed === true && input.retryRead !== undefined;
    const historyRead = historyAbsorbed ? null : describedHistory;
    const historyTitle = historyRead ? t(historyRead.operation === 'cancel' ? 'usage.board.page.historyCancelCommand' : 'usage.board.page.historyReadCommand') : null;
    const runHistory = React.useCallback((operation: 'read' | 'cancel', callerContext?: ActionExecutorContext): boolean => {
        const history = latest.current.history;
        if (!canChange() || !history) return false;
        // The read lasts as long as the window's history needs. Its progress and settlement are the
        // history state the page shows, so the command returns once started instead of holding its caller.
        void (operation === 'cancel' ? history.cancel(callerContext) : history.readNow(callerContext)).catch(() => {});
        return true;
    }, [canChange]);

    const definitions = useCurrentUiContextLocalCommandDefinitions([
        ...USAGE_PERIODS.map(period => ({ key: pageCommandKey('period', period),
            title: t(getUsagePeriodDefinition(period).translationKey), invoke: (_input?: unknown, context?: ActionExecutorContext) => page.setPeriod(period, context) })),
        ...input.costBasisOptions.map(costBasis => ({ key: pageCommandKey('cost', costBasis),
            title: describeUsageWidgetSlotValue('costBasis', costBasis, page.period), invoke: (_input?: unknown, context?: ActionExecutorContext) => page.setScope({ costBasis }, context) })),
        ...(input.filterCommands ?? []).map(({ field, id, title, invoke }) => ({ key: pageCommandKey('filter', field, id), title, invoke: (_input?: unknown, context?: ActionExecutorContext) => invoke(context) })),
        ...(input.layouts ?? []).map(layout => ({ key: pageCommandKey('layout', layout.id), title: layout.name, invoke: (_input?: unknown, context?: ActionExecutorContext) => applyLayout(layout.id, context?.signal, context) })),
        ...(input.retryRead ? [{ key: pageCommandKey('retry', 'read'), title: t('usage.board.page.retryRead'),
            invoke: async (_input?: unknown, context?: ActionExecutorContext) => {
                // One Retry for everything the page could not read: the shared reads, the Sessions and the views.
                const current = latest.current;
                if (historyAbsorbed) runHistory('read', context);
                await Promise.all([current.retryRead?.(context), current.retryLayouts?.(context)]);
                return true;
            } }] : []),
        ...(historyRead && historyTitle ? [{ key: pageCommandKey('history', historyRead.operation), title: historyTitle,
            invoke: (_input?: unknown, context?: ActionExecutorContext) => runHistory(historyRead.operation, context) }] : []),
        ...(input.retryLayouts && !input.retryRead ? [{ key: pageCommandKey('retry', 'layouts'), title: `${t('usage.board.page.viewsLabel')}: ${t('common.retry')}`,
            invoke: async (_input?: unknown, context?: ActionExecutorContext) => { await input.retryLayouts!(context); return true; } }] : []),
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
    const invoke = React.useCallback(async (command: CurrentUiContextMountedCommand | undefined, callerContext?: ActionExecutorContext): Promise<boolean> => {
        if (!canChange()) return false;
        return (await executeMountedCurrentUiContextCommand({ reader, command,
            execute: (actionId, value) => execute(actionId, value, callerContext ? { callerContext } : undefined) })).ok;
    }, [canChange, execute, reader]);
    // Menus close before invoking their queued callback. Resolve its semantic intent
    // from the committed publication, never the retired descriptor captured at close.
    // The current-context owner retires commands when their declaration or authority changes.
    const selectLayout = React.useCallback((id: string, signal?: AbortSignal) => signal?.aborted ? Promise.resolve(false)
        : invoke(currentPublication.current?.definitions.find(row => row.key === pageCommandKey('layout', id))?.command), [invoke]);
    const selectPeriod = React.useCallback((id: UsagePeriod) => invoke(currentPublication.current?.definitions.find(row => row.key === pageCommandKey('period', id))?.command), [invoke]);
    const selectCostBasis = React.useCallback((id: UsageWidgetPageScope['costBasis'], context?: ActionExecutorContext) => invoke(currentPublication.current?.definitions.find(row => row.key === pageCommandKey('cost', id))?.command, context), [invoke]);
    const selectFilter = React.useCallback((field: string, id: string, context?: ActionExecutorContext) => invoke(currentPublication.current?.definitions.find(row => row.key === pageCommandKey('filter', field, id))?.command, context), [invoke]);
    const retryRead = React.useCallback(() => invoke(currentPublication.current?.definitions.find(row => row.key === pageCommandKey('retry', 'read'))?.command), [invoke]);
    const retryLayouts = React.useCallback(() => invoke(currentPublication.current?.definitions.find(row => row.key === pageCommandKey('retry', 'layouts'))?.command), [invoke]);
    const historyOperation = historyRead?.operation;
    const history = React.useMemo((): UsagePageHistoryFact | null => !historyRead || !historyTitle || !historyOperation ? null
        : {
        text: historyRead.text, label: historyRead.label, accessibilityLabel: historyTitle, failed: historyRead.failed,
        // The header's control runs the published command, never a second path to the Action.
        onPress: () => { void invoke(currentPublication.current?.definitions.find(row => row.key === pageCommandKey('history', historyOperation))?.command); },
    }, [historyRead?.text, historyRead?.label, historyRead?.failed, historyTitle, historyOperation, invoke]);
    return { selectLayout, selectPeriod, selectCostBasis, selectFilter, retryRead, retryLayouts, history };
}
