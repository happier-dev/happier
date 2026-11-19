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
import { USAGE_SCOPE_FILTER_ALL, USAGE_SOURCES_SHOW_AGENTS, USAGE_SOURCES_SHOW_APPS, type UsageWidgetPageFilter } from './useUsageWidgetPageFilters';
import { getAgentIdentityColor } from '@/agents/catalog/catalog';
import { UsageAgentMark } from './widgets/usageBodyKit';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { CurrentUiContextCommandInvocation } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

const COST_BASIS_TITLE = { auto: 'usage.board.page.costBasisAuto', reported: 'usage.board.page.costBasisReported',
    estimated: 'usage.board.page.costBasisEstimated', api_equivalent: 'usage.board.page.factApiEquivalent' } as const;
/** The chip's own word for the basis in force (lab uframe-Rp "API-eq."): the bar keeps one line; the chooser and the
 *  chip's accessible name keep the whole title. */
const COST_BASIS_SHORT = { auto: 'usage.board.page.costBasisShortAuto', reported: 'usage.board.page.costBasisShortReported',
    estimated: 'usage.board.page.costBasisShortEstimated', api_equivalent: 'usage.board.page.costBasisShortApiEquivalent' } as const;

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
  // Scopes fold into the one Filters chooser only on a phone; a desktop keeps one chip per scope. Tokens/Cost and the
  // cost basis hold the bar's end edge on every view (lab d2views; phone lab p5 "Filters and Tokens/Cost on one line").
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
        const { field, selected, title } = filter;
        const options = filter.options.filter(option => option.section !== 'show');
        const label = (key: string) => options.find(option => option.id === key)?.label ?? key;
        const value = filter.valueLabel ?? (
          selected.length === 0
            // An unnarrowed scope reads "All" (lab d2views, d2filter); a bare count reads as a selection, so the
            // count stays with the menu's "All N" row. Width-neutral, so the row keeps its one line (R135 call 1).
            ? t('usage.board.page.filterAll')
            : selected.length <= 2
              ? selected.map(label).join(', ')
              : t('usage.board.page.filterCount', { count: selected.length }));
        const selectedIds = new Set(selected.length === 0 ? [USAGE_SCOPE_FILTER_ALL] : selected);
        const choices = options.map(({ agentId, partial, section: _section, ...option }) => ({
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
            }));
        return {
          id: field,
          label: title,
          showLabel: true,
          valueLabel: value,
          // Your apps narrows the page away from its default Agents, so its chip reads as chosen.
          active: selected.length > 0 || filter.shown === 'apps',
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
          options: choices,
          selectedIds,
          onChange: filter.select,
          // Sources with apps opens one chooser: Show (Agents or Your apps, exclusive), then that side's choices (D33).
          ...(filter.shown ? { renderPopoverContent: ({ close, maxHeight }: Readonly<{ close: () => void; maxHeight: number }>) => (
            <UsageScopeSections sections={usageFilterSections(filter, choices, selectedIds, filter.select)} onRequestClose={close} maxHeight={maxHeight}
              testID={`${props.testID}.${field}`} />
          ) } : {}),
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
            valueLabel: t(COST_BASIS_SHORT[props.costBasis]),
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
              <UsageScopeSections sections={props.scopeFilters.flatMap((filter, index) => usageFilterSections(filter,
                filters[index]?.options ?? [], filters[index]?.selectedIds ?? new Set(),
                (id, context, invocation) => filters[index]?.onChange?.(id, context, invocation)))}
                onRequestClose={close} maxHeight={maxHeight} testID={`${props.testID}.scope`} />
            ),
            testID: `${props.testID}.scope`,
          }
        : null,
    [condensed, filters, props.scopeFilters, coverageIncomplete, props.testID],
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
  // A phone puts Tokens/Cost right after Filters and the basis after it. On a wide screen the basis leads and
  // Tokens/Cost holds the trailing edge. Keyed, so crossing the breakpoint moves the two instead of remounting them:
  // an open basis chooser stays open (HUNT-UI-STATE C2).
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
  // One row of controls (USAGE-ACCEPT 1118 #12): a phone puts the period on its own line and Filters with Tokens/Cost
  // on the next (phone lab p5); a wide screen keeps period, scopes, basis and Tokens/Cost on one line (lab d2views)
  // and wraps only the end group, right-aligned, when the window is too narrow. The basis chip holds its width while
  // its read is outstanding (it shows the basis in force), so nothing moves when the read answers.
  return (
    <View testID={props.testID} style={phone ? styles.phone : styles.bar}>
      {period}
      {!phone && props.scopeFilters.length > 0 ? <View style={styles.rule} /> : null}
      <View style={phone ? styles.phoneControls : styles.controls}>
        <View style={styles.chips}>{chips}</View>
        {props.onMetricChange || costFilter ? <View testID={`${props.testID}.trailing`} style={phone ? styles.phoneTrailing : styles.trailing}>
          {trailing}
        </View> : null}
      </View>
    </View>
  );
}

const SECTION_KEY = '\u0001';

type UsageScopeSection = Readonly<{
  id: string;
  title: string;
  options: readonly Readonly<{ id: string; label: string; subtitle?: string; icon?: React.ReactNode; accessory?: React.ReactNode }>[];
  selectedIds: ReadonlySet<string>;
  onChange: (id: string, callerContext?: ActionExecutorContext, invocation?: CurrentUiContextCommandInvocation) => unknown;
  resultHint?: string;
}>;

/**
 * One scope's sections in a chooser. Sources with apps leads with the exclusive Show choice, then that side's
 * choices under their own title; Your apps ends with the one line saying the two are never added together.
 */
function usageFilterSections(filter: UsageWidgetPageFilter, choices: UsageScopeSection['options'], selectedIds: ReadonlySet<string>,
  onChange: UsageScopeSection['onChange']): UsageScopeSection[] {
  if (!filter.shown) return [{ id: filter.field, title: filter.title, options: choices, selectedIds, onChange }];
  const shownId = filter.shown === 'apps' ? USAGE_SOURCES_SHOW_APPS : USAGE_SOURCES_SHOW_AGENTS;
  return [
    { id: `${filter.field}.show`, title: t('usage.board.page.sourcesShow'),
      options: filter.options.filter(option => option.section === 'show'), selectedIds: new Set([shownId]), onChange },
    { id: filter.field, title: filter.shown === 'apps' ? t('usage.board.page.sourcesAppsTitle') : filter.title, options: choices, selectedIds, onChange,
      ...(filter.shown === 'apps' ? { resultHint: t('usage.board.page.sourcesExclusive') } : {}) },
  ];
}

/** Every scope as one section of a chooser; a row toggles exactly what its own chip would. */
function UsageScopeSections(props: Readonly<{
  sections: readonly UsageScopeSection[];
  onRequestClose: (callerContext?: ActionExecutorContext) => void;
  maxHeight: number;
  testID: string;
}>) {
  const step = React.useMemo((): SelectionListStep => ({
    id: 'usage-scope',
    sections: props.sections.map(section => ({
      kind: 'static' as const,
      id: section.id,
      title: section.title,
      ...(section.resultHint ? { resultHint: section.resultHint } : {}),
      options: section.options.map(option => ({
        id: `${section.id}${SECTION_KEY}${option.id}`,
        label: option.label,
        ...(option.subtitle ? { subtitle: option.subtitle } : {}),
        ...(option.icon ? { icon: option.icon } : {}),
        ...(option.accessory ? { rightAccessory: option.accessory } : {}),
        testID: `${props.testID}:${section.id}:${option.id}`,
      })),
    })),
  }), [props.sections, props.testID]);
  const selectedIds = React.useMemo(() => new Set(props.sections.flatMap(section =>
    [...section.selectedIds].map(id => `${section.id}${SECTION_KEY}${id}`))), [props.sections]);
  return (
    <SelectionList
      testID={`${props.testID}.list`}
      currentUiContextCommandScope={`${props.testID}.filters`}
      currentUiContextForegroundOverlay
      rootStep={step}
      selection={{ kind: 'multiple', selectedIds }}
      onSelect={(id, _option, callerContext, invocation) => {
        const [section, option] = id.split(SECTION_KEY);
        void props.sections.find(candidate => candidate.id === section)?.onChange(option ?? '', callerContext, invocation);
      }}
      onRequestClose={props.onRequestClose}
      listAccessibilityLabel={t('usage.board.page.filtersLabel')}
      maxHeight={props.maxHeight}
      disableTransitions
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s10,
    rowGap: theme.space.s8,
    paddingVertical: theme.space.s4,
  },
  // Takes the room beside the period; the end group wraps under the scopes, never the scopes under the period.
  controls: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
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
  trailing: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: theme.space.s10, marginLeft: 'auto' },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  phone: { gap: theme.space.s10 },
  phoneControls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s6 },
  phoneTrailing: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: theme.space.s6, marginLeft: 'auto' },
}));
