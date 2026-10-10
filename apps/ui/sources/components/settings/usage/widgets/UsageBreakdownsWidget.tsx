import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  resolveEffectiveUsageCostUsd,
  type UsageAnalyticsBreakdownDimension,
  type UsageAnalyticsBreakdownEntry,
} from '@happier-dev/protocol';
import {
  HappierPressable,
  RankedRows,
} from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { t } from '@/text';
import { usageMeterFill } from '../usageAccent';
import { getAgentIdentityColor } from '@/agents/catalog/catalog';
import { useUsageDrill, type UsageDrillField } from '../usageDrill';
import {
  UsageAgentMark,
  UsageBodyInsufficient,
  UsageCoverageLine,
  usageAgentTitle,
  usagePeriodPhrase,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';

const DEFAULT_DIMENSIONS: readonly UsageAnalyticsBreakdownDimension[] = [
  'agent',
  'model',
];

const DIMENSION_TITLE: Readonly<
  Record<
    UsageAnalyticsBreakdownDimension,
    | 'usage.board.page.dimensionAgent'
    | 'usage.board.page.dimensionModel'
    | 'usage.board.page.dimensionSession'
    | 'usage.board.page.dimensionProject'
    | 'usage.board.page.dimensionWorkspace'
    | 'usage.board.page.dimensionBackendMode'
    | 'usage.board.page.dimensionSource'
    | 'usage.board.page.dimensionMachine'
  >
> = {
  agent: 'usage.board.page.dimensionAgent',
  model: 'usage.board.page.dimensionModel',
  session: 'usage.board.page.dimensionSession',
  project: 'usage.board.page.dimensionProject',
  workspace: 'usage.board.page.dimensionWorkspace',
  backendMode: 'usage.board.page.dimensionBackendMode',
  source: 'usage.board.page.dimensionSource',
  machine: 'usage.board.page.dimensionMachine',
};

/** The dimensions that are also scope filters: choosing one of their rows narrows to it. */
const DRILL_FIELD: Readonly<
  Partial<Record<UsageAnalyticsBreakdownDimension, UsageDrillField>>
> = {
  agent: 'agents',
  project: 'projects',
  machine: 'machines',
  source: 'sources',
};

/**
 * "Breakdowns": the widget's own breakdown dimensions as ranked rows, in the shown metric. Rows are
 * the server's ranked entries; a truncated ranking says so instead of implying the rest is zero.
 */
export function UsageBreakdownsWidget(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const metric = props.query.metric;
  const dimensions = props.query.breakdown.length
    ? props.query.breakdown
    : DEFAULT_DIMENSIONS;
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  const drill = useUsageDrill(props.query);
  const accounting = props.slice.accounting;
  const currency = accounting?.totals.cost.currency ?? 'USD';
  const valueOf = React.useCallback(
    (entry: UsageAnalyticsBreakdownEntry) =>
      metric === 'cost'
        ? resolveEffectiveUsageCostUsd(entry.cost, props.query.costBasis)
        : entry.tokens.total,
    [metric, props.query.costBasis],
  );
  const total = accounting
    ? metric === 'cost'
      ? resolveEffectiveUsageCostUsd(
          accounting.totals.cost,
          props.query.costBasis,
        )
      : accounting.totals.tokens.total
    : null;
  const blocks = dimensions.flatMap((dimension) => {
    const entries = accounting?.breakdowns?.[dimension];
    if (!entries?.length) return [];
    const rows = [...entries]
      .sort((left, right) => valueOf(right) - valueOf(left))
      .map((entry) => ({
        id: entry.key,
        value: valueOf(entry),
        label:
          dimension === 'agent'
            ? usageAgentTitle(entry.key, entry.label)
            : (entry.label ?? entry.key),
        annotation:
          metric === 'cost' ? formatTokenCount(entry.tokens.total) : undefined,
      }));
    const ranked = accounting?.coverage?.ranked.find(
      (row) => row.dimension === dimension,
    );
    return [
      {
        dimension,
        rows,
        truncated:
          ranked && !ranked.complete
            ? ranked.totalEntries - ranked.returnedEntries
            : 0,
      },
    ];
  });
  if (!accounting)
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.page.noUsageTitle')}
        reason={t('usage.board.page.noUsageReason')}
      />
    );
  if (blocks.length === 0)
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.noRows`}
        title={t('usage.board.page.breakdownEmptyTitle')}
        reason={t('usage.board.page.breakdownEmptyReason')}
      />
    );
  return (
    <View style={styles.body} testID={`${props.testID}.breakdowns`}>
      {blocks.map((block) => (
        <View key={block.dimension} style={styles.block}>
          {blocks.length > 1 ? (
            <Text style={styles.heading} accessibilityRole="header">
              {t(DIMENSION_TITLE[block.dimension])}
            </Text>
          ) : null}
          <RankedRows
            theme={chartTheme}
            label={t(DIMENSION_TITLE[block.dimension])}
            rows={block.rows.map((row, index) => ({
              ...row,
              color: block.dimension === 'agent' ? getAgentIdentityColor(theme, row.id) : usageMeterFill(theme, index === 0),
            }))}
            total={total}
            size="full"
            unknownLabel={t('common.unavailable')}
            testID={`${props.testID}.${block.dimension}`}
            valueFormatter={
              metric === 'cost'
                ? (value) => formatUsageCost(value, currency)
                : formatTokenCount
            }
            {...(DRILL_FIELD[block.dimension] &&
            drill.available(DRILL_FIELD[block.dimension]!)
              ? {
                  // A row of a scope dimension is a drill: it adds that value to the one filter row.
                  renderRow: (row, visual) => {
                    const field = DRILL_FIELD[block.dimension]!;
                    const selected = drill.selected(field, row.id);
                    return (
                      <HappierPressable
                        accessibilityRole="button"
                        testID={`${props.testID}.${block.dimension}.drill.${row.id}`}
                        selected={selected}
                        accessibilityLabel={
                          selected
                            ? t('usage.board.page.drillRemove', {
                                name: row.label,
                              })
                            : t('usage.board.page.drillFilterTo', {
                                name: row.label,
                              })
                        }
                        onPress={() => {
                          drill.toggle(field, row.id);
                        }}
                      >
                        {visual}
                      </HappierPressable>
                    );
                  },
                }
              : {})}
            {...(block.dimension === 'agent'
              ? {
                  leads: Object.fromEntries(
                    block.rows.map((row) => [
                      row.id,
                      <UsageAgentMark
                        key={row.id}
                        agentId={row.id}
                        serverId={props.serverId}
                      />,
                    ]),
                  ),
                }
              : {})}
          />
          {block.truncated > 0 ? (
            <Text style={styles.more}>
              {t('usage.board.page.moreRows', { count: block.truncated })}
            </Text>
          ) : null}
        </View>
      ))}
      <UsageCoverageLine
        slice={props.slice}
        sources={['accounting']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 20 },
  block: { gap: 10 },
  heading: {
    ...Typography.default('semiBold'),
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.text.secondary,
  },
  more: {
    ...Typography.default(),
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.text.tertiary,
  },
}));
