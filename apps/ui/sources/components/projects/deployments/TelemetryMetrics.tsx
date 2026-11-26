import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { PluginUiResourceProjection } from '@happier-dev/plugin-ui/hostApi';
import { useMachineServiceResource } from '@/components/machines/resources/useMachineServiceResource';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import {
  formatTelemetryMetric,
  intervalMetricValue,
  readMetricValue,
  type TelemetryWidgetMetricV1,
} from '@happier-dev/plugins-telemetry/capture-views';
import {
  StackedSeriesChart,
  type HappierSeries,
} from '@happier-dev/plugin-ui/presentation';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import {
  TELEMETRY_CHART_MIN_WIDTH_PX,
  TelemetryChartHead,
} from './TelemetryChartHead';
import {
  readTelemetryCaptureMetricsSnapshot,
  TelemetryCaptureTransportContext,
  type TelemetryMetricsSelection,
  type TelemetryCaptureReads,
} from './telemetryCaptureReads';
import { serviceCheckWindowEnds } from './serviceCheckPresentation';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

const METRICS_PROJECTION: PluginUiResourceProjection<ReturnType<typeof readTelemetryCaptureMetricsSnapshot>> = {
  decode: content => readTelemetryCaptureMetricsSnapshot(content.bytes),
};
/** The version chip's "All versions" choice; a reported version is never empty. */
const ALL_VERSIONS = '';

type Chart = Readonly<{
  metric: TelemetryWidgetMetricV1;
  title: string;
  detail: string | null;
}>;

/** One rolling collector read for the selected Environment, service, version and window. */
export function TelemetryMetrics(props: Readonly<{
  reads: TelemetryCaptureReads;
  lifetime: ServerAccountScopeLifetime | null;
  active: boolean;
  windowMs: number;
  locale: string;
}>) {
  const { reads, lifetime, active, windowMs, locale } = props;
  const { theme } = useUnistyles();
  const chartTheme = usePluginUiTheme(theme);
  const { createResourceClient } = React.useContext(TelemetryCaptureTransportContext);
  const [selection, setSelection] = React.useState<TelemetryMetricsSelection>({});
  const [width, setWidth] = React.useState<number | null>(null);
  const reference = React.useMemo(() => reads.metricsReference(selection, windowMs), [reads, selection, windowMs]);
  const snapshot = useMachineServiceResource({
    accountLifetime: lifetime, reference, targetMachineId: reads.targetMachineId,
    active, follow: true, projection: METRICS_PROJECTION, createClient: createResourceClient,
  });
  const read = snapshot?.value;
  const failure = snapshot?.error;
  const retry = () => { void snapshot?.refresh(); };
  if (!read) {
    return failure ? (
      <SurfaceStateCard testID="project-deployments.telemetry.metrics.unavailable" kind="unavailable" size="line"
        title={t('deploymentTelemetry.metrics.unavailable')} diagnosticCode={failure.code}
        action={{ label: t('common.retry'), onPress: retry }} />
    ) : (
      <SurfaceStateCard testID="project-deployments.telemetry.metrics.reading" kind="loading" size="line"
        title={t('deploymentTelemetry.metrics.reading')} />
    );
  }
  if (!read.metrics || !read.selected) {
    return (
      <SurfaceStateCard testID="project-deployments.telemetry.metrics.empty" kind="empty" size="line"
        title={t('deploymentTelemetry.metrics.noService')} />
    );
  }
  const { http, heap, gc, activeRequests } = read.metrics;
  const { serviceName, serviceVersion } = read.selected;
  const versions = read.services.find(service => service.serviceName === serviceName)?.versions ?? [];
  const p50 = http.result.measurements?.p50Ms ?? null;
  const charts: readonly Chart[] = [
    {
      metric: 'p95',
      title: t('deploymentTelemetry.metrics.duration'),
      detail: t('deploymentTelemetry.metrics.durationDetail', {
        p50: formatTelemetryMetric('p50', p50, locale),
      }),
    },
    {
      metric: 'requests',
      title: t('deploymentTelemetry.metrics.requests'),
      detail: t('deploymentTelemetry.metrics.requestsDetail'),
    },
    {
      metric: 'errorRate',
      title: t('deploymentTelemetry.metrics.errorRate'),
      detail: null,
    },
    {
      metric: 'heap',
      title: t('deploymentTelemetry.metrics.heap'),
      detail: null,
    },
  ];
  const twoUp = width !== null && width >= TELEMETRY_CHART_MIN_WIDTH_PX * 2;
  const color = theme.colors.text.secondary;
  // What the overview shows, as the page's filter chips (lab p7Flows-metrics): the service, then its version.
  const serviceChoice = (
    <SelectionListFilterChip filter={{
      id: 'project-deployments.telemetry.metrics.service', testID: 'project-deployments.telemetry.metrics.service',
      label: t('deploymentTelemetry.metrics.service'), valueLabel: serviceName, selectedId: serviceName,
      ...(read.services.length > 1 ? {
        options: read.services.map(service => ({ id: service.serviceName, label: service.serviceName })),
        onChange: (id: string) => setSelection({ serviceName: id }),
      } : {}),
    }} />
  );
  const allVersions = t('deploymentTelemetry.metrics.allVersions');
  const versionChoice = versions.length > 0 || serviceVersion !== null ? (
    <SelectionListFilterChip filter={{
      id: 'project-deployments.telemetry.metrics.version', testID: 'project-deployments.telemetry.metrics.version',
      label: t('common.version'), valueLabel: serviceVersion ?? allVersions, selectedId: serviceVersion ?? ALL_VERSIONS,
      options: [{ id: ALL_VERSIONS, label: allVersions }, ...versions.map(version => ({ id: version, label: version }))],
      onChange: (id: string) => setSelection({ serviceName, ...(id === ALL_VERSIONS ? {} : { serviceVersion: id }) }),
    }} />
  ) : null;
  return (
    <ItemGroup surface="none" testID="project-deployments.telemetry.metrics">
      <View style={styles.selection}>{serviceChoice}{versionChoice}</View>
      {failure || snapshot?.freshness === 'stale' ? (
        <SurfaceFreshnessLine reason={failure?.message ?? t('common.unavailable')}
          action={{ label: t('common.retry'), onPress: retry }} />
      ) : null}
      <View
        style={[styles.charts, twoUp ? styles.chartsRow : null]}
        onLayout={(event) =>
          setWidth(Math.round(event.nativeEvent.layout.width))
        }
      >
        {charts.map((chart) => {
          const source = chart.metric === 'heap' ? heap : http;
          const value = readMetricValue(chart.metric, source);
          const pick = intervalMetricValue(chart.metric);
          const points =
            source.trend.map((interval) => ({
              id: JSON.stringify([interval.since, interval.until]),
              x: interval.until,
              y: pick(interval) ?? null,
              // The pointer reads each interval by its clock time, as the check page's trend does.
              label: formatWithCachedDateTimeFormatter(interval.until, locale, { hour: 'numeric', minute: '2-digit' }),
            }));
          const first = source.trend[0];
          const last = source.trend.at(-1);
          const series: HappierSeries = {
            id: chart.metric,
            label: chart.title,
            color,
            points,
          };
          const drawn = points.filter((point) => point.y !== null).length >= 2;
          const unreported =
            chart.metric === 'heap' && value === null && !drawn;
          return (
            <View
              key={chart.metric}
              style={[styles.chart, twoUp ? styles.chartHalf : null]}
              testID={`project-deployments.telemetry.metrics.${chart.metric}`}
            >
              <TelemetryChartHead
                title={chart.title}
                latest={formatTelemetryMetric(chart.metric, value, locale)}
                detail={
                  unreported
                    ? t('deploymentTelemetry.metrics.heapNotReported')
                    : chart.detail
                }
              />
              {drawn ? (
                <StackedSeriesChart
                  theme={chartTheme}
                  label={chart.title}
                  series={[series]}
                  variant="line"
                  size="full"
                  showLegend={false}
                  showReadout={false}
                  valueFormatter={(y: number) =>
                    formatTelemetryMetric(chart.metric, y, locale)
                  }
                  {...(first && last ? { axisTicks: serviceCheckWindowEnds(first.since, last.until, Date.now()) } : {})}
                />
              ) : null}
            </View>
          );
        })}
        {([
          ['gc', t('deploymentTelemetry.metrics.gc'), gc.result],
          ['activeRequests', t('deploymentTelemetry.metrics.activeRequests'), activeRequests.result],
        ] as const).map(([id, title, result]) => {
          const measurement = result.status === 'unknown' ? undefined : result.measurements;
          const value = measurement?.value;
          return <View key={id} style={[styles.chart, twoUp ? styles.chartHalf : null]}
            testID={`project-deployments.telemetry.metrics.${id}`}>
            <TelemetryChartHead title={title} latest={value === undefined ? '—'
              : `${value.toLocaleString(locale)}${id === 'gc' && measurement?.unit ? ` ${measurement.unit}` : ''}`}
              detail={value === undefined ? t('deploymentTelemetry.metrics.notReported') : null} />
          </View>;
        })}
      </View>
    </ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The chips choose what the charts below show; the charts start a step below them.
  selection: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s8, marginBottom: theme.space.s16 },
  charts: { gap: theme.space.s16 },
  chartsRow: { flexDirection: 'row', flexWrap: 'wrap' },
  chart: { minWidth: 0, gap: theme.space.s8 },
  chartHalf: { flexBasis: TELEMETRY_CHART_MIN_WIDTH_PX - theme.space.s16 * 2, flexGrow: 1 },
}));
