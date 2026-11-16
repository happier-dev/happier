import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import { SelectionList } from '@/components/ui/selectionList/SelectionList';
import type { SelectionListFilter, SelectionListStep } from '@/components/ui/selectionList/_types';
import {
  USAGE_PERIODS,
  getUsagePeriodDefinition,
  type UsagePeriod,
} from '@/sync/api/account/usagePeriods';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';
import type { UsageWidgetPageScope } from './usageWidgetPageContext';
import { USAGE_SCOPE_FILTER_ALL, type UsageWidgetPageFilter } from './useUsageWidgetPageFilters';
import { getAgentIdentityColor } from '@/agents/catalog/catalog';
import { UsageAgentMark } from './widgets/usageBodyKit';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { CurrentUiContextCommandInvocation } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

const COST_BASIS_TITLE = { auto: 'usage.board.page.costBasisAuto', reported: 'usage.board.page.costBasisReported',
    estimated: 'usage.board.page.costBasisEstimated', api_equivalent: 'usage.board.page.factApiEquivalent' } as const;

/** The metric choice the account Usage page offers: what its widgets draw. */
export function usageTokensCostMetricOptions(): readonly Readonly<{ id: 'tokens' | 'cost'; label: string }>[] {
  return [{ id: 'tokens', label: t('usage.tokens') }, { id: 'cost', label: t('usage.cost') }];
}

/**
 * A usage page's one filter bar (lab `d2filter`): period, then each scope slot the widgets follow, then
 * the shown metric and the cost basis slot. Every control writes its caller's owner (the account page
 * context, or a shared credential's usage read); it reads no usage of its own.
 */
export function UsageFilterBar<M extends string = 'tokens' | 'cost'>(
  props: Readonly<{
    period: UsagePeriod;
    costBasis: UsageWidgetPageScope['costBasis'];
    coverageIncomplete: boolean;
    scopeFilters: readonly UsageWidgetPageFilter[];
    costBasisOptions: readonly UsageWidgetPageScope['costBasis'][];
    /** The usage read that tells which cost bases exist has not answered yet. */
    costBasisPending: boolean;
    onPeriodChange(period: UsagePeriod): Promise<boolean>;
    onCostBasisChange(costBasis: UsageWidgetPageScope['costBasis'], callerContext?: ActionExecutorContext, invocation?: CurrentUiContextCommandInvocation): Promise<boolean>;
    /** The metrics offered, in order; the account page's are `usageTokensCostMetricOptions()`. */
    metricOptions: readonly Readonly<{ id: M; label: string }>[];
    /** The shown metric; `null` when the displayed widgets differ or none is shown. */
    metric: M | null;
    onMetricChange: ((metric: M) => void) | null;
    metricPending?: boolean;
    testID: string;
  }>,
) {
  const shownMetric = props.metric ?? props.metricOptions[0]?.id ?? null;
  const phone = useDeviceType() === 'phone';
  // Scopes fold into the one Filters chooser only on a phone; a desktop keeps one chip per scope and puts
  // Tokens/Cost and the cost basis on their own right-aligned row on every view, so the bar keeps one shape (R138).
  const condensed = phone;
  const periodTabs = React.useMemo(
    () =>
      USAGE_PERIODS.map((period) => ({
        id: period,
        label: t(getUsagePeriodDefinition(period).shortTranslationKey),
      })),
    [],
  );
  const { theme } = useUnistyles();
  // Coverage is said once, as a dot in Sources, while a source the page reads is incomplete.
  const coverageIncomplete = props.coverageIncomplete;
  const filters = React.useMemo(
    (): SelectionListFilter[] =>
      props.scopeFilters.map((filter) => {
        const { field, selected, options, title } = filter;
        const label = (key: string) => options.find(option => option.id === key)?.label ?? key;
        const value =
          selected.length === 0
            // An unnarrowed scope reads "All" (lab d2views, d2filter); a bare count reads as a selection, so the
            // count stays with the menu's "All N" row. Width-neutral, so the row keeps its one line (R135 call 1).
            ? t('usage.board.page.filterAll')
            : selected.length <= 2
              ? selected.map(label).join(', ')
              : t('usage.board.page.filterCount', { count: selected.length });
        return {
          id: field,
          label: title,
          showLabel: true,
          valueLabel: value,
          active: selected.length > 0,
          // The gap dot comes and goes with coverage; its slot stays so the chips beside Sources never move.
          ...(field === 'sources' ? { reservePresence: true } : {}),
          ...(field === 'sources' && coverageIncomplete ? { presence: 'attention' as const } : {}),
          ...(field === 'agents' && selected.length === 1
            ? {
                icon: (
                  <UsageAgentMark
                    agentId={selected[0]!}
                    serverId={null}
                    size={14}
                  />
                ),
              }
            : {}),
          options: options.map(({ agentId, partial, ...option }) => ({
              ...option,
              // A source reads by its Agent's mark; one amber dot flags a gap (lab d2filter-SRC).
              ...(field === 'sources' && agentId ? { icon: <UsageAgentMark agentId={agentId} serverId={null} size={16} /> } : {}),
              ...(field === 'sources' && partial ? { accessory: <View style={collectionListStyles.troubleDot} /> } : {}),
              ...(field === 'agents' && option.id !== USAGE_SCOPE_FILTER_ALL
                ? {
                    icon: (
                      <UsageAgentMark agentId={option.id} serverId={null} size={16} />
                    ),
                    // The same identity hue the Agent's series take on every chart.
                    accessory: (
                      <View style={[styles.swatch, { backgroundColor: getAgentIdentityColor(theme, option.id) }]} />
                    ),
                  }
                : {}),
            })),
          selectedIds: new Set(selected.length === 0 ? [USAGE_SCOPE_FILTER_ALL] : selected),
          onChange: filter.select,
          testID: `${props.testID}.${field}`,
        };
      }),
    [props.scopeFilters, props.testID, coverageIncomplete, theme],
  );
  // While the read that names the cost bases is outstanding the chip already shows the basis in force (its
  // only known choice), so the trailing edge keeps its width and nothing beside it moves when the rest arrive.
  const costBasisChoices = props.costBasisPending ? [props.costBasis] : props.costBasisOptions;
  const costFilter = React.useMemo(
    (): SelectionListFilter | null =>
      costBasisChoices.length < 2 && !props.costBasisPending
        ? null
        : {
            id: 'costBasis',
            label: t('usage.costMode'),
            options: costBasisChoices.map((option) => ({
              id: option,
              label: t(COST_BASIS_TITLE[option]),
            })),
            selectedId: props.costBasis,
            onChange: (id: string, callerContext?: ActionExecutorContext, invocation?: CurrentUiContextCommandInvocation) => {
              void props.onCostBasisChange(id as UsageWidgetPageScope['costBasis'], callerContext, invocation);
            },
            testID: `${props.testID}.costBasis`,
          },
    [props.costBasis, costBasisChoices, props.costBasisPending, props.onCostBasisChange, props.testID],
  );
  const metricTabs = React.useMemo(
    () => props.metricOptions.map((option) => ({ ...option, disabled: props.metricPending })),
    [props.metricOptions, props.metricPending],
  );
  // A phone keeps the period visible and folds every scope into one Filters chooser with the
  // narrowed count and the coverage dot (lab d2filter P); each scope is a section of the same choices.
  const scopeChooser = React.useMemo(
    (): SelectionListFilter | null =>
      condensed && filters.length > 0
        ? {
            id: 'scope',
            label: t('usage.board.page.filtersLabel'),
            valueLabel: t('usage.board.page.filtersLabel'),
            active: filters.some(filter => filter.active),
            ...(filters.some(filter => filter.active)
              ? { count: String(filters.filter(filter => filter.active).length) }
              : {}),
            reservePresence: true,
            ...(coverageIncomplete ? { presence: 'attention' as const } : {}),
            renderPopoverContent: ({ close, maxHeight }) => (
              <UsageScopeSections filters={filters} onRequestClose={close} maxHeight={maxHeight}
                testID={`${props.testID}.scope`} />
            ),
            testID: `${props.testID}.scope`,
          }
        : null,
    [condensed, filters, coverageIncomplete, props.testID],
  );
  const chips = (
    <>
      {scopeChooser ? <SelectionListFilterChip filter={scopeChooser} currentUiContextCommandScope={scopeChooser.testID} /> : filters.map((filter) => (
        <SelectionListFilterChip key={filter.id} filter={filter} currentUiContextCommandScope={filter.testID} />
      ))}
    </>
  );
  const metricToggle = props.onMetricChange && shownMetric !== null ? (
        <View style={styles.segment}>
          <SegmentedTabBar
            role="radiogroup"
            testIDPrefix={`${props.testID}.metric`}
            tabs={metricTabs}
            activeTabId={shownMetric}
            onSelectTab={props.onMetricChange}
            segmentSizing="content"
            accessibilityLabel={t('usage.board.page.metricLabel')}
          />
        </View>
      ) : null;
  // Shown in Tokens and Cost alike (labs d2views, d2top, d2work): a Tokens page still shows basis-dependent
  // money, and a chip that came and went with the toggle reshaped the bar under the pointer (R135 call 2).
  const costChip = costFilter ? <SelectionListFilterChip filter={costFilter} currentUiContextCommandScope={costFilter.testID} /> : null;
  // A phone's row wraps: Tokens/Cost stays on the first line and the basis follows it. On a wide screen the basis
  // leads and Tokens/Cost holds the trailing edge. Keyed, so crossing the breakpoint moves the two instead of
  // remounting them: an open basis chooser stays open (HUNT-UI-STATE C2).
  const metricSlot = metricToggle ? <React.Fragment key="metric">{metricToggle}</React.Fragment> : null;
  const costSlot = costChip ? <React.Fragment key="cost">{costChip}</React.Fragment> : null;
  const trailing = phone ? [metricSlot, costSlot] : [costSlot, metricSlot];
  const period = (
    <View style={phone ? styles.periodPhone : styles.period}>
      <SegmentedTabBar
        role="radiogroup"
        testIDPrefix={`${props.testID}.period`}
        tabs={periodTabs}
        activeTabId={props.period}
        onSelectTab={(period: UsagePeriod) => {
          void props.onPeriodChange(period);
        }}
        // The standard segmented size (lab wgsaved R); each segment hugs its label, so a longer
        // translation ("Aujourd’hui") is never cut, and the bar wraps whole controls instead.
        segmentSizing="content"
        accessibilityLabel={t('usage.board.page.periodLabel')}
      />
    </View>
  );
  // One tree on every width: the bar recomposes by style, so a chooser opened on one side of the phone breakpoint
  // is still open on the other.
  return (
    <View testID={props.testID} style={phone ? styles.phone : styles.stack}>
      <View style={phone ? styles.phone : styles.bar}>
        {period}
        {!phone && props.scopeFilters.length > 0 ? <View style={styles.rule} /> : null}
        {/* Phone: the Filters chip on its own line. */}
        <View style={phone ? styles.phoneChips : styles.chips}>{chips}</View>
      </View>
      {/* What the widgets show and in which money sit on their own row, end edge, on every view, so a view without
          Tokens/Cost keeps the bar's shape and the page never moves on arrival (R138). The basis arrives when its read
          answers: on a phone sharing the Filters line it wrapped late and pushed the page 38 px (sweep 1110 N4); on a
          wide screen it grows leftward and never moves the toggle under the pointer (sweep 1110 #26). */}
      {props.onMetricChange || costFilter ? <View testID={`${props.testID}.trailing`} style={phone ? styles.phoneTrailing : styles.trailing}>
        {trailing}
      </View> : null}
    </View>
  );
}

const SECTION_KEY = '\u0001';

/** Every scope as one section of the phone chooser; a row toggles exactly what its own chip would. */
function UsageScopeSections(props: Readonly<{
  filters: readonly SelectionListFilter[];
  onRequestClose: (callerContext?: ActionExecutorContext) => void;
  maxHeight: number;
  testID: string;
}>) {
  const step = React.useMemo((): SelectionListStep => ({
    id: 'usage-scope',
    sections: props.filters.map(filter => ({
      kind: 'static' as const,
      id: filter.id,
      title: filter.label,
      options: (filter.options ?? []).map(option => ({
        id: `${filter.id}${SECTION_KEY}${option.id}`,
        label: option.label,
        ...(option.subtitle ? { subtitle: option.subtitle } : {}),
        ...(option.icon ? { icon: option.icon } : {}),
        ...(option.accessory ? { rightAccessory: option.accessory } : {}),
        testID: `${props.testID}:${filter.id}:${option.id}`,
      })),
    })),
  }), [props.filters, props.testID]);
  const selectedIds = React.useMemo(() => new Set(props.filters.flatMap(filter =>
    [...(filter.selectedIds ?? [])].map(id => `${filter.id}${SECTION_KEY}${id}`))), [props.filters]);
  return (
    <SelectionList
      testID={`${props.testID}.list`}
      currentUiContextCommandScope={`${props.testID}.filters`}
      currentUiContextForegroundOverlay
      rootStep={step}
      selection={{ kind: 'multiple', selectedIds }}
      onSelect={(id, _option, callerContext, invocation) => {
        const [field, option] = id.split(SECTION_KEY);
        props.filters.find(filter => filter.id === field)?.onChange?.(option ?? '', callerContext, invocation);
      }}
      onRequestClose={props.onRequestClose}
      listAccessibilityLabel={t('usage.board.page.filtersLabel')}
      maxHeight={props.maxHeight}
      disableTransitions
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.space.s8, paddingVertical: theme.space.s4 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s10,
    rowGap: theme.space.s8,
  },
  period: { flexShrink: 0 },
  periodPhone: { alignSelf: 'stretch' },
  rule: {
    width: StyleSheet.hairlineWidth,
    height: 20,
    backgroundColor: theme.colors.border.default,
  },
  chips: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s6,
  },
  segment: { flexShrink: 0 },
  trailing: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: theme.space.s10 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  phone: { gap: theme.space.s10 },
  phoneChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  phoneTrailing: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: theme.space.s6 },
}));
