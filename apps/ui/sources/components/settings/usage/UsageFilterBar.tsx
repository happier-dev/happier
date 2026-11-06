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
import type { UsageWidgetPageContextState } from './useUsageWidgetPageContext';
import type { UsageWidgetPageScope } from './usageWidgetPageContext';
import { USAGE_SCOPE_FILTER_ALL, type UsageWidgetPageFilter } from './useUsageWidgetPageFilters';
import { getAgentIdentityColor } from '@/agents/catalog/catalog';
import { UsageAgentMark } from './widgets/usageBodyKit';

const COST_BASIS_TITLE = { auto: 'usage.board.page.costBasisAuto', reported: 'usage.board.page.costBasisReported',
    estimated: 'usage.board.page.costBasisEstimated', api_equivalent: 'usage.board.page.factApiEquivalent' } as const;

/**
 * The page's one filter bar (lab `d2filter`): period, then each scope slot the widgets follow, then
 * the displayed widgets' own Tokens/Cost and the cost basis slot. Every control writes the mounted
 * page context or the widgets' inputs through their owners; it reads no usage of its own.
 */
export function UsageFilterBar(
  props: Readonly<{
    page: UsageWidgetPageContextState;
    coverageIncomplete: boolean;
    scopeFilters: readonly UsageWidgetPageFilter[];
    costBasisOptions: readonly UsageWidgetPageScope['costBasis'][];
    /** The usage read that tells which cost bases exist has not answered yet. */
    costBasisPending: boolean;
    onPeriodChange(period: UsagePeriod): Promise<boolean>;
    onCostBasisChange(costBasis: UsageWidgetPageScope['costBasis']): Promise<boolean>;
    /** The displayed widgets' shared metric; `null` when they differ or none is shown. */
    metric: 'tokens' | 'cost' | null;
    onMetricChange: ((metric: 'tokens' | 'cost') => void) | null;
    metricPending?: boolean;
    testID: string;
  }>,
) {
  const { page } = props;
  const phone = useDeviceType() === 'phone';
  // Scopes fold into the one Filters chooser only on a phone; a desktop keeps one chip per scope and wraps
  // Tokens/Cost and the cost basis onto the trailing edge of a second row when the column is narrow (lab d2filter).
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
          ...(selected.length === 0 && options.length > 1
            ? { count: String(options.length - 1) }
            : {}),
          // The count arrives with the read; its slot is held so the chips beside this one never move.
          ...(selected.length === 0 ? { reserveCount: true } : {}),
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
  const costBasisChoices = props.costBasisPending ? [page.scope.costBasis] : props.costBasisOptions;
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
            selectedId: page.scope.costBasis,
            onChange: (id: string) => {
              void props.onCostBasisChange(id as UsageWidgetPageScope['costBasis']);
            },
            testID: `${props.testID}.costBasis`,
          },
    [page.scope.costBasis, costBasisChoices, props.costBasisPending, props.onCostBasisChange, props.testID],
  );
  const metricTabs = React.useMemo(
    () => [
      { id: 'tokens' as const, label: t('usage.tokens'), disabled: props.metricPending },
      { id: 'cost' as const, label: t('usage.cost'), disabled: props.metricPending },
    ],
    [props.metricPending],
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
      {scopeChooser ? <SelectionListFilterChip filter={scopeChooser} /> : filters.map((filter) => (
        <SelectionListFilterChip key={filter.id} filter={filter} />
      ))}
    </>
  );
  const trailing = (
    <>
      {props.onMetricChange ? (
        <View style={styles.segment}>
          <SegmentedTabBar
            testIDPrefix={`${props.testID}.metric`}
            tabs={metricTabs}
            activeTabId={props.metric ?? 'tokens'}
            onSelectTab={props.onMetricChange}
            segmentSizing="content"
            accessibilityLabel={t('usage.board.page.metricLabel')}
          />
        </View>
      ) : null}
      {costFilter ? <SelectionListFilterChip filter={costFilter} /> : null}
    </>
  );
  const period = (
    <View style={phone ? styles.periodPhone : styles.period}>
      <SegmentedTabBar
        testIDPrefix={`${props.testID}.period`}
        tabs={periodTabs}
        activeTabId={page.period}
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
  if (phone)
    return (
      <View testID={props.testID} style={styles.phone}>
        {period}
        {/* One Filters chip, then Tokens/Cost and the cost basis: the row wraps rather than hiding the
            basis select past the screen edge (a scroller clipped it mid-word at 390). */}
        <View style={styles.phoneChips}>
          {chips}
          {trailing}
        </View>
      </View>
    );
  return (
    <View testID={props.testID} style={styles.bar}>
      {period}
      <View style={styles.rule} />
      <View style={styles.chips}>{chips}</View>
      <View style={styles.grow} />
      {/* What the widgets show and in which money stay together on the trailing edge, even when the bar wraps. */}
      <View style={styles.trailing}>{trailing}</View>
    </View>
  );
}

const SECTION_KEY = '\u0001';

/** Every scope as one section of the phone chooser; a row toggles exactly what its own chip would. */
function UsageScopeSections(props: Readonly<{
  filters: readonly SelectionListFilter[];
  onRequestClose: () => void;
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
      rootStep={step}
      selection={{ kind: 'multiple', selectedIds }}
      onSelect={(id: string) => {
        const [field, option] = id.split(SECTION_KEY);
        props.filters.find(filter => filter.id === field)?.onChange?.(option ?? '');
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
  grow: { flexGrow: 1 },
  segment: { flexShrink: 0 },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s10, marginLeft: 'auto' },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  phone: { gap: theme.space.s10 },
  phoneChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s6,
  },
}));
