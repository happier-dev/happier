import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { resolveUsageCostForSelection } from '@happier-dev/protocol/usage/usageCostFacts';
import { compareUsageMeasurementsDescending } from '@happier-dev/protocol/usage/usageAggregation';
import { type UsageAnalyticsBreakdownDimension } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import {
  HappierPressable,
  UsageBreakdownsBody,
  type UsageBreakdownBlock,
} from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption, useWidgetFrameBodyIdentity } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { readUsageAppCallsEnvironmentIds, resolveUsageShownBreakdown } from '@/sync/domains/usage/usageAppCallsSource';
import { formatTokenCount, formatTokenCountLong, formatUsageCost } from '@/utils/format/usageNumbers';
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
  UsageBodyNote,
} from './usageBodyKit';
import { useAllMachines } from '@/sync/domains/state/storage';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { usagePageCostCaption, usagePageCostRow } from '../usageCostPresentation';
import { UsageCrewBody } from './UsageChartStyleBodies';
import { resolveUsageMeasuredTokens } from '@/sync/api/account/usageMeasuredTokens';

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
  // In Your apps the sources are the Environments, and a ranking by agent ranks them (`resolveUsageShownBreakdown`).
  const appsShown = readUsageAppCallsEnvironmentIds(props.query.sources) !== null;
  const dimensions = React.useMemo(() => resolveUsageShownBreakdown(
    props.query.breakdown.length ? props.query.breakdown : DEFAULT_DIMENSIONS, props.query.sources),
  [props.query.breakdown, props.query.sources]);
  const heading = (dimension: UsageAnalyticsBreakdownDimension) => appsShown && dimension === 'source'
    ? t('usage.board.page.filterEnvironments') : t(USAGE_BREAKDOWN_DIMENSION_HEADING[dimension]);
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
  // One ranked dimension is the card's own title (`readUsageBreakdownsInstanceTitle`); a heading would say it twice.
  const namedByCard = props.query.breakdown.length === 1;
  // The card that names Agents or Sources names the Environments it ranks in Your apps; a name the person gave still wins.
  const environmentsTitle = appsShown && namedByCard && dimensions[0] === 'source';
  const identity = React.useMemo(() => environmentsTitle ? { title: t('usage.board.page.filterEnvironments') } : null, [environmentsTitle]);
  useWidgetFrameBodyIdentity(identity);
  const drill = useUsageDrill(props.query);
  const view = useUsageAnalyticsView(props.slice, props.query);
  const accounting = metric === 'cost' ? view?.pageCost.accounting : props.slice.accounting;
  const selection = view?.pageCost.selection ?? null;
  // The money basis is the card's: said once beside its period, and on a row only where that row's differs.
  const basisPhrase = metric === 'cost' && view ? usagePageCostCaption(view.pageCost) ?? null : null;
  useWidgetFrameBodyCaption(basisPhrase ? `${usagePeriodPhrase(props.query)} · ${basisPhrase}` : usagePeriodPhrase(props.query));
  const currency = selection?.currency ?? 'USD';
  const total = accounting
    ? metric === 'cost'
      ? view?.pageCost.amountUsd ?? null
      : resolveUsageMeasuredTokens(accounting.totals.tokens).total
    : null;
  const rowBasis = (label: string | undefined) => label === basisPhrase ? null : label;
  // Token totals added up from their parts are said once under the card when every counted row is (USAGE-ACCEPT 1118 #11),
  // and on a row only where that row differs from the rest.
  const countedRows = dimensions.flatMap(dimension => accounting?.breakdowns?.[dimension] ?? [])
    .map(entry => resolveUsageMeasuredTokens(entry.tokens)).filter(tokens => tokens.total !== null);
  const fromPartsOnce = countedRows.length > 1 && countedRows.every(tokens => tokens.fromParts);
  const rowFromParts = (fromParts: boolean) => fromParts && !fromPartsOnce ? t('usage.board.page.tokensFromParts') : null;
  const blocks = dimensions.flatMap((dimension) => {
    const entries = accounting?.breakdowns?.[dimension];
    if (!entries?.length) return [];
    const rows = entries.map(entry => {
        const tokens = resolveUsageMeasuredTokens(entry.tokens);
        return { entry, tokens, value: metric === 'cost' ? resolveUsageCostForSelection(entry.cost, selection) : tokens.total };
      })
      .filter(({ value }) => dimension !== 'model' || value !== null)
      .sort((left, right) => compareUsageMeasurementsDescending(left.value, right.value))
      .map(({ entry, tokens, value }) => {
        return {
          id: entry.key,
          value,
          label: usageDimensionLabel(dimension, entry.key, entry.label, machineNames),
          annotation:
            // Unknown tokens leave no "—" ahead of the basis (sweep 1110 N5); the basis still says why money is missing.
            metric === 'cost'
              ? [tokens.total === null ? null : formatTokenCount(tokens.total),
                rowFromParts(tokens.fromParts),
                rowBasis(usagePageCostRow(entry.cost, selection)?.label)].filter(Boolean).join(' · ')
              : rowFromParts(tokens.fromParts) ?? undefined,
        };
      });
    if (rows.length === 0) return [];
    const ranked = accounting?.coverage?.ranked.find(
      (row) => row.dimension === dimension,
    );
    return [
      {
        dimension,
        rows,
        truncated:
          ranked && !ranked.complete
            ? Math.max(0, ranked.totalEntries - entries.length)
            : 0,
      },
    ];
  });
  if (!accounting)
    return <UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />;
  // Nothing recorded in the period: the ranking waits for usage, it is not missing a choice.
  if (blocks.length === 0 && accounting.totals.eventCount === 0)
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
            label: heading(block.dimension),
            rows: lead.rows.map((row, index) => ({
              ...row,
              color: block.dimension === 'agent' ? getAgentIdentityColor(theme, row.id) : usageMeterFill(theme, index === 0),
            })),
            total,
            // An unmeasured value is a quiet dash in the figure column; the row's own line says why ("Without an API
            // price"). A bold word there read as the figure (unknowns stay quiet).
            unknownLabel: '—',
            testID: `${props.testID}.${block.dimension}`,
            valueFormatter:
              metric === 'cost'
                ? (value) => formatUsageCost(value, currency)
                : formatTokenCount,
            rowDatums: metric === 'cost' ? undefined : lead.rows.map(row => {
              if (row.value === null) return null;
              const exact = formatTokenCountLong(row.value);
              return formatTokenCount(row.value).includes(exact) ? null : {
                label: row.label, value: `${exact} ${t('usage.board.page.tokensUnit')}`,
              };
            }),
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
          footer: <UsageShowAllRows label={`${t(`usage.widgets.${props.id}`)}: ${heading(block.dimension)}`}
            total={block.rows.length} hidden={lead.hidden} complete={block.truncated === 0} expanded={expanded.includes(block.dimension)}
            unlisted={block.truncated > 0 && lead.hidden === 0 ? t('usage.board.page.moreRows', { count: block.truncated }) : null}
            testID={`${props.testID}.${block.dimension}.more`}
            onToggle={() => setExpanded(current => current.includes(block.dimension)
              ? current.filter(entry => entry !== block.dimension) : [...current, block.dimension])} />,
        };
      }) }} coverage={<>
        {fromPartsOnce ? <UsageBodyNote testID={`${props.testID}.fromParts`}>{t('usage.board.page.tokensFromPartsOnce')}</UsageBodyNote> : null}
        <UsageCoverageLine
          slice={props.slice}
          sources={['accounting']}
          onRetry={props.model.refresh}
          testID={`${props.testID}.coverage`}
        />
      </>} />
  );
}
