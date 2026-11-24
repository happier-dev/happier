import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { TelemetryMetricsReadResultV1 } from '@happier-dev/database-protocol';
import {
  formatTelemetryMetric,
  intervalMetricValue,
  readMetricValue,
  telemetryWidgetMeasure,
  type TelemetryWidgetMetricV1,
} from '@happier-dev/plugins-telemetry/capture-views';
import {
  StackedSeriesChart,
  type HappierSeries,
} from '@happier-dev/plugin-ui/presentation';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import {
  TELEMETRY_CHART_MIN_WIDTH_PX,
  TelemetryChartHead,
} from './TelemetryChartHead';
import {
  telemetryCaptureFailureCode,
  type TelemetryCaptureReads,
} from './telemetryCaptureReads';
import { serviceCheckWindowEnds } from './serviceCheckPresentation';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

type Read =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'empty' }>
  | Readonly<{
      kind: 'ready';
      services: readonly string[];
      service: string;
      http: TelemetryMetricsReadResultV1;
      heap: TelemetryMetricsReadResultV1 | null;
    }>
  | Readonly<{ kind: 'unavailable'; code: string }>;

type Chart = Readonly<{
  metric: TelemetryWidgetMetricV1;
  title: string;
  detail: string | null;
}>;

/**
 * Telemetry → Metrics (P7 J5): one service's request time, traffic and errors from one whole-service read (its
 * intervals carry all three), and its heap from the runtime metric the SDKs report, over the tab's window. The
 * measure and units are the Telemetry widgets' own vocabulary; a metric the runtime does not report says so.
 */
export function TelemetryMetrics(
  props: Readonly<{
    reads: TelemetryCaptureReads;
    active: boolean;
    windowMs: number;
    locale: string;
  }>,
) {
  const { reads, active, windowMs, locale } = props;
  const { theme } = useUnistyles();
  const chartTheme = usePluginUiTheme(theme);
  const [chosen, setChosen] = React.useState<string | null>(null);
  const [read, setRead] = React.useState<Read>({ kind: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const [width, setWidth] = React.useState<number | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  React.useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const until = Date.now();
    const since = until - windowMs;
    (async () => {
      // The services that answered in this window, busiest first (the Endpoints read's own order).
      const endpoints = await reads.endpoints(
        since,
        until,
        null,
        controller.signal,
      );
      const services = [
        ...new Set(
          endpoints.items
            .map((endpoint) => endpoint.serviceName)
            .filter(Boolean),
        ),
      ];
      const service =
        chosen !== null && services.includes(chosen) ? chosen : services[0];
      if (!service) return { kind: 'empty' } as const;
      const [http, heap] = await Promise.all([
        reads.metrics(
          { serviceName: service, measure: telemetryWidgetMeasure('p95') },
          since,
          until,
          controller.signal,
        ),
        reads
          .metrics(
            { serviceName: service, measure: telemetryWidgetMeasure('heap') },
            since,
            until,
            controller.signal,
          )
          .catch(() => null),
      ]);
      return { kind: 'ready', services, service, http, heap } as const;
    })().then(
      (next) => {
        if (!controller.signal.aborted) setRead(next);
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setRead({
            kind: 'unavailable',
            code: telemetryCaptureFailureCode(error),
          });
      },
    );
    return () => controller.abort();
  }, [reads, active, windowMs, chosen, attempt]);

  if (read.kind === 'unavailable') {
    return (
      <SurfaceStateCard
        testID="project-deployments.telemetry.metrics.unavailable"
        kind="unavailable"
        size="line"
        title={t('deploymentTelemetry.metrics.unavailable')}
        diagnosticCode={read.code}
        action={{
          label: t('common.retry'),
          onPress: () => setAttempt((value) => value + 1),
        }}
      />
    );
  }
  if (read.kind === 'empty') {
    return (
      <SurfaceStateCard
        testID="project-deployments.telemetry.metrics.empty"
        kind="empty"
        size="line"
        title={t('deploymentTelemetry.metrics.noService')}
      />
    );
  }
  if (read.kind === 'loading') {
    return (
      <SurfaceStateCard
        testID="project-deployments.telemetry.metrics.reading"
        kind="loading"
        size="line"
        title={t('deploymentTelemetry.metrics.reading')}
      />
    );
  }
  const p50 = read.http.result.measurements?.p50Ms ?? null;
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
  const serviceChoice =
    read.services.length > 1 ? (
      <DropdownMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        items={read.services.map((service) => ({
          id: service,
          title: service,
          testID: `project-deployments.telemetry.metrics.service.${service}`,
        }))}
        matchTriggerWidth={false}
        placement="bottom"
        popoverAccessibilityLabel={t('deploymentTelemetry.metrics.service')}
        onSelect={(id) => {
          setMenuOpen(false);
          setChosen(id);
        }}
        trigger={({ toggle }) => (
          <TextLinkButton
            testID="project-deployments.telemetry.metrics.service"
            label={read.service}
            size="meta"
            onPress={toggle}
          />
        )}
      />
    ) : (
      <Text variant="meta" style={styles.quiet}>
        {read.service}
      </Text>
    );
  return (
    <ItemGroup
      title={t('deploymentTelemetry.metrics.service')}
      action={serviceChoice}
      surface="none"
      testID="project-deployments.telemetry.metrics"
    >
      <View
        style={[styles.charts, twoUp ? styles.chartsRow : null]}
        onLayout={(event) =>
          setWidth(Math.round(event.nativeEvent.layout.width))
        }
      >
        {charts.map((chart) => {
          const source = chart.metric === 'heap' ? read.heap : read.http;
          const value = source ? readMetricValue(chart.metric, source) : null;
          const pick = intervalMetricValue(chart.metric);
          const points =
            source?.trend.map((interval) => ({
              id: JSON.stringify([interval.since, interval.until]),
              x: interval.until,
              y: pick(interval) ?? null,
              // The pointer reads each interval by its clock time, as the check page's trend does.
              label: formatWithCachedDateTimeFormatter(interval.until, locale, { hour: 'numeric', minute: '2-digit' }),
            })) ?? [];
          const first = source?.trend[0];
          const last = source?.trend[source.trend.length - 1];
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
      </View>
    </ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  quiet: { color: theme.colors.text.secondary },
  charts: { gap: theme.space.s16 },
  chartsRow: { flexDirection: 'row', flexWrap: 'wrap' },
  chart: { minWidth: 0, gap: theme.space.s8 },
  chartHalf: { flexBasis: TELEMETRY_CHART_MIN_WIDTH_PX - theme.space.s16 * 2, flexGrow: 1 },
}));
