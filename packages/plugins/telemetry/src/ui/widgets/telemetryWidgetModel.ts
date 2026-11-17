/**
 * The Telemetry widgets' pure rules: what a bound widget reads, and how a collector answer becomes
 * the numbers and lines it draws. The collector owns values, units and coverage; this module only
 * names them. Missing evidence stays null (drawn "—"), zero stays zero.
 */

import type { TelemetryMetricsReadInputV1, TelemetryMetricsReadResultV1 } from '@happier-dev/database-protocol';
import type { HappierSeries } from '@happier-dev/plugin-ui';

export const TELEMETRY_PLUGIN_ID = 'happier.telemetry';

/** The Environment a widget is bound to, as the `deployments.environments.telemetry` option source writes it. */
export type TelemetryWidgetEnvironmentV1 = Readonly<{
  serverId: string;
  environmentId: string;
}>;

export type TelemetryWidgetMetricV1 =
  | 'p95'
  | 'p50'
  | 'errorRate'
  | 'requests'
  | 'heap';
export type TelemetryWidgetRangeV1 = '24h' | '7d';

const HOUR_MS = 3_600_000;
export const TELEMETRY_WIDGET_RANGE_MS: Readonly<
  Record<TelemetryWidgetRangeV1, number>
> = Object.freeze({
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
});

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The widget's bindings, as the host hands them to the mounted body. Anything unreadable is unbound. */
export function readTelemetryWidgetInputs(launchInput: unknown): Readonly<{
  environment: TelemetryWidgetEnvironmentV1 | null;
  metric: TelemetryWidgetMetricV1;
  range: TelemetryWidgetRangeV1;
}> {
  const input = readRecord(launchInput);
  const environment = readRecord(input?.environment);
  const serverId = readText(environment?.serverId);
  const environmentId = readText(environment?.environmentId);
  const metric = input?.metric;
  return {
    environment: serverId && environmentId ? { serverId, environmentId } : null,
    metric:
      metric === 'p50' ||
      metric === 'errorRate' ||
      metric === 'requests' ||
      metric === 'heap'
        ? metric
        : 'p95',
    range: input?.range === '7d' ? '7d' : '24h',
  };
}

/** The one collector measure each metric reads. Heap is the runtime metric the SDKs report. */
export function telemetryWidgetMeasure(metric: TelemetryWidgetMetricV1): TelemetryMetricsReadInputV1['measure'] {
  if (metric === 'heap') return { kind: 'runtime', metricName: 'v8js.memory.heap.used', statistic: 'latest' };
  return { kind: 'http', statistic: metric };
}

type Measurements = TelemetryMetricsReadResultV1['result']['measurements'];
type Interval = TelemetryMetricsReadResultV1['trend'][number];

function measurementsOf(
  read: TelemetryMetricsReadResultV1,
): NonNullable<Measurements> | null {
  return read.result.measurements ?? null;
}

function secondsOf(
  window: Readonly<{ since: number; until: number }>,
): number | null {
  const seconds = (window.until - window.since) / 1000;
  return seconds > 0 ? seconds : null;
}

/** Requests per second over the read window, from the collector's request count. */
export function readRequestRate(
  read: TelemetryMetricsReadResultV1,
): number | null {
  const measured = measurementsOf(read);
  const seconds = measured
    ? secondsOf(measured.observedWindow ?? measured.window)
    : null;
  return measured?.requestCount === undefined || seconds === null
    ? null
    : measured.requestCount / seconds;
}

export function readP95Ms(read: TelemetryMetricsReadResultV1): number | null {
  return measurementsOf(read)?.p95Ms ?? null;
}

export function readErrorRate(
  read: TelemetryMetricsReadResultV1,
): number | null {
  return measurementsOf(read)?.errorRate ?? null;
}

/** The selected metric's one number for the window. */
export function readMetricValue(
  metric: TelemetryWidgetMetricV1,
  read: TelemetryMetricsReadResultV1,
): number | null {
  if (metric === 'requests') return readRequestRate(read);
  if (metric === 'errorRate') return readErrorRate(read);
  if (metric === 'p95') return readP95Ms(read);
  const measured = measurementsOf(read);
  if (metric === 'p50') return measured?.p50Ms ?? null;
  return measured?.value ?? null;
}

/**
 * A line over the window's intervals. Only metric points arrive as intervals; sampled spans are
 * single requests, so they draw no line rather than a line of ones.
 */
export function readTelemetryWidgetSeries(
  read: TelemetryMetricsReadResultV1,
  id: string,
  pick: (interval: Interval) => number | null | undefined,
): HappierSeries | null {
  if (measurementsOf(read)?.basis !== 'metric_points' || read.trend.length < 2)
    return null;
  return {
    id,
    label: id,
    points: read.trend.map((interval) => ({
      id: JSON.stringify([interval.since, interval.until]),
      x: interval.until,
      y: pick(interval) ?? null,
    })),
  };
}

export const intervalRequestRate = (interval: Interval): number | null => {
  const seconds = secondsOf(interval);
  return interval.count === undefined || seconds === null
    ? null
    : interval.count / seconds;
};
export const intervalP95 = (interval: Interval): number | undefined =>
  interval.p95 ?? interval.value;
export const intervalErrorRate = (interval: Interval): number | undefined =>
  interval.errorRate ?? undefined;

/** The value a metric's line draws per interval: the read's own statistic. */
export function intervalMetricValue(
  metric: TelemetryWidgetMetricV1,
): (interval: Interval) => number | null | undefined {
  if (metric === 'requests') return intervalRequestRate;
  if (metric === 'errorRate') return intervalErrorRate;
  if (metric === 'p50') return (interval) => interval.p50 ?? interval.value;
  if (metric === 'p95') return intervalP95;
  return (interval) => interval.value;
}

/** "412 ms", "1.42 s", "2.4%", "3.3/s", "182 MB"; null is "—". */
export function formatTelemetryMetric(
  metric: TelemetryWidgetMetricV1,
  value: number | null,
  locale: string | undefined,
): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const number = (fractionDigits: number, input: number) =>
    new Intl.NumberFormat(locale, {
      maximumFractionDigits: fractionDigits,
      minimumFractionDigits: 0,
    }).format(input);
  if (metric === 'errorRate')
    return `${number(value < 0.1 ? 1 : 0, value * 100)}%`;
  if (metric === 'requests') return `${number(value < 10 ? 1 : 0, value)}/s`;
  if (metric === 'heap') {
    const megabytes = value / 1_000_000;
    return megabytes >= 1000
      ? `${number(1, megabytes / 1000)} GB`
      : `${number(0, megabytes)} MB`;
  }
  return value >= 1000
    ? `${number(2, value / 1000)} s`
    : `${number(0, value)} ms`;
}

/** "billing-api · Production" from the Environment list's own names; null while either is unknown. */
export function describeTelemetryEnvironment(
  listed: unknown,
  environmentId: string,
): string | null {
  const page = readRecord(listed);
  const items = Array.isArray(page?.items) ? page.items : [];
  const environment =
    items.map(readRecord).find((item) => item?.id === environmentId) ?? null;
  if (!environment) return null;
  const sources = Array.isArray(page?.projectSources)
    ? page.projectSources
    : [];
  const source =
    sources
      .map(readRecord)
      .find((item) => item?.id === environment.projectSourceId) ?? null;
  const parts = [readText(source?.name), readText(environment.name)].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** A route's mean time per request over the window, which the slowest-routes list ranks by. */
export function readEndpointMeanMs(
  endpoint: Readonly<{ requestCount: number; totalDurationMs: number }>,
): number | null {
  return endpoint.requestCount > 0
    ? endpoint.totalDurationMs / endpoint.requestCount
    : null;
}
