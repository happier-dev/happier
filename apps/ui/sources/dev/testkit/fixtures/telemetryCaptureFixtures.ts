import * as React from 'react';
import type { DatabaseCaptureCoverageV1 } from '@happier-dev/database-protocol';
import type { PluginUiResourceClient } from '@happier-dev/plugin-ui/advanced';
import { computeSha256HexDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { projectTelemetryCaptureResourceDemandV1 } from '@happier-dev/protocol/daemon/machineServiceLogsResource';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { MachineResourceClientFactory } from '@/components/machines/resources/useMachineServiceResource';
import { TelemetryCaptureTransportContext, type TelemetryCaptureActionId, type TelemetryCaptureInvoke } from '@/components/projects/deployments/telemetryCaptureReads';

/**
 * A collector's answers for one Environment's Telemetry tab (lab p7Flows-mark / p7AddNow-trace): billing-api's routes,
 * a failed checkout request with its steps and logs, recent log lines and statements. Specimens hand this to
 * `TelemetryCaptureFixtureProvider` in place of the Action front door; `offline` answers the first Endpoints read, then
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

const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** The app's own model calls (lab p7Cost-env): each a retained span with the model and token fields the collector kept. */
const llmCall = (id: string, at: number, durationMs: number, modelId: string, provider: string, input: number, output: number,
  reported: number | null) => span(id, at, durationMs, {
  traceId: 'trace-checkout', spanKind: 3, shape: `chat ${modelId}`, serviceVersion: 'v1.43',
  genAi: { provider, modelId, requestedModel: modelId, operation: 'chat',
    tokens: { input, output, total: input + output, reasoning: null, cacheRead: null, cacheWrite: null }, tokenCategories: null,
    reportedCost: reported === null ? null : { amount: reported, currency: 'USD' } },
});
const LLM_CALLS = [
  llmCall('m-1', NOW - 40 * SECOND, 2840, 'gpt-5-mini', 'openai', 9800, 1300, null),
  llmCall('m-2', NOW - 3 * MINUTE, 1920, 'claude-haiku-4.5', 'anthropic', 12400, 2100, 0.0229),
  llmCall('m-3', NOW - 7 * MINUTE, 120, 'text-embedding-3-small', 'openai', 820, 0, null),
  llmCall('m-4', NOW - 12 * MINUTE, 3400, 'gpt-5-mini', 'openai', 14200, 2600, null),
  llmCall('m-5', NOW - 26 * MINUTE, 4100, 'llama-3.3-70b', 'groq', 6100, 1900, null),
];
/**
 * A day of the app's model calls (lab p7Cost-env), hour by hour and per route and model: summarize on two models, search
 * embeddings, invoice explanations, and one translate route on a model the catalog has no price for.
 */
const COST_ROUTES = [
  ['POST', '/api/assist/summarize', 'gpt-5-mini', 'openai', 1640, 15_000_000, 3_200_000, null],
  ['POST', '/api/assist/summarize', 'claude-haiku-4.5', 'anthropic', 410, 5_200_000, 900_000, 61.2],
  ['POST', '/api/search', 'text-embedding-3-small', 'openai', 45_900, 9_600_000, 0, null],
  ['POST', '/api/invoices/:id/explain', 'gpt-5-mini', 'openai', 212, 1_400_000, 500_000, null],
  ['POST', '/api/assist/translate', 'llama-3.3-70b', 'groq', 48, 900_000, 300_000, null],
] as const;
/** The day's hourly weight: quiet nights, a working-day swell and the evening's release. */
const hourWeight = (hour: number) => 0.4 + 0.6 * Math.sin(Math.PI * Math.max(0, hour - 5) / 18) ** 2 + (hour >= 18 ? 0.25 : 0);
const HOUR_WEIGHTS = Array.from({ length: 24 }, (_, hour) => hourWeight(hour));
const HOUR_WEIGHT_TOTAL = HOUR_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
const COSTS = COST_ROUTES.flatMap(([method, path, modelId, provider, calls, input, output, reported]) =>
  HOUR_WEIGHTS.map((weight, hour) => {
    const share = weight / HOUR_WEIGHT_TOTAL;
    const inTokens = Math.round(input * share), outTokens = Math.round(output * share);
    const bucketStartMs = NOW - (24 - hour) * HOUR;
    return {
      bucketStartMs, route: { method, path }, provider, modelId, requestedModel: modelId, operation: 'chat',
      callCount: Math.max(1, Math.round(calls * share)),
      tokens: { input: inTokens, output: outTokens, total: inTokens + outTokens, reasoning: null, cacheRead: null, cacheWrite: null },
      // The SDK reports input and output separately, so Usage can price each call.
      tokenCategories: { input: inTokens, output: outTokens, total: inTokens + outTokens, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      reportedCost: reported === null ? null : { amount: Math.round(reported * share * 10_000) / 10_000, currency: 'USD' },
      firstSeenMs: bucketStartMs + 2 * MINUTE, lastSeenMs: bucketStartMs + HOUR - 40 * SECOND,
    };
  }));
const COST_CALLS = COST_ROUTES.reduce((sum, route) => sum + route[4], 0);
const COST_REPORTED_CALLS = COST_ROUTES.reduce((sum, route) => sum + (route[7] === null ? 0 : route[4]), 0);

/** The Home's price catalog for those models, as Usage reads it; the translate route's model has no price. */
export const TELEMETRY_FIXTURE_PRICE_CATALOG = {
  v: 1,
  models: {
    'gpt-5-mini': { inputUsdPerMillion: 0.25, outputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.025, cacheWriteUsdPerMillion: 0.25 },
    'claude-haiku-4.5': { inputUsdPerMillion: 1, outputUsdPerMillion: 5, cacheReadUsdPerMillion: 0.1, cacheWriteUsdPerMillion: 1.25 },
    'text-embedding-3-small': { inputUsdPerMillion: 0.02, outputUsdPerMillion: 0, cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0 },
  },
  provenance: { source: 'litellm', origin: 'fetched', asOfMs: NOW - 12 * 24 * HOUR, revision: 'catalog-fixture', fetchStatus: 'ready' },
} as const;

/** A day of the service's hourly intervals (lab p7Flows-metrics): request time stepping up after the 18:40 deploy. */
function metricTrend(pick: (hour: number) => Readonly<Record<string, number>>) {
  return Array.from({ length: 24 }, (_, index) => {
    const until = NOW - (23 - index) * HOUR;
    return { since: until - HOUR, until, unit: 'ms', ...pick(index) };
  });
}
const metricsEvidence = { v: 1, items: [{ source: { kind: 'alert', label: 'Collector' }, author: { kind: 'process' }, text: 'Retained metrics' }] };
function metricsRead(measure: Readonly<{ kind: string }>) {
  if (measure.kind === 'runtime') {
    const trend = metricTrend(hour => ({ value: 380_000_000 + ((hour * 7919) % 11) * 6_000_000 }));
    return { result: { status: 'up', observedAt: NOW, evidence: metricsEvidence, measurements: { measure: 'v8js.memory.heap.used',
      value: 412_000_000, unit: 'By', basis: 'metric_points', producers: [{ serviceName: 'billing-api', serviceVersion: 'v1.43' }],
      window: { since: NOW - 24 * HOUR, until: NOW }, completeness: 'complete', reasons: [] } }, routes: [], trend };
  }
  const trend = metricTrend(hour => {
    const p95 = hour >= 18 ? 400 + (hour % 3) * 9 : 190 + ((hour * 31) % 5) * 8;
    return { value: p95, p95, p50: Math.round(p95 / 4.6), count: 9000 + ((hour * 977) % 7) * 900, errorRate: hour >= 18 ? 0.024 : 0.004 };
  });
  return { result: { status: 'up', observedAt: NOW, evidence: metricsEvidence, measurements: { measure: 'p95', value: 412, unit: 'ms',
    basis: 'metric_points', p95Ms: 412, p50Ms: 88, requestCount: 236_400, errorRate: 0.011,
    producers: [{ serviceName: 'billing-api', serviceVersion: 'v1.43' }], window: { since: NOW - 24 * HOUR, until: NOW },
    completeness: 'complete', reasons: [] } }, routes: [], trend };
}

/**
 * `populated`: every capability receiving, with a day of data. `waiting`: the collector is set up and answering but
 * nothing has arrived yet, so each capability says Not receiving yet and each view is empty. `offline`: see below.
 */
export type TelemetryCaptureFixtureState = 'populated' | 'waiting' | 'offline';

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
    const waiting = state === 'waiting';
    if (actionId.endsWith('/capture/status'))
      // Delivery is read against the viewer's clock ("last sample 3 minutes ago"), unlike the fixed capture window.
      return { ok: true, source, enabled: true, coverage: { lostObservations: 0, reason: null },
        lastReceivedAt: waiting ? null : Date.now() - 40 * SECOND,
        capabilityLastSampleAt: waiting ? { metrics: null, appLlmCost: null, exceptions: null }
          : { metrics: Date.now() - MINUTE, appLlmCost: Date.now() - 3 * MINUTE, exceptions: null } };
    if (actionId.endsWith('/capture/costs/read'))
      return { ok: true, source, since: NOW - 24 * HOUR, until: NOW, items: waiting ? [] : COSTS,
        coverage: { lostObservations: 0, reason: null, callCount: waiting ? 0 : COST_CALLS, tokenCategoryCallCount: waiting ? 0 : COST_CALLS,
          reportedCostCallCount: waiting ? 0 : COST_REPORTED_CALLS } };
    if (actionId.endsWith('/capture/metrics/read')) {
      const selection = input as { view?: string; serviceName?: string; serviceVersion?: string };
      if (selection.view === 'overview') {
        if (waiting) return { view: 'overview', services: [], selected: null, metrics: null };
        const services = [{ serviceName: 'billing-api', versions: ['v1.43'] }, { serviceName: 'billing-worker', versions: ['v1.12'] }];
        const { result: http, trend: httpTrend } = metricsRead({ kind: 'http' });
        const { result: heap, trend: heapTrend } = metricsRead({ kind: 'runtime' });
        const unknown = { result: { status: 'unknown', observedAt: NOW, evidence: metricsEvidence }, trend: [] };
        return { view: 'overview', services, selected: { serviceName: selection.serviceName ?? 'billing-api',
          serviceVersion: selection.serviceVersion ?? null }, metrics: {
          http: { result: http, trend: httpTrend }, heap: { result: heap, trend: heapTrend }, gc: unknown, activeRequests: unknown,
        } };
      }
      if (waiting) throw Object.assign(new Error('unexpected'), { code: 'unexpected' });
      return metricsRead((input as { measure: { kind: string } }).measure);
    }
    if (actionId.endsWith('/capture/traces/list') && (input as { appLlmCalls?: unknown }).appLlmCalls)
      return { ok: true, source, items: waiting ? [] : LLM_CALLS };
    if (waiting && actionId.endsWith('/list'))
      return { ok: true, source, items: [] };
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
    throw new Error(`Unexpected collector read ${actionId}`);
  };
}

/** A fixture collector implements the real store's transport contract, including explicit change delivery. */
export function createTelemetryCaptureFixtureTransport(
  invoke: TelemetryCaptureInvoke,
  readCoverage?: () => DatabaseCaptureCoverageV1,
) {
  type Listener = Parameters<NonNullable<PluginUiResourceClient['watchResource']>>[1];
  const listeners = new Set<Listener>();
  const createResourceClient: MachineResourceClientFactory = ({ machineId: collectorMachineId, scope }) => {
    let digest: string | undefined;
    let reading: ReturnType<PluginUiResourceClient['readResource']> | undefined;
    return {
      readResource(reference, options) {
        if (typeof reference === 'string' || !('hostRead' in reference) || reference.hostRead !== 'telemetry.capture') {
          throw new Error('Expected a capture Resource');
        }
        const selected = projectTelemetryCaptureResourceDemandV1(reference);
        if (!selected || typeof selected.input !== 'object' || selected.input === null || Array.isArray(selected.input)) {
          throw new Error('Expected a capture list');
        }
        const until = Date.now();
        const window = reference.windowMs === undefined ? undefined : { since: Math.max(0, until - reference.windowMs), until };
        reading = invoke({ scope, collectorMachineId, actionId: formatQualifiedPluginActionId(reference.input.action) as TelemetryCaptureActionId,
          input: { ...selected.input, ...window }, ...(options?.signal ? { signal: options.signal } : {}) }).then(result => {
          const snapshot = selected.view === 'costs' || selected.view === 'metrics' || selected.view === 'status'
            ? { view: selected.view, result } : { view: selected.view, result, window, coverage: readCoverage?.() };
          const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
          digest = `sha256:${computeSha256HexDigest(bytes)}`;
          return { contentType: 'application/json', digest, bytes };
        });
        return reading;
      },
      async watchResource(_reference, listener, options) {
        // Open starts before the baseline read. The collector admits those same bytes.
        await Promise.resolve();
        await reading;
        if (!options?.signal?.aborted) listeners.add(listener);
        return { ...(digest ? { admittedDigest: digest } : {}), dispose() { listeners.delete(listener); } };
      },
    };
  };
  return {
    createResourceClient,
    readPrices: async () => TELEMETRY_FIXTURE_PRICE_CATALOG,
    invalidate() { for (const listener of listeners) listener({ kind: 'invalidated' }); },
    get watchers() { return listeners.size; },
  };
}


export function TelemetryCaptureFixtureProvider({ invoke, transport, children }: Readonly<{
  invoke: TelemetryCaptureInvoke;
  transport?: ReturnType<typeof createTelemetryCaptureFixtureTransport>;
  children: React.ReactNode;
}>) {
  const value = React.useMemo(() => ({ invoke, ...(transport ?? createTelemetryCaptureFixtureTransport(invoke)) }), [invoke, transport]);
  return React.createElement(TelemetryCaptureTransportContext.Provider, { value }, children);
}
