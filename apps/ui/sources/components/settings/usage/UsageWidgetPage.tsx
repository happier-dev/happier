import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  flattenWidgetLayoutWidgetsV1,
  type WidgetAreaLayoutSummaryV1,
  type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import {
  PageHeader,
  type PageHeaderMetaFact,
} from '@/components/ui/layout/PageHeader';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
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
import { useDeviceType } from '@/utils/platform/responsive';
import { useWidgetAreaLayouts } from '@/components/projects/overview/useProjectDashboards';
import { Modal } from '@/modal';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { buildUsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { t } from '@/text';
import { UsageFilterBar } from './UsageFilterBar';
import { useUsageWidgetPageFilters } from './useUsageWidgetPageFilters';
import { UsageDrillProvider, usageDrillFromPageFilters } from './usageDrill';
import { SessionUsageDrilldownFrame } from './SessionUsageDrilldownFrame';
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
} from './widgets/usageWidgetBatch';

const PRESET_ICON: Readonly<Record<UsageWidgetPresetId, IconName>> = {
  overview: 'squares-four',
  costs: 'currency-dollar',
  work: 'git-pull-request',
  usage: 'list-bullets',
  plans: 'speedometer',
  coach: 'sparkle',
  'how-you-work': 'clock',
  sources: 'stack',
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
} as const satisfies Record<UsageWidgetPresetId, string>;
const SLOT_LABEL_KEYS: Readonly<
  Record<
    string,
    | 'usage.board.page.slotPeriod'
    | 'usage.board.page.filterAgents'
    | 'usage.board.page.filterMachines'
    | 'usage.board.page.filterProjects'
    | 'usage.board.page.filterSources'
    | 'usage.board.page.slotSession'
    | 'usage.costMode'
  >
> = {
  period: 'usage.board.page.slotPeriod',
  agents: 'usage.board.page.filterAgents',
  machines: 'usage.board.page.filterMachines',
  projects: 'usage.board.page.filterProjects',
  sources: 'usage.board.page.filterSources',
  session: 'usage.board.page.slotSession',
  costBasis: 'usage.costMode',
};

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
  const labelForSlot = React.useCallback(
    (path: string) =>
      SLOT_LABEL_KEYS[path] ? t(SLOT_LABEL_KEYS[path]!) : path,
    [],
  );
  const binding = useUsageWidgetAreaBinding({
    serverId: viewer?.serverId ?? '',
    providedContext: page.providedContext,
    names,
    initialMetric: page.initialMetric,
    labelForSlot,
  });
  const contentMaxWidth = useLayoutMaxWidthStyle();
  return (
    <PluginSurfaceFocusEligibilityProvider
      active
      currentUiContextActive={props.sessionId === undefined}
    >
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
          {props.sessionId ? (
            <SessionUsageDrilldownFrame sessionId={props.sessionId} />
          ) : null}
          <UsageWidgetBatchProvider clauses={page.queryOverrides}>
            {binding.port ? (
              <UsagePageDocument
                port={binding.port}
                context={binding.context}
                binding={binding}
                page={page}
                names={names}
                sessionId={props.sessionId}
                onLayoutChange={props.onLayoutChange}
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
    onLayoutChange?: (layoutId: string) => void;
    authority: ReturnType<typeof captureActiveServerAccountScopeLifetime>;
  }>,
) {
  const { binding, page } = props;
  const layout = useWidgetAreaLayout(props.port, props.context);
  const slices = useUsageWidgetBatchSlices();
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
  const selectedLayoutId =
    binding.surface?.owner.kind === 'corePage'
      ? (binding.surface.owner.layoutId ?? 'overview')
      : 'overview';
  const listed = layouts.state.dashboards;
  const views = React.useMemo(
    () =>
      listed.length
        ? listed
        : USAGE_WIDGET_PRESET_IDS.map((id) => ({
            id,
            name: props.names[id],
            isPreset: true,
          })),
    [listed, props.names],
  );
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
  const tabs = React.useMemo(() => views.map(viewOf), [views]);
  const tabViews = React.useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
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
              row.instance.definition.id !== 'usage_sources',
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
  const onMetricChange = React.useCallback(
    (next: 'tokens' | 'cost') => {
      void setUsageWidgetMetric({
        port: props.port,
        instanceIds: usageWidgets.map((row) => row.instance.id),
        metric: next,
      });
    },
    [props.port, usageWidgets],
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
  const bindingSelectLayout = binding.selectLayout;
  const selectAreaLayout = React.useCallback(async (layoutId: string) => (await bindingSelectLayout(layoutId)).ok, [bindingSelectLayout]);
  const publishedLayouts = React.useMemo(() => tabs.map((tab) => ({ id: tab.id, name: tab.name })), [tabs]);
  const scopeFilters = useUsageWidgetPageFilters(page, slices, props.sessionId !== undefined);
  // A chart segment, legend entry or ledger row narrows through this same owner (lab drill-down).
  const drill = React.useMemo(() => usageDrillFromPageFilters(scopeFilters), [scopeFilters]);
  const filterCommands = React.useMemo(() => scopeFilters.flatMap(filter => filter.options.map(option => ({
    title: `${filter.title}: ${option.label}`,
    invoke: () => filter.select(option.id),
  }))), [scopeFilters]);
  const { selectLayout } = usePublishUsageWidgetPageContext({
    page,
    authority: props.authority,
    layoutId: selectedLayoutId,
    layouts: publishedLayouts,
    costBasisOptions,
    filterCommands,
    selectLayout: selectAreaLayout,
    onLayoutChange: props.onLayoutChange,
  });

  // Route intent opens its named view once the area lists it; the area stays the selection owner.
  const initialLayoutId = page.initialLayoutId;
  const appliedIntent = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!initialLayoutId || appliedIntent.current === initialLayoutId || layouts.state.status !== 'ready') return;
    appliedIntent.current = initialLayoutId;
    if (initialLayoutId !== selectedLayoutId && tabs.some((tab) => tab.id === initialLayoutId)) void selectLayout(initialLayoutId);
  }, [initialLayoutId, layouts.state.status, selectedLayoutId, tabs, selectLayout]);
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
      if (!trimmed || !binding.surface) return;
      const created = await layouts.create(trimmed, binding.surface);
      if (
        created.ok &&
        created.dashboard?.surface.owner.kind === 'corePage' &&
        created.dashboard.surface.owner.layoutId
      ) {
        await selectLayout(created.dashboard.surface.owner.layoutId);
      }
    });
  }, [binding.surface, layouts, selectLayout]);
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
          void Modal.confirm(
            t('usage.board.page.deleteViewTitle', { name: summary.name }),
            t('usage.board.page.deleteViewBody'),
            { confirmText: t('common.delete'), destructive: true },
          ).then(async (confirmed) => {
            if (!confirmed) return;
            const removed = await layouts.remove(summary);
            if (removed.ok) await selectLayout('overview');
          });
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
  const phone = useDeviceType() === 'phone';

  return (
    <>
      <UsagePageHeader slices={slices} query={null} />
      <WidgetAreaLayoutBar
        layouts={tabViews}
        selectedId={selectedLayoutId}
        onSelect={(value) => {
          void selectLayout(value);
        }}
        narrow={phone}
        onCreate={createView}
        actions={actions}
        labels={labels}
        testID="usage-views"
      />
      <UsageFilterBar
        page={page}
        slices={slices}
        scopeFilters={scopeFilters}
        costBasisOptions={costBasisOptions}
        metric={metric}
        onMetricChange={
          usageWidgets.length && ready?.canEdit ? onMetricChange : null
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
  }>,
) {
  const facts = React.useMemo((): PageHeaderMetaFact[] => {
    const accounting = props.slices.find(
      (slice) => slice.accounting,
    )?.accounting;
    if (!accounting) return [];
    const asOf = props.slices.flatMap((slice) =>
      slice.sources.flatMap((source) =>
        source.asOfMs === undefined ? [] : [source.asOfMs],
      ),
    );
    const latest = asOf.length ? Math.min(...asOf) : null;
    const machines = accounting.breakdowns?.machine?.length ?? null;
    const agents = accounting.breakdowns?.agent?.length ?? null;
    return [
      ...(latest !== null
        ? [
            {
              key: 'asOf',
              icon: 'clock' as const,
              text: t('usage.board.page.asOf', {
                time: formatWithCachedDateTimeFormatter(
                  new Date(latest),
                  undefined,
                  { hour: '2-digit', minute: '2-digit' },
                ),
              }),
            },
          ]
        : []),
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
  return (
    <PageHeader
      title={t('usage.board.page.title')}
      description={t('usage.board.page.subtitle')}
      meta={facts}
      alwaysShowTitle
      testID="usage-page.header"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface.base },
  content: { paddingBottom: 32 },
  column: {
    alignSelf: 'center',
    width: '100%',
    paddingHorizontal: 16,
    gap: 14,
  },
}));
