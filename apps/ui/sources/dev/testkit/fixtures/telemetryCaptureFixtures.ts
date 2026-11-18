import type { TelemetryCaptureInvoke } from '@/components/projects/deployments/telemetryCaptureReads';

/**
 * A collector's answers for one Environment's Telemetry tab (lab p7Flows-mark / p7AddNow-trace): billing-api's routes,
 * a failed checkout request with its steps and logs, recent log lines and statements. Specimens hand this to
 * `TelemetryCaptureInvokeContext` in place of the Action front door; `offline` answers the first Endpoints read, then
 * nothing.
 */
const NOW = Date.UTC(2026, 10, 17, 19, 48, 12);
const SECOND = 1000;

const endpoint = (
  method: string,
  route: string,
  requestCount: number,
  errorCount: number,
  meanMs: number,
  databaseShare: number,
  serviceName = 'billing-api',
) => ({
  serviceName,
  method,
  route,
  requestCount,
  errorCount,
  errorRate: errorCount / requestCount,
  totalDurationMs: requestCount * meanMs,
  databaseTimeMs: requestCount * meanMs * databaseShare,
});

const ENDPOINTS = [
  endpoint('POST', '/checkout', 4812, 116, 412, 0.38),
  endpoint('GET', '/invoices/:id', 18420, 0, 96, 0.61),
  endpoint('GET', '/api/cart', 9104, 27, 41, 0.22),
  endpoint('POST', '/api/assist/summarize', 1640, 10, 2840, 0.02),
  endpoint('POST', '/webhooks/stripe', 2201, 0, 22, 0.48, 'billing-worker'),
  endpoint('GET', '/reports/:id', 312, 0, 1210, 0.83),
  endpoint('PATCH', '/subscriptions/:id', 140, 0, 64, 0.57),
];

const worktree = 'environment:environment-staging';
const span = (
  id: string,
  at: number,
  durationMs: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  worktree,
  kind: 'span' as const,
  source: 'otlp' as const,
  at,
  durationMs,
  traceId: 'trace-checkout',
  spanId: id,
  serviceName: 'billing-api',
  ...extra,
});
const query = (
  id: string,
  at: number,
  durationMs: number,
  parentSpanId: string,
  shape: string,
) => ({
  id,
  worktree,
  kind: 'query' as const,
  source: 'otlp' as const,
  at,
  durationMs,
  traceId: 'trace-checkout',
  parentSpanId,
  serviceName: 'billing-api',
  shape,
  statementKind: 'select' as const,
});
const log = (
  id: string,
  at: number,
  severityNumber: number,
  bodyPrefix: string,
  bodyPrefixTruncated = false,
) => ({
  id,
  worktree,
  kind: 'log' as const,
  source: 'otlp' as const,
  at,
  traceId: 'trace-checkout',
  serviceName: 'billing-api',
  severityNumber,
  bodyPrefix,
  bodyPrefixTruncated,
});

const CHECKOUT = span('root', NOW, 412, {
  spanKind: 2,
  endpointMethod: 'POST',
  endpointRoute: '/checkout',
  httpStatusCode: 500,
  outcome: 'error',
});
const CHECKOUT_TRACE = [
  CHECKOUT,
  span('auth', NOW + 2, 9, { parentSpanId: 'root', shape: 'auth · session' }),
  query('q-carts', NOW + 12, 6, 'root', 'SELECT * FROM carts WHERE id = $1'),
  query(
    'q-customers',
    NOW + 19,
    4,
    'root',
    'SELECT * FROM customers WHERE id = $1',
  ),
  span('stripe', NOW + 25, 318, {
    parentSpanId: 'root',
    shape: 'stripe.paymentIntents.create',
    spanKind: 3,
  }),
  span('receipt', NOW + 345, 58, {
    parentSpanId: 'root',
    shape: 'buildReceipt',
    outcome: 'error',
  }),
  query(
    'q-plans',
    NOW + 350,
    3,
    'receipt',
    'SELECT plan, price FROM plans WHERE id = $1',
  ),
  query('q-commit', NOW + 405, 1, 'root', 'COMMIT'),
  log('log-1', NOW + 104, 9, 'checkout start cart=c_8812'),
  log('log-2', NOW + 441, 13, 'customer cus_311 has no billing profile'),
  log(
    'log-3',
    NOW + 516,
    17,
    "TypeError: Cannot read properties of undefined (reading 'total')",
    true,
  ),
];

const TRACES = [
  CHECKOUT,
  span('r2', NOW - 14 * SECOND, 88, {
    spanKind: 2,
    endpointMethod: 'GET',
    endpointRoute: '/invoices/:id',
    httpStatusCode: 200,
    traceId: 'trace-2',
  }),
  span('r3', NOW - 31 * SECOND, 43, {
    spanKind: 2,
    endpointMethod: 'GET',
    endpointRoute: '/api/cart',
    httpStatusCode: 200,
    traceId: 'trace-3',
  }),
  span('r4', NOW - 52 * SECOND, 2910, {
    spanKind: 2,
    endpointMethod: 'POST',
    endpointRoute: '/api/assist/summarize',
    httpStatusCode: 200,
    traceId: 'trace-4',
  }),
  span('r5', NOW - 75 * SECOND, 21, {
    spanKind: 2,
    endpointMethod: 'POST',
    endpointRoute: '/webhooks/stripe',
    httpStatusCode: 200,
    traceId: 'trace-5',
    serviceName: 'billing-worker',
  }),
  span('r6', NOW - 98 * SECOND, 1180, {
    spanKind: 2,
    endpointMethod: 'GET',
    endpointRoute: '/reports/:id',
    httpStatusCode: 200,
    traceId: 'trace-6',
  }),
];

const LOGS = [
  log(
    'l-1',
    NOW + 516,
    17,
    "TypeError: Cannot read properties of undefined (reading 'total') at formatTotal (receipt.ts:42)",
  ),
  log('l-2', NOW + 441, 13, 'customer cus_311 has no billing profile'),
  log('l-3', NOW + 104, 9, 'checkout start cart=c_8812'),
  log('l-4', NOW - 14 * SECOND, 9, 'invoice inv_2041 rendered in 88 ms'),
  log(
    'l-5',
    NOW - 75 * SECOND,
    9,
    'stripe webhook payment_intent.succeeded pi_3Q8 handled',
  ),
];

const QUERIES = [
  query('s-1', NOW + 405, 1, 'root', 'COMMIT'),
  query(
    's-2',
    NOW + 350,
    3,
    'receipt',
    'SELECT plan, price FROM plans WHERE id = $1',
  ),
  query('s-3', NOW + 19, 4, 'root', 'SELECT * FROM customers WHERE id = $1'),
  query('s-4', NOW + 12, 6, 'root', 'SELECT * FROM carts WHERE id = $1'),
  query(
    's-5',
    NOW - 14 * SECOND,
    12,
    'r2',
    'SELECT * FROM invoice_lines WHERE invoice_id = $1',
  ),
];

export type TelemetryCaptureFixtureState = 'populated' | 'offline';

export function createTelemetryCaptureFixtureInvoke(
  state: TelemetryCaptureFixtureState,
): TelemetryCaptureInvoke {
  // `offline`: the collector answered once (the Endpoints the tab opens on), then stopped answering, so the tab shows
  // both offline states: retained rows under the freshness strip, and a list it never read.
  let answered = false;
  return async ({ actionId, input }) => {
    if (state === 'offline') {
      if (answered || !actionId.endsWith('/capture/endpoints/list'))
        throw Object.assign(new Error('machine_offline'), { code: 'machine_offline' });
      answered = true;
    }
    const source = (input as { source?: unknown }).source;
    if (actionId.endsWith('/capture/endpoints/list'))
      return { ok: true, source, items: ENDPOINTS };
    if (actionId.endsWith('/capture/traces/list'))
      return { ok: true, source, items: TRACES };
    if (actionId.endsWith('/capture/logs/list'))
      return { ok: true, source, items: LOGS };
    if (actionId.endsWith('/capture/queries/list'))
      return { ok: true, source, items: QUERIES };
    if (actionId.endsWith('/capture/trace/get'))
      return {
        ok: true,
        source,
        traceId: 'trace-checkout',
        summaries: CHECKOUT_TRACE,
        repeatedQueries: [],
        slowChildSpans: [],
        logCorrelations: [],
      };
    if (actionId.endsWith('/capture/query/get'))
      return {
        ok: true,
        source,
        detail: {
          body: "TypeError: Cannot read properties of undefined (reading 'total')\n    at formatTotal (receipt.ts:42:18)\n    at buildReceipt (receipt.ts:88:5)",
        },
      };
    if (actionId.endsWith('/capture/clear')) return { ok: true };
    throw new Error(`Unexpected collector read ${actionId}`);
  };
}
