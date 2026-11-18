/**
 * Pure projections of the capture reads (`capture/*`) the Telemetry views draw: the Environment page's
 * Endpoints, Traces, Logs and Queries, and a captured request's detail. Telemetry owns the capture data,
 * so it owns these projections; every consumer draws the same rows from the same answers.
 */

import type {
  DatabaseCaptureEndpointV1,
  DatabaseCaptureSummaryV1,
} from '@happier-dev/database-protocol';

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

/** A request failed when its server answered 5xx or its span says so. */
export function captureSummaryFailed(
  summary: DatabaseCaptureSummaryV1,
): boolean {
  return (summary.httpStatusCode ?? 0) >= 500 || summary.outcome === 'error';
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

/** What a request's step was: a database query, a call out of the app (span kind client), or work in the app. */
export function captureStepKind(row: Readonly<{ kind: 'request' | 'span' | 'query'; spanKind: number | null }>): 'query' | 'external' | 'app' {
  if (row.kind === 'query') return 'query';
  return row.spanKind === 3 ? 'external' : 'app';
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
