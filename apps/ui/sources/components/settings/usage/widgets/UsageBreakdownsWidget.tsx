import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { resolveUsageCostForSelection } from '@happier-dev/protocol/usage/usageCostFacts';
import { type UsageAnalyticsBreakdownDimension, type UsageAnalyticsBreakdownEntry } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import {
  HappierPressable,
  UsageBreakdownsBody,
  type UsageBreakdownBlock,
} from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { t } from '@/text';
import { usageMeterFill } from '../usageAccent';
import { USAGE_BREAKDOWN_DIMENSION_HEADING } from '../usageBreakdownTitle';
import { getAgentIdentityColor } from '@/agents/catalog/catalog';
import { useUsageDrill, type UsageDrillField } from '../usageDrill';
import {
  UsageAgentMark,
  UsageBodyInsufficient,
  UsageCoverageLine,
  usageDimensionLabel,
  usagePeriodPhrase,
  useUsageAnalyticsView,
  useUsagePluginTheme,
  type UsageBodyProps,
  leadingUsageRows,
  UsageShowAllRows,
  UsageBodyNoUsage,
} from './usageBodyKit';
import { useAllMachines } from '@/sync/domains/state/storage';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { usagePageCostRow } from '../usageCostPresentation';
import { UsageCrewBody } from './UsageChartStyleBodies';

const DEFAULT_DIMENSIONS: readonly UsageAnalyticsBreakdownDimension[] = [
  'agent',
  'model',
];

/** The dimensions that are also scope filters: choosing one of their rows narrows to it. */
const DRILL_FIELD: Readonly<
  Partial<Record<UsageAnalyticsBreakdownDimension, UsageDrillField>>
> = {
  agent: 'agents',
  project: 'projects',
  machine: 'machines',
  source: 'sources',
};

/** One body per widget: its Style own-input picks the encoding of the same question. */
export function UsageBreakdownsWidget(props: UsageBodyProps) {
  const style = props.presentation?.style;
  if (style === 'crew') return <UsageCrewBody {...props} />;
  return <UsageBreakdownsWidgetOriginal {...props} />;
}

/**
 * "Breakdowns": the widget's own breakdown dimensions as ranked rows, in the shown metric. Rows are
 * the server's ranked entries; a truncated ranking says so instead of implying the rest is zero.
 */
function UsageBreakdownsWidgetOriginal(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = React.useState<readonly string[]>([]);
  const chartTheme = useUsagePluginTheme();
  const metric = props.query.metric;
  const dimensions = props.query.breakdown.length
    ? props.query.breakdown
    : DEFAULT_DIMENSIONS;
  const machineEntries = props.slice.accounting?.breakdowns?.machine;
  // Rankings consume display names, never daemon runtime/presence. The store's
  // selector retains equal names before those publications reach React.
  const selectedMachineNames = useAllMachines(React.useCallback(machines => {
    if (!dimensions.includes('machine')) return {};
    const listed = new Set(machines.map(machine => machine.id));
    const referenced = new Set((machineEntries ?? []).map(entry => entry.key));
    return Object.fromEntries([...resolveMachineDisplayNames([...machines,
      ...(machineEntries ?? []).filter(entry => !listed.has(entry.key)).map(entry => ({ id: entry.key, absence: 'unlisted' as const }))])]
      .filter(([id]) => referenced.has(id)));
  }, [dimensions, machineEntries]));
  const machineNames = React.useMemo(() => new Map(Object.entries(selectedMachineNames)), [selectedMachineNames]);
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  const drill = useUsageDrill(props.query);
  const view = useUsageAnalyticsView(props.slice, props.query);
  const accounting = metric === 'cost' ? view?.pageCost.accounting : props.slice.accounting;
  const selection = view?.pageCost.selection ?? null;
  const currency = selection?.currency ?? 'USD';
  const valueOf = React.useCallback(
    (entry: UsageAnalyticsBreakdownEntry) =>
      metric === 'cost'
        ? resolveUsageCostForSelection(entry.cost, selection)
        : entry.tokens.total,
    [metric, selection],
  );
  const total = accounting
    ? metric === 'cost'
      ? view?.pageCost.amountUsd ?? null
      : accounting.totals.tokens.total
    : null;
  // One ranked dimension is the card's own title (`readUsageBreakdownsInstanceTitle`); a heading would say it twice.
  const namedByCard = props.query.breakdown.length === 1;
  const blocks = dimensions.flatMap((dimension) => {
    const entries = accounting?.breakdowns?.[dimension];
    if (!entries?.length) return [];
    const rows = [...entries]
      .sort((left, right) => (valueOf(right) ?? -1) - (valueOf(left) ?? -1))
      .map((entry) => ({
        id: entry.key,
        value: valueOf(entry),
        label: usageDimensionLabel(dimension, entry.key, entry.label, machineNames),
        annotation:
          metric === 'cost' ? [formatTokenCount(entry.tokens.total), usagePageCostRow(entry.cost, selection)?.label].filter(Boolean).join(' · ') : undefined,
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
            ? Math.max(0, ranked.totalEntries - rows.length)
            : 0,
      },
    ];
  });
  if (!accounting)
    return <UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />;
  if (blocks.length === 0)
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.noRows`}
        title={t('usage.board.page.breakdownEmptyTitle')}
        reason={t('usage.board.page.breakdownEmptyReason')}
      />
    );
  return (
    <UsageBreakdownsBody theme={chartTheme} spacing={theme.space} testID={`${props.testID}.breakdowns`} model={{ namedByCard,
      blocks: blocks.map((block): UsageBreakdownBlock => {
        const lead = leadingUsageRows(block.rows, expanded.includes(block.dimension));
        return {
            id: block.dimension,
            label: t(USAGE_BREAKDOWN_DIMENSION_HEADING[block.dimension]),
            rows: lead.rows.map((row, index) => ({
              ...row,
              color: block.dimension === 'agent' ? getAgentIdentityColor(theme, row.id) : usageMeterFill(theme, index === 0),
            })),
            total,
            // An unknown value is a quiet dash in the value column, never a bold word (states: unknowns stay quiet).
            unknownLabel: '—',
            testID: `${props.testID}.${block.dimension}`,
            valueFormatter:
              metric === 'cost'
                ? (value) => formatUsageCost(value, currency)
                : formatTokenCount,
            ...(DRILL_FIELD[block.dimension] &&
            drill.available(DRILL_FIELD[block.dimension]!)
              ? {
                  // A row of a scope dimension is a drill: it adds that value to the one filter row.
                  renderIdentity: (row, visual) => {
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
              : {}),
            ...(block.dimension === 'agent'
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
              : {}),
          footer: <UsageShowAllRows label={`${t(`usage.widgets.${props.id}`)}: ${t(USAGE_BREAKDOWN_DIMENSION_HEADING[block.dimension])}`}
            total={block.rows.length} hidden={lead.hidden} complete={block.truncated === 0} expanded={expanded.includes(block.dimension)}
            unlisted={block.truncated > 0 && lead.hidden === 0 ? t('usage.board.page.moreRows', { count: block.truncated }) : null}
            testID={`${props.testID}.${block.dimension}.more`}
            onToggle={() => setExpanded(current => current.includes(block.dimension)
              ? current.filter(entry => entry !== block.dimension) : [...current, block.dimension])} />,
        };
      }) }} coverage={<UsageCoverageLine
        slice={props.slice}
        sources={['accounting']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />} />
  );
}
