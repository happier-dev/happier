import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { StackedSeriesChart, type HappierSeries } from '@happier-dev/plugin-ui/presentation';
import type { TelemetryKeyFlowConfigV1, TelemetryMetricsReadResultV1 } from '@happier-dev/database-protocol';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

import { formatServiceCheckLatency, type ServiceCheckCollectorTrend } from './serviceCheckPresentation';
import { serviceCheckCollectorLatency, useServiceCheckCollectorTrend } from './useServiceCheckCollectorTrend';

const m = 'projects.deployments.monitoring' as const;
/** The narrowest a trend reads beside its sibling; below it the two stack (a details pane, a phone). */
const CHART_MIN_WIDTH_PX = 280;

const formatClock = (ms: number) =>
  formatWithCachedDateTimeFormatter(ms, getPreferredLanguage(), { hour: 'numeric', minute: '2-digit' });
const formatPercent = (fraction: number) =>
  new Intl.NumberFormat(getPreferredLanguage(), { style: 'percent', maximumFractionDigits: 1 }).format(fraction);
const formatCount = (count: number) => new Intl.NumberFormat(getPreferredLanguage()).format(count);

type Interval = TelemetryMetricsReadResultV1['trend'][number];

/** The latency statistic a chart names ("p95"), from the saved flow. */
function latencyWord(config: TelemetryKeyFlowConfigV1): string {
  return config.measure.kind === 'route' && config.measure.statistic === 'p50' ? 'p50' : 'p95';
}

/**
 * A Key flow check's own section on its check page (J5, D33): its p95 and error-rate trend over the last 24 hours and
 * its routes, all from one read of the collector that runs it. Its bars, uptime and recent results stay the persisted
 * check results above and below; nothing here is a second check history.
 */
export function ServiceCheckKeyFlowSection(props: Readonly<{
  scope: Readonly<{ serverId: string; accountId: string }>;
  trend: ServiceCheckCollectorTrend;
  collectorLabel: string | null;
  failing: boolean;
}>) {
  const { theme } = useUnistyles();
  const pluginTheme = usePluginUiTheme(theme);
  const read = useServiceCheckCollectorTrend(props.scope, props.trend);
  const [width, setWidth] = React.useState<number | null>(null);
  const config = props.trend.config;
  const threshold = config.threshold;
  const routeFlow = config.measure.kind === 'route';
  const errorsMeasured = config.measure.kind === 'route' && config.measure.statistic === 'errorRate';
  const source = props.collectorLabel
    ? t(`${m}.keyFlowSource`, { machine: props.collectorLabel })
    : t(`${m}.keyFlowSourceAnywhere`);
  const color = theme.colors.text.secondary;
  const charts = React.useMemo(() => {
    if (read.kind !== 'ready') return null;
    const point = (interval: Interval, y: number | null) => ({ id: JSON.stringify([interval.since, interval.until]), x: interval.until, y,
      label: formatClock(interval.until) });
    const latency: HappierSeries = { id: 'latency', label: config.measure.kind === 'runtime' ? config.measure.metricName
      : t(`${m}.keyFlowLatency`, { statistic: latencyWord(config) }), color,
      points: read.read.trend.map((interval) => point(interval, serviceCheckCollectorLatency(config, interval))) };
    const errors: HappierSeries = { id: 'errors', label: t(`${m}.keyFlowErrors`), color,
      points: read.read.trend.map((interval) => point(interval, interval.errorRate ?? null)) };
    return { latency, errors };
  }, [color, config, read]);
  const limitLabel = t(`${m}.keyFlowLimit`);
  const routes = read.kind === 'ready' ? read.read.routes : [];
  const twoUp = width !== null && width >= CHART_MIN_WIDTH_PX * 2;
  return (
    <>
      <ItemGroup title={t(`${m}.keyFlowTrend`, { statistic: latencyWord(config) })} surface="none" testID="services.check.keyFlow.trend"
        action={<Text variant="meta" style={styles.caption}>{source}</Text>}>
        {read.kind === 'loading' || read.kind === 'idle' ? (
          <SurfaceStateCard kind="loading" size="line" title={t(`${m}.keyFlowReading`)} testID="services.check.keyFlow.loading" />
        ) : read.kind === 'unavailable' ? (
          <SurfaceStateCard kind="unavailable" size="line" title={t(`${m}.keyFlowUnavailable`)} testID="services.check.keyFlow.unavailable" />
        ) : charts ? (
          <View style={[styles.charts, twoUp ? styles.chartsRow : null]} onLayout={(event) => setWidth(Math.round(event.nativeEvent.layout.width))}>
            <View style={styles.chart} testID="services.check.keyFlow.latency">
              <StackedSeriesChart theme={pluginTheme} label={charts.latency.label} series={[charts.latency]} variant="line" size="full"
                showLegend={false} {...(routeFlow ? { valueFormatter: formatServiceCheckLatency } : {})} unknownLabel={t(`${m}.keyFlowNoRequests`)}
                {...(!errorsMeasured ? { threshold: { value: threshold.value, label: limitLabel, tone: props.failing ? 'error' : 'warning' } } : {})} />
            </View>
            {routeFlow ? (
              <View style={styles.chart} testID="services.check.keyFlow.errors">
                <StackedSeriesChart theme={pluginTheme} label={charts.errors.label} series={[charts.errors]} variant="line" size="full"
                  showLegend={false} valueFormatter={formatPercent} unknownLabel={t(`${m}.keyFlowNoRequests`)}
                  {...(errorsMeasured ? { threshold: { value: threshold.value, label: limitLabel, tone: props.failing ? 'error' : 'warning' } } : {})} />
              </View>
            ) : null}
          </View>
        ) : null}
      </ItemGroup>
      {routes.length > 0 ? (
        <ItemGroup title={t(`${m}.keyFlowRoutes`)} testID="services.check.keyFlow.routes"
          action={<Text variant="meta" style={styles.caption}>{t(`${m}.keyFlowRoutesWindow`)}</Text>}>
          {routes.map((route) => {
            const measured = route.result.measurements;
            const requests = measured?.requestCount;
            return (
              <Item
                key={`${route.method} ${route.route}`}
                testID={`services.check.keyFlow.route.${route.method} ${route.route}`}
                title={<Text style={styles.route} numberOfLines={1}>{`${route.method} ${route.route}`}</Text>}
                subtitle={requests === undefined || requests === 0 ? t(`${m}.keyFlowNoRequests`) : [
                  t(`${m}.keyFlowRequests`, { count: requests, formatted: formatCount(requests) }),
                  measured?.errorRate === undefined ? null : t(`${m}.keyFlowErrorShare`, { percent: formatPercent(measured.errorRate) }),
                ].filter(Boolean).join(' · ')}
                detail={measured?.p95Ms === undefined ? '—' : formatServiceCheckLatency(measured.p95Ms)}
                mode="info"
              />
            );
          })}
        </ItemGroup>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  caption: { color: theme.colors.text.secondary },
  charts: { gap: theme.space.s16 },
  chartsRow: { flexDirection: 'row' },
  chart: { flex: 1, minWidth: 0 },
  route: { ...Typography.mono(), color: theme.colors.text.primary },
}));
