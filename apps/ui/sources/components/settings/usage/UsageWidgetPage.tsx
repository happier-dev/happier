import * as React from 'react';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  flattenWidgetLayoutWidgetsV1,
} from '@happier-dev/protocol/widgets';
import { HAPPIER_PAGE_METRICS, HAPPIER_PAGE_TEXT } from '@happier-dev/plugin-ui/presentation';
import { HomeReachabilityGate, useActiveHomeUnavailable } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { PluginUiScrollActivityProvider } from '@happier-dev/plugin-ui/advanced';
import { HappierUiTypographyProvider } from '@happier-dev/plugin-ui/environment';
import { readPluginUiHostTypography } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { CurrentUiContextCommandsProvider, type CurrentUiContextCommandInvocation } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { publishPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import {
  PageHeader,
  type PageHeaderMetaFact,
} from '@/components/ui/layout/PageHeader';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { useDeviceType } from '@/utils/platform/responsive';
import { SurfaceFreshnessLine, SurfaceFreshnessOnSheetProvider } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import type { IconName } from '@/components/ui/icons/Icon';
import { WidgetArea } from '@/components/widgets/area/WidgetArea';
import { createScrollViewNearViewportTracker } from '@/components/widgets/nearViewport';
import { WidgetAreaPresetLine } from '@/components/widgets/area/WidgetAreaPresetLine';
import {
  useWidgetAreaLayout,
  type WidgetAreaPort,
} from '@/components/widgets/area/useWidgetAreaLayout';
import { widgetProvidedContext, type WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import {
  WidgetAreaLayoutBar,
  type WidgetAreaLayoutLabels,
} from '@/components/widgets/area/WidgetAreaLayoutBar';
import { useCorePageWidgetAreaLayoutBar } from '@/components/widgets/area/useCorePageWidgetAreaLayoutBar';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { formatUsageObservedAt, isUsageObservationFromEarlierDay } from '@/sync/domains/usage/usageCalendarPresentation';
import { t } from '@/text';
import { UsageFilterBar, usageTokensCostMetricOptions } from './UsageFilterBar';
import { useUsageWidgetPageFilters } from './useUsageWidgetPageFilters';
import { useUsageAppEnvironments } from './useUsageAppEnvironments';
import { readUsageAppCallsEnvironmentIds } from '@/sync/domains/usage/usageAppCallsSource';
import { UsageAppsNothingRecorded } from './UsageAppsNothingRecorded';
import { UsageDrillProvider, usageDrillFromPageFilters } from './usageDrill';
import { SessionRetentionNotice } from '@/components/sessions/info/SessionRetentionNotice';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import {
  USAGE_SESSION_WIDGET_PRESET_ID,
  USAGE_WIDGET_PRESET_IDS,
  type UsageWidgetPresetId,
} from './usageWidgetPresets';
import { useUsageWidgetAreaBinding } from './useUsageWidgetAreaBinding';
import { resolveUsagePresetLine } from './usagePresetLine';
import {
  usePublishUsageWidgetPageContext,
  useUsageWidgetPageContext,
  type UsageWidgetPageContextState,
} from './useUsageWidgetPageContext';
import {
  buildUsageWidgetPageInventoryQuery,
  type UsageWidgetPageInitialFilters,
  type UsageWidgetQueryOverrides,
} from './usageWidgetPageContext';
import { setUsageWidgetMetric, usageWidgetAcceptsMetric } from './usageWidgetActions';
import {
  UsageWidgetBatchProvider,
  isUsageQueryWidget,
  useUsageWidgetPageRetry,
  readUsagePageNothingRecorded,
  useUsageWidgetBatchSelection,
  useUsageWidgetBatchInventorySelection,
  useUsageWidgetBatchCostBasis,
  useUsageWidgetBatchHistory,
} from './widgets/usageWidgetBatch';
import { useOpenNewSession } from '@/components/sessions/new/navigation/newSessionEntry';
import type { UsagePageHistoryFact } from './useUsageWidgetPageContext';
import { describeUsagePageFailedSources, isUsagePageFailureOnlyWork, describeUsagePageNewerServerSources, describeUsagePagePartialSources, describeUsagePagePendingSources, readUsageCoverageGaps, readUsagePageFreshness, readUsagePageWorkOffline, usageSourceTitle } from './widgets/usageBodyKit';

const PRESET_ICON: Readonly<Record<UsageWidgetPresetId, IconName>> = {
  overview: 'squares-four',
  costs: 'currency-dollar',
  work: 'git-pull-request',
  usage: 'list-bullets',
  plans: 'speedometer',
  coach: 'sparkle',
  'how-you-work': 'clock',
  sources: 'stack',
  agents: 'robot',
};
const PRESET_NAME_KEYS = {
  overview: 'usage.presets.overview',
  costs: 'usage.presets.costs',
  work: 'usage.presets.work',
  usage: 'usage.presets.usage',
  plans: 'usage.presets.plans',
  coach: 'usage.presets.coach',
  'how-you-work': 'usage.presets.how-you-work',
  sources: 'usage.presets.sources',
  agents: 'usage.presets.agents',
} as const satisfies Record<UsageWidgetPresetId, string>;
export type UsageWidgetPageProps = Readonly<{
  /** Supplied only by the Session route after its own scope/hydration admission. */
  sessionId?: string;
  initialFilters?: UsageWidgetPageInitialFilters;
  onFiltersChange?: (filters: UsageWidgetPageInitialFilters) => void;
  contentBottomInset?: number;
  /** The route records the selected view so a reload reopens it; the area stays the selection owner. */
  onLayoutChange?: (layoutId: string) => void;
}>;

/**
 * The Usage page (lab `d2top`/`d2views`/`d2filter`): one personal core-page widget area with eight
 * host views and the viewer's own, the page's filter bar, and every widget reading one batched
 * `usage.query`. Layout, selection, Reset/Undo and views belong to the area owner.
 */
export function UsageWidgetPage(
  props: UsageWidgetPageProps,
): React.ReactElement {
  const { theme } = useUnistyles();
  const scrollRef = React.useRef<ScrollView | null>(null);
  const [scrollTracker] = React.useState(() => createScrollViewNearViewportTracker(scrollRef, false, { initialViewportHeight: 0 }));
  const viewer = useActiveServerAccountScope();
  const authority = React.useMemo(
    () => captureActiveServerAccountScopeLifetime(),
    [viewer?.serverId, viewer?.accountId],
  );
  const page = useUsageWidgetPageContext({
    authority,
    initialFilters: props.initialFilters,
    sessionId: props.sessionId,
    onFiltersChange: props.onFiltersChange,
  });
  const names = React.useMemo(
    () =>
      Object.fromEntries(
        USAGE_WIDGET_PRESET_IDS.map((id) => [id, t(PRESET_NAME_KEYS[id])]),
      ) as Record<UsageWidgetPresetId, string>,
    [],
  );
  const binding = useUsageWidgetAreaBinding({
    serverId: viewer?.serverId ?? '',
    providedContext: page.providedContext,
    sessionId: props.sessionId,
    period: page.period,
    names,
    initialMetric: page.initialMetric,
    initialLayoutId: page.initialLayoutId,
    onLayoutChange: props.onLayoutChange,
  });
  // Usage is a dashboard's card grid, so it takes the page's dashboard column: the filter bar holds one
  // row beside the sidebar at 1440 and the two-column groups keep their room at 1920+ (lab d2views, wgusage-CD).
  const wideColumn = useLayoutMaxWidth('dashboard');
  const contentMaxWidth = React.useMemo(() => ({ maxWidth: wideColumn }), [wideColumn]);
  // Non-follow clauses travel with the same host context that the area admits for widget inputs.
  // widgetProvidedContext projects only slots/session to the Action boundary.
  const context = React.useMemo(() => ({ ...binding.context, queryOverrides: page.queryOverrides }),
    [binding.context, page.queryOverrides]);
  return (
    <PluginSurfaceFocusEligibilityProvider
      active
      currentUiContextActive
    >
      <CurrentUiContextCommandsProvider authority={authority} active={page.isCurrent}>
      <PluginUiScrollActivityProvider tracker={scrollTracker}>
      {/* The page's shared data and chart text (SVG labels too) draws in the app's own face, not the browser default. */}
      <HappierUiTypographyProvider typography={readPluginUiHostTypography(theme)}>
      <ScrollView
        ref={scrollRef}
        onScroll={scrollTracker.onScroll}
        onLayout={scrollTracker.onLayout}
        onContentSizeChange={scrollTracker.onContentSizeChange}
        scrollEventThrottle={16}
        style={styles.screen}
        contentContainerStyle={[
          styles.content,
          props.contentBottomInset
            ? { paddingBottom: 32 + props.contentBottomInset }
            : null,
        ]}
        testID="usage-page"
      >
        <View style={[styles.column, contentMaxWidth]}>
            {binding.port ? (
              <UsagePageDocument
                port={binding.port}
                context={context}
                binding={binding}
                page={page}
                names={names}
                sessionId={props.sessionId}
                authority={authority}
              />
            ) : (
              <>
                <UsagePageHeader facts={readUsagePageFacts([], false).facts} retry={null} />
                <WidgetArea
                  port={null}
                  context={binding.context}
                  geometry="grid"
                  title={t('usage.board.page.title')}
                  surfaceName={t('usage.board.page.title')}
                  testID="usage-area"
                />
              </>
            )}
        </View>
      </ScrollView>
      </HappierUiTypographyProvider>
      </PluginUiScrollActivityProvider>
      </CurrentUiContextCommandsProvider>
    </PluginSurfaceFocusEligibilityProvider>
  );
}

type UsageAreaBinding = ReturnType<typeof useUsageWidgetAreaBinding>;

type UsagePageDocumentProps = Readonly<{
    port: WidgetAreaPort;
    context: WidgetSurfaceContext & Readonly<{ queryOverrides: UsageWidgetQueryOverrides }>;
    binding: UsageAreaBinding;
    page: UsageWidgetPageContextState;
    names: Readonly<Record<UsageWidgetPresetId, string>>;
    sessionId?: string;
    authority: ReturnType<typeof captureActiveServerAccountScopeLifetime>;
}>;

function UsagePageDocument(props: UsagePageDocumentProps) {
  const layout = useWidgetAreaLayout(props.port, props.context);
  const admittedContext = layout.state.status === 'ready' ? layout.state.context : null;
  const inventoryQuery = React.useMemo(() => admittedContext
    ? buildUsageWidgetPageInventoryQuery(admittedContext.queryOverrides, widgetProvidedContext(admittedContext))
    : undefined, [admittedContext]);
  const queryWidgetIds = layout.state.status === 'ready' ? flattenWidgetLayoutWidgetsV1(layout.state.items)
    .filter(row => row.instance.definition.kind === 'builtin' && isUsageQueryWidget(row.instance.definition.id))
    .map(row => row.instance.id) : undefined;
  const inventoryOnly = queryWidgetIds?.length === 0;
  // The pending context still renders the admitted layout. Its cached batch must
  // not consume the new selection's caller before that context is admitted.
  const callerContext = admittedContext === props.context ? props.page.callerContext : undefined;
  return <UsageWidgetBatchProvider enabled={layout.state.status === 'ready'} clauses={admittedContext?.queryOverrides ?? props.context.queryOverrides} inventoryQuery={inventoryQuery} inventoryOnly={inventoryOnly} callerContext={callerContext} callerQuery={callerContext ? props.page.callerQuery : undefined}
    queryWidgetIds={queryWidgetIds}>
    <UsagePageDocumentContent {...props} layout={layout} />
  </UsageWidgetBatchProvider>;
}

function UsagePageDocumentContent(props: UsagePageDocumentProps & Readonly<{ layout: ReturnType<typeof useWidgetAreaLayout> }>) {
  const { binding, page } = props;
  const layout = props.layout;
  const needsFilterFallback = !useUsageWidgetBatchInventorySelection(Boolean, Object.is);
  const selectPageFacts = React.useCallback((slices: readonly UsageQueryResultSlice[]) =>
    readUsagePageFacts(slices, needsFilterFallback), [needsFilterFallback]);
  const pageRead = useUsageWidgetBatchSelection(selectPageFacts, sameUsagePageFacts);
  const { facts } = pageRead;
  const filterSlices = React.useMemo(() => pageRead.filterFallback ?? [], [pageRead.filterFallback]);
  const session = props.sessionId !== undefined;
  const presets = React.useMemo(() => session ? [{ id: USAGE_SESSION_WIDGET_PRESET_ID, name: t('usage.sessionUsage') }]
    : USAGE_WIDGET_PRESET_IDS.map(id => ({ id, name: props.names[id] })), [session, props.names]);
  const publishedLayoutSelection = React.useRef<((layoutId: string, callerContext?: ActionExecutorContext) => Promise<boolean>) | null>(null);
  const selectPublishedLayout = React.useCallback((layoutId: string, callerContext?: ActionExecutorContext) => {
    if (!props.authority?.isCurrent()) return Promise.resolve(false);
    return publishedLayoutSelection.current?.(layoutId, callerContext) ?? Promise.resolve(false);
  }, [props.authority]);
  const bar = useCorePageWidgetAreaLayoutBar({
    binding,
    area: layout,
    presets,
    newLayoutBody: t('usage.board.page.newViewBody'),
    newLayoutConfirmText: t('usage.board.page.newViewCreate'),
    selectLayout: selectPublishedLayout,
  });
  const selectedLayoutId = bar.selectedId;
  // The bar owner retains known views and supplies stock presets while inventory is pending or failed.
  const tabs = bar.layouts;
  const tabViews = React.useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        isPreset: tab.isPreset,
        edited: tab.edited,
        icon:
          tab.isPreset && tab.id in PRESET_ICON
            ? PRESET_ICON[tab.id as UsageWidgetPresetId]
            : ('squares-four' as IconName),
      })),
    [tabs],
  );

  // The displayed widgets' own metric: the lab's Tokens/Cost writes each one's input, never a page slot.
  const ready = layout.state.status === 'ready' ? layout.state : null;
  const usageWidgets = React.useMemo(
    () =>
      ready
        ? flattenWidgetLayoutWidgetsV1(ready.items).filter(row => usageWidgetAcceptsMetric(row.instance))
        : [],
    [ready],
  );
  const metrics = new Set(
    usageWidgets.map((row) => {
      const binding = row.instance.bindings.metric;
      return binding?.kind === 'value' ? binding.value : 'tokens';
    }),
  );
  const widgetMetric =
    metrics.size === 1 ? ([...metrics][0] as 'tokens' | 'cost') : null;
  const metricLifetime = React.useMemo(() => ({ surface: props.port.surface, controller: new AbortController(), running: false }), [props.port.surface, props.authority]);
  const [pendingMetric, setPendingMetric] = React.useState<Readonly<{ lifetime: typeof metricLifetime; metric: 'tokens' | 'cost'; writing: boolean }> | null>(null);
  // A filter change rebinds the write port while the same dashboard remains displayed.
  const pendingForDocument = pendingMetric?.lifetime.surface === metricLifetime.surface ? pendingMetric : null;
  const visiblePendingMetric = pendingForDocument && (!pendingForDocument.writing || pendingForDocument.lifetime === metricLifetime)
    ? pendingForDocument : null;
  const metric = visiblePendingMetric?.metric ?? widgetMetric;
  React.useEffect(() => {
    // Acknowledgement ends write activity; the admitted publication ends selection handoff.
    if (pendingMetric && (!pendingForDocument || (!pendingMetric.writing && ready?.isCurrent() && widgetMetric === pendingMetric.metric)))
      setPendingMetric(current => current === pendingMetric ? null : current);
  }, [pendingForDocument, pendingMetric, ready, widgetMetric]);
  const metricApproval = useActionApprovalContinuation({
    scopeKey: JSON.stringify(props.authority?.scope ?? null),
    serverId: props.authority?.scope.serverId ?? '',
    onExecuted: React.useCallback(() => {}, []),
  });
  React.useEffect(() => {
    if (metricLifetime.controller.signal.aborted) metricLifetime.controller = new AbortController();
    const controller = metricLifetime.controller;
    const retired = props.authority?.onRetire(() => controller.abort());
    return () => { retired?.dispose(); controller.abort(); };
  }, [metricLifetime, props.authority]);
  const onMetricChange = React.useCallback(
    (next: 'tokens' | 'cost') => {
      if (!ready || metricLifetime.running || metricLifetime.controller.signal.aborted) return;
      metricLifetime.running = true;
      setPendingMetric({ lifetime: metricLifetime, metric: next, writing: true });
      let acknowledged = false;
      const key = `usage-metric:${JSON.stringify(ready.surface)}`;
      void setUsageWidgetMetric({
        port: props.port,
        target: { surface: ready.surface, context: ready.context },
        instanceIds: usageWidgets.map((row) => row.instance.id),
        metric: next,
        signal: metricLifetime.controller.signal,
        onApprovalPending: registration => {
          publishPresentationNotice({ key, severity: 'info', message: t('widgetAdd.areaApprovalPending') });
          metricApproval.requestApproval(registration);
        },
      }).then(writes => {
        acknowledged = !metricLifetime.controller.signal.aborted && writes.every(write => write.result.ok);
        retirePresentationNotice(key);
        if (!metricLifetime.controller.signal.aborted && writes.some(write => !write.result.ok))
          publishPresentationNotice({ key, severity: 'error', message: t('widgetAdd.saveFailed') });
      }, () => {
        if (!metricLifetime.controller.signal.aborted)
          publishPresentationNotice({ key, severity: 'error', message: t('widgetAdd.saveFailed') });
      }).finally(() => {
        metricLifetime.running = false;
        setPendingMetric(current => current?.lifetime === metricLifetime
          ? acknowledged ? { ...current, writing: false } : null
          : current);
      });
    },
    [metricApproval.requestApproval, metricLifetime, props.port, ready, usageWidgets],
  );
  // Cost bases are named by the displayed accounting reads; until they answer (or fail) the toolbar holds the chip's
  // room. The choices' owner decides both, so the row never drops before its choices arrive (Plans at 1440: −40, +40).
  const costBasis = useUsageWidgetBatchCostBasis();
  const costBasisOptions = costBasis.options;
  // The toolbar's second row is held from first paint too: until the layout answers, the widgets it follows are unknown.
  const layoutLoading = layout.state.status === 'loading';
  // Once the layout is known, every widget that reads accounting counts, not only Tokens/Cost: Sources' Coverage
  // and Unpriced do too, and their chip arriving with the first read pushed a phone page down a line (N4).
  const costBasisPending = ready !== null ? costBasis.pending : layoutLoading;
  const bindingSelectLayout = binding.selectLayout;
  const selectAreaLayout = React.useCallback(async (layoutId: string, callerContext?: ActionExecutorContext) =>
    (await bindingSelectLayout(layoutId, callerContext)).ok, [bindingSelectLayout]);
  const publishedLayouts = React.useMemo(() => tabs.map((tab) => ({ id: tab.id, name: tab.name })), [tabs]);
  // Your apps (D33) is offered once the viewer's app Environments are known; a Session's usage has no apps.
  const appEnvironments = useUsageAppEnvironments(props.sessionId === undefined ? props.authority ?? null : null);
  const scopeFilters = useUsageWidgetPageFilters(page, filterSlices, props.sessionId !== undefined, props.authority?.scope.serverId ?? '',
    appEnvironments);
  const filterCommands = React.useMemo(() => scopeFilters.flatMap(filter => filter.options.map(option => ({
    field: filter.field,
    id: option.id,
    title: `${filter.title}: ${option.label}`,
    invoke: (context?: ActionExecutorContext) => filter.select(option.id, context),
  }))), [scopeFilters]);
  const pageReadRetry = useUsageWidgetPageRetry();
  const homeUnavailable = useActiveHomeUnavailable();
  const historyRead = useUsageWidgetBatchHistory();
  const { publication, selectLayout, selectPeriod, selectCostBasis, selectFilter, retryRead, retryLayouts, history } = usePublishUsageWidgetPageContext({
    page,
    authority: props.authority,
    layoutId: selectedLayoutId,
    layouts: publishedLayouts,
    costBasisOptions,
    filterCommands,
    selectLayout: selectAreaLayout,
    retryRead: facts.failed && pageReadRetry ? pageReadRetry : undefined,
    retryLayouts: homeUnavailable ? undefined : bar.readFailure?.retry,
    history: historyRead,
  });
  const layoutsFailed = !homeUnavailable && bar.readFailure !== undefined;
  const layoutsFact = React.useMemo(() => layoutsFailed ? { retry: () => { void retryLayouts(); } } : null, [layoutsFailed, retryLayouts]);
  // The bar precedes publication because that publication consumes its acknowledged inventory.
  React.useLayoutEffect(() => { publishedLayoutSelection.current = selectLayout; }, [selectLayout]);
  // Toolbar and chart intents borrow the published command, not a second setter path.
  const admittedFilters = React.useMemo(() => scopeFilters.map(filter => ({
    ...filter, select: (id: string, context?: ActionExecutorContext, invocation?: CurrentUiContextCommandInvocation) => selectFilter(filter.field, id, context, invocation),
  })), [scopeFilters, selectFilter]);
  const drill = React.useMemo(() => usageDrillFromPageFilters(admittedFilters), [admittedFilters]);

  const selected = tabs.find((tab) => tab.id === selectedLayoutId) ?? null;
  // Drawn on first paint from the view list's local edited fact, so the line never arrives late and pushes the widgets.
  const presetLine = resolveUsagePresetLine(ready ? { preset: ready.preset ?? null, surface: ready.surface } : null, selected, props.port.surface);
  const phone = useDeviceType() === 'phone';
  const viewName = selected?.name ?? null;
  // The area's items take every area prop; an unchanged view keeps the same dashboard copy.
  const dashboard = React.useMemo(() => ({
    addLabel: t('usage.board.page.addWidget'),
    emptyTitle: t('usage.board.page.emptyView'),
    addTitle: t('usage.board.page.addTo', { view: viewName ?? t('usage.board.page.title') }),
    homeLineAbove: true as const,
  }), [viewName]);
  const labels = React.useMemo(
    (): WidgetAreaLayoutLabels => ({
      list: t('usage.board.page.viewsLabel'),
      current: (name) => `${t('usage.board.page.viewsLabel')}: ${name}`,
      create: t('usage.board.page.newView'),
      createEllipsis: t('usage.board.page.newView'),
      actions: (name) => t('usage.board.page.viewActions', { name }),
      rename: t('usage.board.page.renameView'),
      moveBefore: (name) => t('usage.board.page.moveViewBefore', { name }),
      moveAfter: (name) => t('usage.board.page.moveViewAfter', { name }),
      delete: t('usage.board.page.deleteView'),
      deleteLabel: t('usage.board.page.deleteView'),
    }),
    [],
  );
  const metricPending = layoutLoading || visiblePendingMetric?.writing === true;
  const changeMetric = layoutLoading || (usageWidgets.length && ready?.canEdit) ? onMetricChange : null;
  const metricOptions = React.useMemo(() => usageTokensCostMetricOptions(), []);
  const filterBar = React.useMemo(() => <UsageFilterBar
    period={page.period}
    costBasis={page.scope.costBasis}
    coverageIncomplete={facts.coverageIncomplete}
    scopeFilters={admittedFilters}
    onPeriodChange={selectPeriod}
    onCostBasisChange={selectCostBasis}
    costBasisOptions={costBasisOptions}
    costBasisPending={costBasisPending}
    metricOptions={metricOptions}
    metric={metric}
    metricPending={metricPending}
    onMetricChange={changeMetric}
    // One Session is read over its whole life: a period choice would only cut it short.
    showPeriod={props.sessionId === undefined}
    testID="usage-filters"
  />, [page.period, page.scope.costBasis, facts.coverageIncomplete, admittedFilters, selectPeriod, selectCostBasis, costBasisOptions,
    costBasisPending, metricOptions, metric, metricPending, changeMetric, props.sessionId]);

  const appsShown = readUsageAppCallsEnvironmentIds(page.scope.sources) !== null;
  // Your apps recorded nothing in the period: the scene says it once, in the cards' place.
  const appsNothing = appsShown && facts.nothingRecorded;
  // The selected document and the named-view inventory settle independently.
  return (
    <>
      {publication}
      <UsagePageHeader facts={facts} retry={pageReadRetry ? retryRead : null} history={history}
        appsShown={appsShown}
        homeUnavailable={homeUnavailable} phone={phone}
        layouts={layoutsFact} {...(props.sessionId ? { sessionId: props.sessionId } : {})} />
      {/* One Session is one view: the Account's named views (Plans, Sources…) mean nothing here. A phone
          shows the selected view without the chooser and its + (D23): arranging dashboards is desktop work. */}
      {session || phone ? null : <WidgetAreaLayoutBar
        layouts={tabViews}
        selectedId={selectedLayoutId}
        onSelect={bar.onSelect}
        onCreate={bar.create}
        actions={bar.personalActions}
        // A failed views read is said once by the page header; the bar keeps the built-in views meanwhile.
        labels={labels}
        // The page header already says "Usage": when the views fold into one chooser it is a section-level name, never a
        // second page title under the first (USAGE-ACCEPT 1118 #16).
        heading="section"
        testID="usage-views"
      />}
      {filterBar}
      {presetLine ? (
        <View style={styles.textLine}>
          <WidgetAreaPresetLine
            preset={presetLine.preset}
            surface={presetLine.surface}
            presetActions={binding}
            testID="usage-area.preset"
          />
        </View>
      ) : null}
      {appsNothing ? <UsageAppsNothingRecorded /> : null}
      {/* Behind the scene the cards stay mounted and reading: their reads are what decide `nothingRecorded`, so the
          page shows them again as soon as a call is recorded. Hidden, they say nothing to the eye or the reader. */}
      <View testID="usage-page.cards" style={appsNothing ? styles.cardsWithdrawn : undefined}
        accessibilityElementsHidden={appsNothing} importantForAccessibility={appsNothing ? 'no-hide-descendants' : 'auto'}>
      <UsageDrillProvider value={drill}>
      <WidgetArea
        port={props.port}
        context={props.context}
        layout={layout}
        geometry="grid"
        title={selected?.name ?? t('usage.board.page.title')}
        surfaceName={selected?.name ?? t('usage.board.page.title')}
        dashboard={dashboard}
        testID="usage-area"
      />
      </UsageDrillProvider>
      </View>
    </>
  );
}

/** Select only facts rendered by page chrome; widget evidence stays with its body. */
function readUsagePageFacts(slices: readonly UsageQueryResultSlice[], needsFilterFallback: boolean) {
  const accounting = slices.find(slice => slice.accounting)?.accounting;
  const freshness = accounting ? readUsagePageFreshness(slices) : null;
  const observedAt = freshness?.asOfMs ?? null;
  const olderReadAtMs = freshness?.retainedAccountingReadAtMs
    ?? (observedAt !== null && isUsageObservationFromEarlierDay(observedAt) ? observedAt : null);
  const olderSource = freshness?.olderSource ?? null;
  return {
    // Until unfiltered inventory answers, keep the existing displayed-result choices.
    filterFallback: needsFilterFallback ? slices : null,
    facts: {
      pending: describeUsagePagePendingSources(slices),
      failed: describeUsagePageFailedSources(slices),
      failedQuiet: isUsagePageFailureOnlyWork(slices),
      newerServer: describeUsagePageNewerServerSources(slices),
      workOffline: readUsagePageWorkOffline(slices),
      partial: describeUsagePagePartialSources(slices),
      // The displayed minute, not the raw clock: a refresh within the same minute changes nothing on screen.
      observedAtMs: observedAt === null ? null : Math.floor(observedAt / 60_000) * 60_000,
      olderReadAtMs: olderReadAtMs === null ? null : Math.floor(olderReadAtMs / 60_000) * 60_000,
      olderSource: olderSource ? { ...olderSource, asOfMs: Math.floor(olderSource.asOfMs / 60_000) * 60_000 } : null,
      machines: accounting?.breakdowns?.machine?.length ?? null,
      agents: accounting?.breakdowns?.agent?.length ?? null,
      coverageIncomplete: slices.some(slice => readUsageCoverageGaps(slice, ['accounting']).length > 0),
      nothingRecorded: readUsagePageNothingRecorded(slices),
    },
  };
}

function sameUsagePageFacts(left: ReturnType<typeof readUsagePageFacts>, right: ReturnType<typeof readUsagePageFacts>): boolean {
  const sameFallback = left.filterFallback === right.filterFallback || (left.filterFallback !== null && right.filterFallback !== null
    && left.filterFallback.length === right.filterFallback.length && left.filterFallback.every((slice, index) => slice === right.filterFallback![index]));
  // Compare this small chrome projection, never the widgets' accounting/evidence rows.
  return sameFallback && sameStrictJsonValue(left.facts, right.facts);
}

/**
 * The notice under the page's purpose, when the page has something to say about its reading (D23,
 * phone lab p5 "Usage"): one freshness line, never loose facts. A failure leads (what failed, when,
 * its one Retry); then saved views that could not be read; then Sessions not read yet; then partial,
 * newer-Home or in-flight reads. Only the most pressing one is said.
 */
type UsagePageNotice = Readonly<{
  testID: string;
  reason: string;
  tone: 'neutral' | 'warning';
  busy?: boolean;
  action?: Readonly<{ label: string; onPress: () => void; testID: string }>;
  /** The one word a phone's single header line shows in its place, with the sentence one press away. */
  short?: string;
}>;

function resolveUsagePageNotice(
  facts: ReturnType<typeof readUsagePageFacts>['facts'],
  retry: (() => void) | null,
  history: UsagePageHistoryFact | null | undefined,
  layouts: Readonly<{ retry: () => void }> | null | undefined,
  startSession: () => void,
): UsagePageNotice | null {
  const { pending, failed, failedQuiet, newerServer, partial } = facts;
  if (failed) {
    return { testID: 'usage-page.header.failed', reason: failed, tone: failedQuiet ? 'neutral' : 'warning',
      // The page still shows what arrived: on a phone the line says "Partial" with Details beside its Retry (#9).
      short: t('usage.board.charts.coveragePartialShort'),
      // The one Retry, which also rereads the views and Sessions that failed: bodies with nothing to draw only
      // say they were not read (`UsageBodyReadFailed`).
      ...(retry ? { action: { label: t('common.retry'), onPress: retry, testID: 'usage-page.header.retry' } } : {}) };
  }
  if (layouts) {
    return { testID: 'usage-page.header.viewsFailed', reason: t('usage.board.page.viewsReadFailed'), tone: 'warning',
      action: { label: t('common.retry'), onPress: layouts.retry, testID: 'usage-page.header.viewsRetry' } };
  }
  // Sessions not read yet are why the shown activity is partial: their count and Read now say it once.
  if (history) {
    const onPress = history.onPress;
    return { testID: 'usage-page.header.history', reason: history.text, tone: history.failed ? 'warning' : 'neutral',
      ...(history.label && onPress ? { action: { label: history.label, onPress: () => onPress(), testID: 'usage-page.header.historyAction' } } : {}) };
  }
  // Nothing was recorded in the period (a first-use Account, a quiet week): the page says it once, with the next step,
  // and every card holds one quiet line (`UsageBodyNothingYet`) instead of the same sentence again.
  if (facts.nothingRecorded) {
    return { testID: 'usage-page.header.nothingRecorded', tone: 'neutral',
      // The title alone fits a phone's one header line; Start a session is the reason's next step.
      reason: t('usage.board.page.noUsageTitle'),
      action: { label: t('usage.board.coach.firstUseAction'), onPress: startSession, testID: 'usage-page.header.nothingRecordedAction' } };
  }
  if (newerServer) return { testID: 'usage-page.header.newerServer', reason: newerServer, tone: 'neutral' };
  if (facts.workOffline) return { testID: 'usage-page.header.workOffline', reason: t('usage.board.page.workMachinesOffline'), tone: 'neutral' };
  if (partial) return { testID: 'usage-page.header.partial', reason: partial, tone: 'neutral', short: t('usage.board.charts.coveragePartialShort') };
  if (pending) return { testID: 'usage-page.header.reading', reason: pending, tone: 'neutral', busy: true };
  return null;
}

/**
 * Title, purpose, then either the one notice about the page's reading or, while all is well, the one
 * quiet line of facts the page is about: as of, machines, agents.
 */
function UsagePageHeader(
  props: Readonly<{
    facts: ReturnType<typeof readUsagePageFacts>['facts'];
    retry: (() => void) | null;
    /** The shared Home line owns this failure and its Retry. */
    homeUnavailable?: boolean;
    /** Sessions a wide window has not read yet, with Read now (or a running read with Cancel). */
    history?: UsagePageHistoryFact | null;
    /** The saved views could not be read: the bar shows the built-in views and this header says so once. */
    layouts?: Readonly<{ retry: () => void }> | null;
    /** A session's own usage: the page is about that session, so it opens with its name (`surf-SES`). */
    sessionId?: string;
    phone?: boolean;
    /** Your apps is shown: an empty period is the apps' own fact, and starting a session is not its next step. */
    appsShown?: boolean;
  }>,
) {
  const { retry, history, layouts, phone } = props;
  // A phone's header line cannot hold the partial or read-failure sentence: it says "Partial" and opens the sentence
  // on demand, never an ellipsis mid-word (USAGE-ACCEPT 1113 #16, 1118 #9). A failure keeps its Retry at the line end.
  const [noticeOpen, setNoticeOpen] = React.useState(false);
  const sessionTitle = useSessionDisplayTitles(React.useMemo(() => props.sessionId ? [{ sessionId: props.sessionId }] : [], [props.sessionId]))[0] ?? null;
  const { observedAtMs, olderReadAtMs, olderSource, machines, agents } = props.facts;
  const openNewSession = useOpenNewSession();
  const startSession = React.useCallback(() => { openNewSession(); }, [openNewSession]);
  const counts = React.useMemo((): PageHeaderMetaFact[] => [
    ...(machines ? [{ key: 'machines', text: t('usage.board.page.machinesCount', { count: machines }) }] : []),
    ...(agents ? [{ key: 'agents', text: t('usage.board.page.agentsCount', { count: agents }) }] : []),
  ], [machines, agents]);
  // Unchanged page facts keep the same notice element, so the header does not redraw for a body-only change.
  const notice = React.useMemo(() => {
    // The page's reads wait on the Home: the header says why once, in the facts line's own slot, so the views,
    // filters and the last-read bodies keep their place below it.
    if (props.homeUnavailable) return (
      <SurfaceFreshnessOnSheetProvider>
        <View style={styles.headerLine}>
          <HomeReachabilityGate variant="line" presentation="inline" asOf={props.facts.observedAtMs}>{null}</HomeReachabilityGate>
        </View>
      </SurfaceFreshnessOnSheetProvider>
    );
    const resolved = resolveUsagePageNotice(props.appsShown ? { ...props.facts, nothingRecorded: false } : props.facts,
      retry, history, layouts, startSession);
    if (!resolved && olderReadAtMs === null && !olderSource) return null;
    const testID = resolved?.testID ?? 'usage-page.header.freshness';
    const shortened = phone && resolved?.short ? resolved.short : null;
    const detail = shortened || olderReadAtMs !== null || olderSource ? { label: noticeOpen ? t('usage.showLess') : t('common.details'), testID: `${testID}.detail`,
      onPress: () => setNoticeOpen(open => !open) } : null;
    const expanded = detail !== null && noticeOpen;
    const reason = [
      shortened && !expanded ? shortened : resolved?.reason ?? counts.map(count => count.text).join(' · '),
      olderReadAtMs !== null ? t('usage.board.coach.staleEvidence') : null,
      expanded && olderReadAtMs !== null ? `${usageSourceTitle('accounting')} (${t('usage.board.page.asOf', { time: formatUsageObservedAt(olderReadAtMs) })})` : null,
      expanded && olderSource ? `${t('usage.board.page.oldestSourceUpdate', { time: formatUsageObservedAt(olderSource.asOfMs) })} (${usageSourceTitle(olderSource.source, undefined, 'coverage')})` : null,
    ].filter(Boolean).join(' · ');
    // A plain line under the purpose, on the title's edge: the page header is not a surface to band. It is drawn as
    // tall as the facts line it replaces, its Retry right after the sentence, so no view's header is taller (R139).
    return (
      <SurfaceFreshnessOnSheetProvider>
        <View style={styles.headerLine}>
        <SurfaceFreshnessLine
          // A phone's short form is a line, never an ellipsis: its date (and "older reading") and the short word share one
          // line when they fit and stack when they do not, so nothing is cut before Details and Retry (#9).
          presentation={shortened || expanded ? 'line' : 'inline'}
          {...(expanded ? { glyph: 'clock' as const } : {})}
          testID={testID}
          asOf={props.facts.observedAtMs}
          reason={reason}
          tone={resolved?.tone}
          {...(resolved?.busy ? { busy: true } : {})}
          {...(detail ? { actions: resolved?.action ? [detail, resolved.action] : [detail] }
            : resolved?.action ? { action: resolved.action } : {})}
        />
        </View>
      </SurfaceFreshnessOnSheetProvider>
    );
  }, [props.facts, props.homeUnavailable, props.appsShown, retry, history, layouts, startSession, phone, noticeOpen, olderReadAtMs, olderSource, counts]);
  const facts = React.useMemo((): PageHeaderMetaFact[] => [
    ...(observedAtMs !== null
      ? [{ key: 'asOf', icon: 'clock' as const, text: t('usage.board.page.asOf', { time: formatUsageObservedAt(observedAtMs) }) }]
      : []),
    ...counts,
  ], [observedAtMs, counts]);
  // The header insets its own text to the page column; the page's views, filters and cards share that
  // edge, so the header bleeds back by the same step instead of indenting twice (lab d2top, QA-V F23).
  return (
    <View style={styles.headerBleed}>
      <PageHeader
        title={props.sessionId ? sessionTitle ?? t('usage.sessionUsage') : t('usage.board.page.title')}
        description={t(props.sessionId ? 'usage.board.page.sessionSubtitle' : 'usage.board.page.subtitle')}
        details={notice ?? undefined}
        meta={notice ? undefined : facts}
        alwaysShowTitle
        // This view already sits in the page's wide column: a second, narrower column would inset the title from the cards.
        columnWidth="pane"
        testID="usage-page.header"
      />
      {props.sessionId ? <SessionRetentionNotice sessionId={props.sessionId} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1 },
  // The notice holds the facts line's height (the page meta step), so switching it in never moves the page.
  headerLine: { minHeight: HAPPIER_PAGE_TEXT.meta.lineHeight, justifyContent: 'center' },
  content: { paddingBottom: theme.space.s32 },
  column: {
    alignSelf: 'center',
    width: '100%',
    // Boxes (period, filters, cards) start on the sheet line; text keeps the page's text line (phone lab "Two lines").
    paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
    gap: 14,
  },
  headerBleed: { marginHorizontal: -HAPPIER_PAGE_METRICS.sheetInsetPx },
  cardsWithdrawn: { display: 'none' },
  textLine: { marginHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx - HAPPIER_PAGE_METRICS.sheetInsetPx },
}));
