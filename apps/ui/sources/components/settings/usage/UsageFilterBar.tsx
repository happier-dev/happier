import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import type { SelectionListFilter } from '@/components/ui/selectionList/_types';
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
    estimated: 'usage.board.page.costBasisEstimated' } as const;

/**
 * The page's one filter bar (lab `d2filter`): period, then each scope slot the widgets follow, then
 * the displayed widgets' own Tokens/Cost and the cost basis slot. Every control writes the mounted
 * page context or the widgets' inputs through their owners; it reads no usage of its own.
 */
export function UsageFilterBar(
  props: Readonly<{
    page: UsageWidgetPageContextState;
    slices: readonly UsageQueryResultSlice[];
    scopeFilters: readonly UsageWidgetPageFilter[];
    costBasisOptions: readonly UsageWidgetPageScope['costBasis'][];
    /** The displayed widgets' shared metric; `null` when they differ or none is shown. */
    metric: 'tokens' | 'cost' | null;
    onMetricChange: ((metric: 'tokens' | 'cost') => void) | null;
    testID: string;
  }>,
) {
  const { page } = props;
  const phone = useDeviceType() === 'phone';
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
  const coverageIncomplete = React.useMemo(
    () =>
      props.slices.some((slice) =>
        slice.sources.some(
          (source) =>
            source.source === 'accounting' &&
            source.status !== 'available' &&
            source.status !== 'unsupported',
        ) || (slice.accounting?.coverage?.sources ?? []).some(
          (source) => source.status === 'partial' || source.status === 'pending' || source.status === 'error',
        ),
      ),
    [props.slices],
  );
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
          options: options.map(option => ({
              ...option,
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
  const costFilter = React.useMemo(
    (): SelectionListFilter | null =>
      props.costBasisOptions.length < 2
        ? null
        : {
            id: 'costBasis',
            label: t('usage.costMode'),
            options: props.costBasisOptions.map((option) => ({
              id: option,
              label: t(COST_BASIS_TITLE[option]),
            })),
            selectedId: page.scope.costBasis,
            onChange: (id: string) => {
              page.setScope({
                costBasis: id as UsageWidgetPageScope['costBasis'],
              });
            },
            testID: `${props.testID}.costBasis`,
          },
    [page, props.costBasisOptions, props.testID],
  );
  const metricTabs = React.useMemo(
    () => [
      { id: 'tokens' as const, label: t('usage.tokens') },
      { id: 'cost' as const, label: t('usage.cost') },
    ],
    [],
  );
  const chips = (
    <>
      {filters.map((filter) => (
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
            compact
            slidingThumb
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
          page.setPeriod(period);
        }}
        compact
        slidingThumb
        accessibilityLabel={t('usage.board.page.periodLabel')}
      />
    </View>
  );
  if (phone)
    return (
      <View testID={props.testID} style={styles.phone}>
        {period}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.phoneChips}
        >
          {chips}
          {trailing}
        </ScrollView>
      </View>
    );
  return (
    <View testID={props.testID} style={styles.bar}>
      {period}
      <View style={styles.rule} />
      <View style={styles.chips}>{chips}</View>
      <View style={styles.grow} />
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    rowGap: 8,
    paddingVertical: 4,
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
    gap: 6,
  },
  grow: { flexGrow: 1 },
  segment: { flexShrink: 0 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  phone: { gap: 10 },
  phoneChips: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingRight: 16,
  },
}));
