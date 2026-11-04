import * as React from 'react';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  flattenWidgetLayoutWidgetsV1,
  readBuiltinWidgetDescriptorV1,
  type WidgetAreaLayoutSummaryV1,
  type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';
import { HAPPIER_ICON_BUTTON_SIZE, HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { CurrentUiContextCommandsProvider } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { publishPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import {
  PageHeader,
  type PageHeaderMetaFact,
} from '@/components/ui/layout/PageHeader';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import type { IconName } from '@/components/ui/icons/Icon';
import { WidgetArea } from '@/components/widgets/area/WidgetArea';
import { WidgetAreaPresetLine } from '@/components/widgets/area/WidgetAreaPresetLine';
import {
  useWidgetAreaLayout,
  type WidgetAreaPort,
} from '@/components/widgets/area/useWidgetAreaLayout';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import {
  WidgetAreaLayoutBar,
  type WidgetAreaLayoutLabels,
} from '@/components/widgets/area/WidgetAreaLayoutBar';
import { useWidgetAreaLayouts } from '@/components/projects/overview/useProjectDashboards';
import { Modal } from '@/modal';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { buildUsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import { formatUsageObservedAt } from '@/sync/domains/usage/usageCalendarPresentation';
import { t } from '@/text';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { UsageFilterBar } from './UsageFilterBar';
import { useUsageWidgetPageFilters } from './useUsageWidgetPageFilters';
import { UsageDrillProvider, usageDrillFromPageFilters } from './usageDrill';
import { SessionRetentionNotice } from '@/components/sessions/info/SessionRetentionNotice';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import {
  USAGE_WIDGET_PRESET_IDS,
  type UsageWidgetPresetId,
} from './usageWidgetPresets';
import { useUsageWidgetAreaBinding } from './useUsageWidgetAreaBinding';
import {
  usePublishUsageWidgetPageContext,
  useUsageWidgetPageContext,
  type UsageWidgetPageContextState,
} from './useUsageWidgetPageContext';
import type {
  UsageWidgetPageInitialFilters,
  UsageWidgetPageScope,
} from './usageWidgetPageContext';
import { setUsageWidgetMetric } from './usageWidgetActions';
import {
  UsageWidgetBatchProvider,
  useUsageWidgetBatchSlices,
  useUsageWidgetBatchInventorySlice,
} from './widgets/usageWidgetBatch';
import { describeUsagePageFailedSources, describeUsagePagePartialSources, describeUsagePagePendingSources, readUsageCoverageGaps, readUsagePageAsOfMs } from './widgets/usageBodyKit';

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
  // Usage is a dashboard grid, so it takes the page's wide column role (a grid or a library), not the
  // reading column: at 1920 and 2560 the lab's two-column groups need the room (lab wgusage-CD).
  const wideColumn = useLayoutMaxWidth('wide');
  const contentMaxWidth = React.useMemo(() => ({ maxWidth: wideColumn }), [wideColumn]);
  const inventoryQuery = React.useMemo(() => normalizeUsageQuery({ ...page.queryOverrides, ...page.scope,
    agents: [], machines: [], projects: [], sources: [], metric: 'tokens', breakdown: ['agent', 'machine', 'project', 'source'] }),
  [page.queryOverrides, page.scope.period, page.scope.session, page.scope.costBasis]);
  return (
    <PluginSurfaceFocusEligibilityProvider
      active
      currentUiContextActive={props.sessionId === undefined}
    >
      <CurrentUiContextCommandsProvider authority={authority} active={page.isCurrent}>
      <ScrollView
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
          <UsageWidgetBatchProvider clauses={page.queryOverrides} inventoryQuery={inventoryQuery}>
            {binding.port ? (
              <UsagePageDocument
                port={binding.port}
                context={binding.context}
                binding={binding}
                page={page}
                names={names}
                sessionId={props.sessionId}
                authority={authority}
              />
            ) : (
              <>
                <UsagePageHeader slices={[]} query={null} />
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
          </UsageWidgetBatchProvider>
        </View>
      </ScrollView>
      </CurrentUiContextCommandsProvider>
    </PluginSurfaceFocusEligibilityProvider>
  );
}

type UsageAreaBinding = ReturnType<typeof useUsageWidgetAreaBinding>;

function UsagePageDocument(
  props: Readonly<{
    port: WidgetAreaPort;
    context: WidgetSurfaceContext;
    binding: UsageAreaBinding;
    page: UsageWidgetPageContextState;
    names: Readonly<Record<UsageWidgetPresetId, string>>;
    sessionId?: string;
    authority: ReturnType<typeof captureActiveServerAccountScopeLifetime>;
  }>,
) {
  const { binding, page } = props;
  const layout = useWidgetAreaLayout(props.port, props.context);
  const slices = useUsageWidgetBatchSlices();
  const inventorySlice = useUsageWidgetBatchInventorySlice();
  const filterSlices = React.useMemo(() => inventorySlice ? [inventorySlice] : slices, [inventorySlice, slices]);
  const areaSurface = React.useMemo(
    (): WidgetSurfaceRefV1 | null =>
      binding.surface && binding.surface.owner.kind === 'corePage'
        ? {
            serverId: binding.surface.serverId,
            accountId: binding.surface.accountId,
            owner: {
              kind: 'corePage',
              pageId: binding.surface.owner.pageId,
              area: binding.surface.owner.area,
            },
          }
        : null,
    [binding.surface?.serverId, binding.surface?.accountId],
  );
  const layouts = useWidgetAreaLayouts({
    surface: areaSurface,
    execute: binding.executeLayoutAction,
  });
  // The title/tabs and body describe the same admitted document while a selection read is pending.
  const admittedSurface = layout.state.status === 'ready' ? layout.state.surface : binding.surface;
  const selectedLayoutId =
    admittedSurface?.owner.kind === 'corePage'
      ? (admittedSurface.owner.layoutId ?? 'overview')
      : 'overview';
  const listed = layouts.state.dashboards;
  const viewOf = (
    summary:
      | WidgetAreaLayoutSummaryV1
      | { id: string; name: string; isPreset: boolean },
  ) =>
    'surface' in summary
      ? {
          id:
            summary.surface.owner.kind === 'corePage'
              ? (summary.surface.owner.layoutId ?? 'overview')
              : summary.artifactId,
          name: summary.name,
          isPreset: summary.isPreset,
          summary,
        }
      : { ...summary, summary: null };
  const tabs = React.useMemo(() => listed.map(viewOf), [listed]);
  const tabViews = React.useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        isPreset: tab.isPreset,
        edited: tab.summary?.isEdited ?? false,
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
        ? flattenWidgetLayoutWidgetsV1(ready.items).filter(
            (row) =>
              row.instance.definition.kind === 'builtin' &&
              row.instance.definition.id.startsWith('usage_') &&
              readBuiltinWidgetDescriptorV1(row.instance.definition)?.inputs?.fields.some(field => field.path === 'metric'),
          )
        : [],
    [ready],
  );
  const metrics = new Set(
    usageWidgets.map((row) => {
      const binding = row.instance.bindings.metric;
      return binding?.kind === 'value' ? binding.value : 'tokens';
    }),
  );
  const metric =
    metrics.size === 1 ? ([...metrics][0] as 'tokens' | 'cost') : null;
  const metricLifetime = React.useMemo(() => ({ controller: new AbortController(), running: false }), [props.port, props.authority]);
  const [pendingMetric, setPendingMetric] = React.useState<typeof metricLifetime | null>(null);
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
      if (!ready || !ready.isCurrent() || metricLifetime.running || metricLifetime.controller.signal.aborted) return;
      metricLifetime.running = true;
      setPendingMetric(metricLifetime);
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
        retirePresentationNotice(key);
        if (!metricLifetime.controller.signal.aborted && writes.some(write => !write.result.ok))
          publishPresentationNotice({ key, severity: 'error', message: t('widgetAdd.saveFailed') });
      }, () => {
        if (!metricLifetime.controller.signal.aborted)
          publishPresentationNotice({ key, severity: 'error', message: t('widgetAdd.saveFailed') });
      }).finally(() => {
        metricLifetime.running = false;
        setPendingMetric(current => current === metricLifetime ? null : current);
      });
    },
    [metricApproval.requestApproval, metricLifetime, props.port, ready, usageWidgets],
  );
  const firstAccounting = slices.find((slice) => slice.accounting)?.accounting;
  const costBasisOptions = React.useMemo(
    (): readonly UsageWidgetPageScope['costBasis'][] =>
      firstAccounting
        ? buildUsageAnalyticsViewModel(firstAccounting, {
            period: page.period,
            metric: 'tokens',
            costMode: 'auto',
            focus: null,
          }).availableCostModes
        : [],
    [firstAccounting, page.period],
  );
  // Cost bases are named by the first usage read; until it answers (or fails) the toolbar holds the chip's room.
  // The toolbar's second row is held from first paint too: until the layout answers, the widgets it follows are unknown.
  const layoutLoading = layout.state.status === 'loading';
  const costBasisPending = (layoutLoading || usageWidgets.length > 0) && !firstAccounting
    && slices.every(slice => readUsageCoverageGaps(slice, ['accounting']).every(gap => gap.status === 'pending' || gap.status === 'not_loaded'));
  const bindingSelectLayout = binding.selectLayout;
  const selectAreaLayout = React.useCallback(async (layoutId: string) => (await bindingSelectLayout(layoutId)).ok, [bindingSelectLayout]);
  const publishedLayouts = React.useMemo(() => tabs.map((tab) => ({ id: tab.id, name: tab.name })), [tabs]);
  const scopeFilters = useUsageWidgetPageFilters(page, filterSlices, props.sessionId !== undefined);
  const filterCommands = React.useMemo(() => scopeFilters.flatMap(filter => filter.options.map(option => ({
    field: filter.field,
    id: option.id,
    title: `${filter.title}: ${option.label}`,
    invoke: () => filter.select(option.id),
  }))), [scopeFilters]);
  const { selectLayout, selectPeriod, selectCostBasis, selectFilter } = usePublishUsageWidgetPageContext({
    page,
    authority: props.authority,
    layoutId: selectedLayoutId,
    layouts: publishedLayouts,
    costBasisOptions,
    filterCommands,
    selectLayout: selectAreaLayout,
  });
  // Toolbar and chart intents borrow the published command, not a second setter path.
  const admittedFilters = React.useMemo(() => scopeFilters.map(filter => ({
    ...filter, select: (id: string) => selectFilter(filter.field, id),
  })), [scopeFilters, selectFilter]);
  const drill = React.useMemo(() => usageDrillFromPageFilters(admittedFilters), [admittedFilters]);

  const createView = React.useCallback(() => {
    void Modal.prompt(
      t('usage.board.page.newViewTitle'),
      t('usage.board.page.newViewBody'),
      {
        placeholder: t('usage.board.page.newViewPlaceholder'),
        confirmText: t('usage.board.page.newViewCreate'),
      },
    ).then(async (name) => {
      const trimmed = name?.trim();
      if (!trimmed || !admittedSurface) return;
      const created = await layouts.create(trimmed, admittedSurface);
      if (
        created.ok &&
        created.dashboard?.surface.owner.kind === 'corePage' &&
        created.dashboard.surface.owner.layoutId
      ) {
        await selectLayout(created.dashboard.surface.owner.layoutId);
      }
    });
  }, [admittedSurface, layouts, selectLayout]);
  const selected = tabs.find((tab) => tab.id === selectedLayoutId) ?? null;
  const actions = React.useMemo(() => {
    const summary = selected?.summary;
    if (!summary || selected.isPreset) return null;
    const userViews = tabs.filter((tab) => !tab.isPreset && tab.summary);
    const index = userViews.findIndex((tab) => tab.id === selected.id);
    const before = index > 0 ? userViews[index - 1]! : null;
    const after =
      index >= 0 && index < userViews.length - 1 ? userViews[index + 1]! : null;
    return {
      rename: () => {
        void Modal.prompt(t('usage.board.page.renameViewTitle'), undefined, {
          defaultValue: summary.name,
          confirmText: t('common.save'),
        }).then((name) => {
          const next = name?.trim();
          if (next && next !== summary.name) void layouts.rename(summary, next);
        });
      },
      ...(before
        ? {
            moveBefore: {
              name: before.name,
              onPress: () => {
                void layouts.reorder(summary, {
                  anchorId: before.summary!.artifactId,
                  placement: 'before',
                });
              },
            },
          }
        : {}),
      ...(after
        ? {
            moveAfter: {
              name: after.name,
              onPress: () => {
                void layouts.reorder(summary, {
                  anchorId: after.summary!.artifactId,
                  placement: 'after',
                });
              },
            },
          }
        : {}),
      delete: {
        onPress: () => {
          void (async () => {
            const removed = await layouts.remove(summary);
            if (removed.ok && !removed.approvalPending) await selectLayout('overview');
          })();
        },
      },
    };
  }, [selected, tabs, layouts, selectLayout]);
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
  const preset = ready?.preset ?? null;

  // The selected document admits its widgets independently; the inventory only
  // admits the view switcher. Hold that switcher's room while its names arrive.
  return (
    <>
      <UsagePageHeader slices={slices} query={null} {...(props.sessionId ? { sessionId: props.sessionId } : {})} />
      {layouts.state.status !== 'loading' ? <WidgetAreaLayoutBar
        layouts={tabViews}
        selectedId={selectedLayoutId}
        onSelect={(value) => {
          void selectLayout(value);
        }}
        onCreate={createView}
        actions={actions}
        labels={labels}
        testID="usage-views"
      /> : <SkeletonRows rows={1} lines={1} rowHeight={HAPPIER_ICON_BUTTON_SIZE}
        geometry={{ insetStart: 0, insetEnd: 0, glyphColumn: 0, gap: 0 }} accessibilityLabel={labels.list} testID="usage-views.loading" />}
      <UsageFilterBar
        page={page}
        slices={slices}
        scopeFilters={admittedFilters}
        onPeriodChange={selectPeriod}
        onCostBasisChange={selectCostBasis}
        costBasisOptions={costBasisOptions}
        costBasisPending={costBasisPending}
        metric={metric}
        metricPending={layoutLoading || pendingMetric === metricLifetime}
        onMetricChange={
          layoutLoading || (usageWidgets.length && ready?.canEdit) ? onMetricChange : null
        }
        testID="usage-filters"
      />
      {preset?.isEdited && ready ? (
        <WidgetAreaPresetLine
          preset={preset}
          surface={ready.surface}
          presetActions={binding}
          testID="usage-area.preset"
        />
      ) : null}
      <UsageDrillProvider value={drill}>
      <WidgetArea
        port={props.port}
        context={props.context}
        layout={layout}
        geometry="grid"
        title={selected?.name ?? t('usage.board.page.title')}
        surfaceName={selected?.name ?? t('usage.board.page.title')}
        dashboard={{
          addLabel: t('usage.board.page.addWidget'),
          emptyTitle: t('usage.board.page.emptyView'),
          addTitle: t('usage.board.page.addTo', {
            view: selected?.name ?? t('usage.board.page.title'),
          }),
        }}
        testID="usage-area"
      />
      </UsageDrillProvider>
    </>
  );
}

/** Title, purpose and the one quiet line of facts the page is about: as of, machines, agents. */
function UsagePageHeader(
  props: Readonly<{
    slices: ReturnType<typeof useUsageWidgetBatchSlices>;
    query: null;
    /** A session's own usage: the page is about that session, so it opens with its name (`surf-SES`). */
    sessionId?: string;
  }>,
) {
  const sessionTitle = useSessionDisplayTitles(React.useMemo(() => props.sessionId ? [{ sessionId: props.sessionId }] : [], [props.sessionId]))[0] ?? null;
  const facts = React.useMemo((): PageHeaderMetaFact[] => {
    // A source still being read is one cause for the whole page: said here once, never in each body.
    const pending = describeUsagePagePendingSources(props.slices);
    // A failed shared read is one cause too: said here once, and every body inherits it quietly.
    const failed = describeUsagePageFailedSources(props.slices);
    // A read that settled with only some Sessions' evidence is one cause too; bodies show what it witnessed.
    const partial = describeUsagePagePartialSources(props.slices);
    const reading = [
      ...(failed ? [{ key: 'failed', icon: 'warning' as const, text: failed, testID: 'usage-page.header.failed' }] : []),
      ...(partial ? [{ key: 'partial', text: partial, testID: 'usage-page.header.partial' }] : []),
      ...(pending ? [{ key: 'reading', text: pending }] : []),
    ];
    const accounting = props.slices.find(
      (slice) => slice.accounting,
    )?.accounting;
    if (!accounting) return reading;
    const latest = readUsagePageAsOfMs(props.slices);
    const machines = accounting.breakdowns?.machine?.length ?? null;
    const agents = accounting.breakdowns?.agent?.length ?? null;
    return [
      ...(latest !== null
        ? [
            {
              key: 'asOf',
              icon: 'clock' as const,
              text: t('usage.board.page.asOf', {
                time: formatUsageObservedAt(latest),
              }),
            },
          ]
        : []),
      ...reading,
      ...(machines
        ? [
            {
              key: 'machines',
              text: t('usage.board.page.machinesCount', { count: machines }),
            },
          ]
        : []),
      ...(agents
        ? [
            {
              key: 'agents',
              text: t('usage.board.page.agentsCount', { count: agents }),
            },
          ]
        : []),
    ];
  }, [props.slices]);
  // The header insets its own text to the page column; the page's views, filters and cards share that
  // edge, so the header bleeds back by the same step instead of indenting twice (lab d2top, QA-V F23).
  return (
    <View style={styles.headerBleed}>
      <PageHeader
        title={props.sessionId ? sessionTitle ?? t('usage.sessionUsage') : t('usage.board.page.title')}
        description={t(props.sessionId ? 'usage.board.page.sessionSubtitle' : 'usage.board.page.subtitle')}
        meta={facts}
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
  screen: { flex: 1, backgroundColor: theme.colors.surface.base },
  content: { paddingBottom: theme.space.s32 },
  column: {
    alignSelf: 'center',
    width: '100%',
    paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx,
    gap: 14,
  },
  headerBleed: { marginHorizontal: -HAPPIER_PAGE_METRICS.pageTextInsetPx },
}));
