import type { HappierUiTheme } from '../../environment/types.js';
import { HappierText } from '../text/Text.js';
import { UsageDailyChart } from '../usage/charts/UsageDailyChart.js';
import { UsageRhythmChart } from '../usage/charts/UsageRhythmChart.js';
import { UsagePeriodSummaryBody, UsageFootprintBody, UsageSourceCoverageBody, type UsageFootprintLabels, type UsageSummaryMetric } from '../usage/charts/UsageSummaryPanels.js';
import { UsageBreakdownsBody, type UsageBreakdownBlock } from '../usage/charts/UsageBreakdownsBody.js';
import { UsageOutcomesBody } from '../usage/charts/UsageOutcomesBody.js';
import { UsageRecapBody } from '../usage/charts/UsageRecapBody.js';
import type { PublicUsageChartModels } from '../usage/charts/publicUsageChartModels.js';
import type { PublicProfileUsageBodyProps } from './PublicProfileUsage.js';

export type PublicUsageMetricId = keyof PublicUsageChartModels['summary'];
export type PublicUsageOriginalLabels = Readonly<{
  metrics: Readonly<Record<PublicUsageMetricId, string>>;
  formatMetric: (kind: PublicUsageMetricId, value: number) => string;
  activityLevel: string;
  level: (value: number) => string;
  date: (date: string) => string;
  weekdays: readonly string[];
  clock: (hour: number) => string;
  showValues: string;
  hideValues: string;
  agentMix: string;
  sourceSplit: string;
  source: (execution: 'happier' | 'outside' | 'unknown') => string;
  percent: (share: number) => string;
  coverage: Readonly<{
    title: string; columns: readonly [string, string];
    status: (status: PublicUsageChartModels['coverage']['status']) => string;
    method: (method: PublicUsageChartModels['coverage']['method']) => string;
  }>;
  footprint: UsageFootprintLabels;
  period: string;
}>;

/** Model translation only: original private and public forms consume the same presentation bodies. */
export function publicProfileUsageOriginalBody(props: PublicProfileUsageBodyProps, theme: HappierUiTheme) {
  const { presentation, models, host, testID } = props;
  const labels = host.labels.original;
  if (!labels) return null;
  const coverage = <HappierText variant="meta" tone="secondary">{labels.coverage.status(models.coverage.status)}</HappierText>;
  const metrics = () => Object.entries(models.summary).flatMap(([key, value]) => {
    const kind = key as PublicUsageMetricId;
    // A public figure the period could not record keeps its slot as a dash; the reason is its quiet caption, never the figure.
    return value === undefined ? [] : [{ id: kind, label: labels.metrics[kind],
      ...(value === null ? { value: '—', caption: host.labels.unavailable } : { value: labels.formatMetric(kind, value) }),
      ...(props.figures ? { accessory: props.figures.render(kind), quieted: props.figures.hidden.has(kind) } : {}) } satisfies UsageSummaryMetric];
  });
  const caption = <HappierText variant="micro" tone="secondary">{labels.activityLevel}</HappierText>;
  switch (presentation.widgetId) {
    case 'usage_daily':
      if (!models.sky) return null;
      return <UsageDailyChart theme={theme} testID={testID} gap={theme.spacing.large}
        chart={{ label: labels.activityLevel, size: 'full', width: props.width, showLegend: false, showPeakValue: false,
          summary: labels.activityLevel, valueFormatter: labels.level, unknownLabel: host.labels.unavailable,
          valuesLabel: labels.showValues, valuesCollapseLabel: labels.hideValues,
          series: [{ id: 'levels', label: labels.activityLevel, color: host.paint.accent, points: models.sky.days.map(day => ({
            id: day.date, x: labels.date(day.date), y: day.state === 'unknown' ? null : day.state === 'inactive' ? 0 : day.level ?? null,
          })) }] }} />;
    case 'usage_period_summary': {
      const metricRows = metrics();
      if (!metricRows.length) return null;
      const tokens = metricRows.find(row => row.id === 'tokens');
      // The lead figure carries no label of its own, so it names its unit, as private Usage's summary does.
      const hero = tokens ? { ...tokens, unit: labels.footprint.tokensUnit } : undefined;
      return <UsagePeriodSummaryBody theme={theme} testID={testID} hero={hero}
        stats={metricRows.filter(row => row !== tokens)} coverage={coverage} />;
    }
    case 'usage_footprint':
      return models.footprint ? <UsageFootprintBody theme={theme} testID={testID} labels={labels.footprint}
        {...(models.footprint.accountedTokens === undefined ? {} : { accountedTokens: labels.formatMetric('tokens', models.footprint.accountedTokens) })}
        coverage={coverage} /> : null;
    case 'usage_source_coverage':
      return <UsageSourceCoverageBody theme={theme} testID={testID} label={labels.coverage.title} columns={labels.coverage.columns}
        rows={[{ title: labels.coverage.method(models.coverage.method), label: labels.coverage.status(models.coverage.status) }]} />;
    case 'usage_rhythm': {
      if (presentation.inputs.style !== 'heatmap' && presentation.inputs.style !== 'weekdayHour') return null;
      const days = presentation.inputs.style === 'heatmap' ? models.sky?.days.map(day => {
        // These are calendar coordinates, independent of the viewer's local time zone.
        const instant = Date.parse(`${day.date}T00:00:00Z`);
        const weekday = (new Date(instant).getUTCDay() + 6) % 7;
        const value = day.state === 'unknown' ? null : day.state === 'inactive' ? 0 : day.level ?? null;
        return { id: day.date, row: String(weekday), column: String(instant - weekday * 86_400_000),
          label: `${labels.date(day.date)} · ${labels.activityLevel}`, value,
          valueLabel: value === null ? host.labels.unavailable : labels.level(value) };
      }) : undefined;
      const calendar = days ? {
        label: labels.activityLevel, size: 'full' as const, unknownLabel: host.labels.unavailable,
        rows: labels.weekdays.map((label, index) => ({ id: String(index), label })),
        columns: [...new Set(days.map(day => day.column))].map(id => ({ id, label: '' })),
        cells: days,
      } : undefined;
      const punch = presentation.inputs.style === 'weekdayHour' && models.weekHours ? {
        label: labels.activityLevel, size: 'full' as const, unknownLabel: host.labels.unavailable,
        rows: labels.weekdays.map((label, index) => ({ id: String(index), label })),
        columns: Array.from({ length: 24 }, (_, hour) => ({ id: String(hour), label: labels.clock(hour) })),
        cells: models.weekHours.grid.flatMap((row, weekday) => row.map((value, hour) => ({ id: `${weekday}-${hour}`,
          row: String(weekday), column: String(hour), value, valueLabel: value === null ? host.labels.unavailable : labels.level(value),
          label: `${labels.weekdays[weekday]} ${labels.clock(hour)} · ${labels.activityLevel}` }))),
      } : undefined;
      if (!calendar && !punch) return null;
      const hours = presentation.inputs.style === 'weekdayHour' && models.daylight ? {
        label: labels.activityLevel, series: [{ id: 'levels', label: labels.activityLevel, color: host.paint.accent,
          points: models.daylight.hours.map((value, hour) => ({ id: String(hour), x: labels.clock(hour), y: value })) }],
        variant: 'bar' as const, size: 'full' as const, width: props.width, valueFormatter: labels.level,
        showLegend: false, showPeakValue: false, unknownLabel: host.labels.unavailable,
        valuesLabel: labels.showValues, valuesCollapseLabel: labels.hideValues,
      } : undefined;
      return <UsageRhythmChart theme={theme} testID={testID} width={props.width}
        label={labels.activityLevel} values={{ show: labels.showValues, hide: labels.hideValues, unknownLabel: host.labels.unavailable, valueColumn: labels.activityLevel }}
        spacing={{ body: theme.spacing.large, blocks: theme.spacing.large, block: theme.spacing.small }}
        headings={{ calendar: caption, weekdayHour: caption, byHour: caption }} calendar={calendar} punch={punch}
        hours={presentation.inputs.style === 'weekdayHour' ? hours : undefined} footer={coverage} />;
    }
    case 'usage_breakdowns': {
      if (presentation.inputs.style === 'crew') return null;
      const blocks: UsageBreakdownBlock[] = [];
      if (models.agentMix) blocks.push({ id: 'agent', label: labels.agentMix, total: 1, valueFormatter: labels.percent, unknownLabel: host.labels.unavailable,
        rows: models.agentMix.map(row => ({ id: row.agentId, label: host.agent(row.agentId).name,
          color: host.agent(row.agentId).color, value: row.coverage.method === 'context_only' ? null : row.share })) });
      if (models.sourceShares) blocks.push({ id: 'source', label: labels.sourceSplit, total: 1, valueFormatter: labels.percent, unknownLabel: host.labels.unavailable,
        rows: models.sourceShares.map(row => ({ id: row.execution, label: labels.source(row.execution), value: row.share, color: host.paint.accent })) });
      return blocks.length ? <UsageBreakdownsBody theme={theme} testID={testID} model={{ blocks }} coverage={coverage} /> : null;
    }
    case 'usage_outcomes':
      return presentation.inputs.style !== 'shipped' && typeof models.summary.mergedPrs === 'number'
        ? <UsageOutcomesBody theme={theme} testID={testID} model={{ kind: 'count', count: models.summary.mergedPrs,
          label: labels.metrics.mergedPrs, formatValue: value => labels.formatMetric('mergedPrs', value) }} coverage={coverage} /> : null;
    case 'usage_recap': {
      const kinds = { active_days: 'activeDays', merged_prs: 'mergedPrs', peak_parallel: 'peakParallel' } as const;
      return presentation.inputs.style !== 'personalRecords' && models.highlights?.length ? <UsageRecapBody theme={theme} testID={testID}
        model={{ highlights: models.highlights.map(row => ({ id: row.kind, label: labels.metrics[kinds[row.kind]],
          value: labels.formatMetric(kinds[row.kind], row.count), detail: labels.period })) }} notice={coverage} /> : null;
    }
    default: return null;
  }
}
