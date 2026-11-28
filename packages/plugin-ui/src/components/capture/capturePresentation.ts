import type { DatabaseCaptureEndpointV1, DatabaseCaptureSummaryV1 } from '@happier-dev/plugin-sdk/database';

/** One route's observed window: requests, errors and time, as the capture store counted them (D27 #9). */
export type CaptureEndpointView = Readonly<{
  endpoint: DatabaseCaptureEndpointV1;
  /** errorCount / requestCount; null when nothing was observed (never 0 % for unknown). */
  errorRate: number | null;
  meanMs: number | null;
  /** Share of request time spent waiting on the database. */
  databaseShare: number | null;
}>;

export function projectCaptureEndpoints(
  items: readonly DatabaseCaptureEndpointV1[],
): readonly CaptureEndpointView[] {
  return (
    items
      .map((endpoint) => ({
        endpoint,
        errorRate:
          endpoint.requestCount > 0
            ? endpoint.errorCount / endpoint.requestCount
            : null,
        meanMs:
          endpoint.requestCount > 0
            ? endpoint.totalDurationMs / endpoint.requestCount
            : null,
        databaseShare:
          endpoint.totalDurationMs > 0
            ? Math.min(1, endpoint.databaseTimeMs / endpoint.totalDurationMs)
            : null,
      }))
      // Failing routes lead; then where the time goes.
      .sort(
        (a, b) =>
          Number(b.endpoint.errorCount > 0) -
            Number(a.endpoint.errorCount > 0) ||
          b.endpoint.totalDurationMs - a.endpoint.totalDurationMs,
      )
  );
}

/** "POST /checkout" for a route row. */
export function captureEndpointTitle(
  endpoint: DatabaseCaptureEndpointV1,
): string {
  return `${endpoint.method} ${endpoint.route}`;
}

/** OpenTelemetry severity number ranges, named as the log record states its level. */
export function captureSeverityWord(
  severity: number | null | undefined,
): string {
  if (severity === null || severity === undefined || severity <= 0)
    return 'log';
  if (severity <= 4) return 'trace';
  if (severity <= 8) return 'debug';
  if (severity <= 12) return 'info';
  if (severity <= 16) return 'warn';
  if (severity <= 20) return 'error';
  return 'fatal';
}

/** A log level's tone: an error reads as one, warn is amber, every other level stays quiet. */
export function captureSeverityTone(severity: number | null | undefined): 'danger' | 'warning' | 'secondary' {
  const word = captureSeverityWord(severity);
  return word === 'error' || word === 'fatal' ? 'danger' : word === 'warn' ? 'warning' : 'secondary';
}

/** A log line's own clock, to the millisecond, in the reader's locale. */
export function captureClockOf(locale: string, at: number): string {
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  }).format(at);
}

/**
 * A request's route in its two parts (the quiet method, then the route in identifier type), as every capture surface
 * draws it: list rows, the request's title and its waterfall. A record with no route names itself by its label.
 */
export function requestRouteOf(
  summary: DatabaseCaptureSummaryV1,
): Readonly<{ method: string | null; route: string }> {
  return summary.endpointMethod && summary.endpointRoute
    ? { method: summary.endpointMethod, route: summary.endpointRoute }
    : { method: null, route: requestLabelOf(summary) };
}

export function requestLabelOf(summary: DatabaseCaptureSummaryV1): string {
  if (summary.endpointMethod && summary.endpointRoute)
    return `${summary.endpointMethod} ${summary.endpointRoute}`;
  return summary.shape ?? summary.kind;
}

export function formatCaptureShare(value: number | null, locale?: string): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: value < 0.1 ? 1 : 0,
    minimumFractionDigits: 0,
  }).format(value * 100)}%`;
}
