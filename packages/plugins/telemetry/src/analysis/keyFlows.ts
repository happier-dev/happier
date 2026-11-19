import type { HealthCheckResultV1 } from '@happier-dev/plugin-sdk';
import type { NormalizedMetricPoint } from '../otlp/types.js';
import type { CaptureSummary } from '../store/capture.js';
import type { KeyFlowConfig, KeyFlowReadInput } from '../healthSchemas.js';
import { analyzeMetricWindow } from './metrics.js';

export type KeyFlowMeasurements = NonNullable<HealthCheckResultV1['measurements']>;
export type KeyFlowSelection = Readonly<{ serviceName?: string; serviceVersion?: string;
    measure: Exclude<KeyFlowReadInput['measure'], { kind: 'spend' }> }>;
export type KeyFlowWindowInput = KeyFlowSelection & Readonly<{ window: Readonly<{ since: number; until: number }>;
    points: readonly NormalizedMetricPoint[]; spans: readonly CaptureSummary[] }>;
const kind = { pluginId: 'happier.telemetry', localId: 'key-flow' } as const;
export const keyFlowRouteKey = (method: unknown, route: unknown): string => JSON.stringify([method, route]);

function empty(input: Pick<KeyFlowWindowInput, 'measure' | 'window'>, reasons: string[]): KeyFlowMeasurements {
    return { measure: input.measure.kind === 'runtime' ? input.measure.metricName : input.measure.statistic,
        unit: input.measure.kind === 'runtime' ? '' : input.measure.statistic === 'errorRate' ? '1'
            : input.measure.statistic === 'requests' ? '{request}' : 'ms',
        basis: 'metric_points', producers: [], window: input.window, completeness: 'unknown', reasons };
}

/** A metric population wins over samples for that producer; other emitted services remain included. */
function selectKeyFlowHttpEvidence(input: KeyFlowWindowInput) {
    const routes = input.measure.kind === 'route' ? new Set(input.measure.routes.map(item => keyFlowRouteKey(item.method, item.route))) : undefined;
    const emittedRoute = (method: unknown, route: unknown) => !routes || routes.has(keyFlowRouteKey(method, route));
    const histogram = input.points.filter(point => point.metricType === 'histogram' && point.name === 'http.server.request.duration'
        && (input.serviceName === undefined || point.serviceName === input.serviceName)
        && (input.serviceVersion === undefined || point.serviceVersion === input.serviceVersion)
        && emittedRoute(point.dimensions['http.request.method'] ?? point.dimensions['http.method'], point.dimensions['http.route']));
    const measuredServices = input.serviceName === undefined && input.measure.kind === 'http' && input.measure.statistic === 'requests'
        ? new Set(histogram.map(point => point.serviceName)) : undefined;
    const spans = input.spans.filter(span => span.kind === 'span' && span.spanKind === 2
        && (input.serviceName === undefined || span.serviceName === input.serviceName)
        && !measuredServices?.has(span.serviceName ?? undefined)
        && span.at >= input.window.since && span.at < input.window.until
        && emittedRoute(span.endpointMethod, span.endpointRoute) && typeof span.durationMs === 'number');
    return { histogram, spans };
}

/** Authored emitted identities only: no URL inference, learned routes or correlation engine. */
export function analyzeKeyFlow(input: KeyFlowWindowInput): KeyFlowMeasurements {
    const points = input.points.filter(point => (input.serviceName === undefined || point.serviceName === input.serviceName)
        && (input.serviceVersion === undefined || point.serviceVersion === input.serviceVersion));
    if (input.measure.kind === 'runtime') {
        const metricName = input.measure.metricName;
        const dimensions = input.measure.dimensions ?? [];
        const selected = points.filter(point => point.name === metricName
            && dimensions.every(item => point.dimensions[item.name] === item.value));
        const result = analyzeMetricWindow(selected, { ...input.window, statistic: input.measure.statistic });
        return { measure: metricName, ...(result.value === undefined ? {} : { value: result.value }), unit: result.unit,
            basis: 'metric_points', producers: [...result.producers], window: input.window,
            ...(result.observedWindow ? { observedWindow: result.observedWindow } : {}),
            completeness: result.status === 'inconclusive' ? 'unknown' : result.status, reasons: [...result.reasons] };
    }
    const measure = input.measure;
    const { histogram, spans } = selectKeyFlowHttpEvidence(input);
    if (histogram.length) {
        const latency = analyzeMetricWindow(histogram, { ...input.window,
            statistic: measure.statistic === 'p50' ? 'p50' : 'p95' });
        const countBased = measure.statistic === 'errorRate' || measure.statistic === 'requests';
        const summary = countBased ? analyzeMetricWindow(histogram, { ...input.window, statistic: 'count' }) : latency;
        const errors = histogram.filter(point => Number(point.dimensions['http.response.status_code'] ?? point.dimensions['http.status_code']) >= 500);
        const failed = errors.length ? analyzeMetricWindow(errors, { ...input.window, statistic: 'count' }) : undefined;
        const scale = latency.unit === 's' ? 1000 : latency.unit === 'ms' ? 1 : undefined;
        const hasStatuses = histogram.every(point => typeof (point.dimensions['http.response.status_code'] ?? point.dimensions['http.status_code']) !== 'undefined');
        const errorRate = hasStatuses && summary.count && (!failed || failed.status !== 'inconclusive')
            ? (failed?.count ?? 0) / summary.count : undefined;
        const p50Ms = scale === undefined || latency.p50 === undefined ? undefined : latency.p50 * scale;
        const p95Ms = scale === undefined || latency.p95 === undefined ? undefined : latency.p95 * scale;
        const value = measure.statistic === 'requests' ? summary.count
            : measure.statistic === 'errorRate' ? errorRate : measure.statistic === 'p50' ? p50Ms : p95Ms;
        const reasons = [...new Set([...summary.reasons, ...(measure.statistic === 'errorRate' ? failed?.reasons ?? [] : [])])];
        if (value === undefined && summary.status !== 'inconclusive' && !reasons.length) {
            reasons.push(measure.statistic === 'errorRate' ? hasStatuses ? 'no_traffic' : 'http_status_missing' : 'unsupported_duration_unit');
        }
        const measurement: KeyFlowMeasurements = { measure: measure.statistic, ...(value === undefined ? {} : { value }),
            unit: measure.statistic === 'requests' ? '{request}' : measure.statistic === 'errorRate' ? '1' : 'ms',
            basis: 'metric_points', producers: [...summary.producers], window: input.window,
            ...(summary.observedWindow ? { observedWindow: summary.observedWindow } : {}),
            completeness: summary.status !== 'inconclusive' && value !== undefined
                ? summary.status === 'partial' || measure.statistic === 'errorRate' && failed?.status === 'partial' ? 'partial' : 'complete' : 'unknown',
            reasons,
            ...(p50Ms === undefined ? {} : { p50Ms }), ...(p95Ms === undefined ? {} : { p95Ms }),
            ...(errorRate === undefined ? {} : { errorRate }), ...(summary.count === undefined ? {} : { requestCount: summary.count }) };
        if (input.serviceName === undefined && measure.kind === 'http' && measure.statistic === 'requests' && spans.length) {
            const sampled = analyzeKeyFlow({ ...input, points: [], spans });
            const total = value === undefined || sampled.value === undefined ? undefined : value + sampled.value;
            return { ...measurement, ...(total === undefined ? {} : { value: total, requestCount: total }),
                basis: 'mixed_telemetry', producers: [...measurement.producers, ...sampled.producers],
                completeness: measurement.completeness === 'unknown' ? 'unknown' : 'partial',
                reasons: [...new Set([...measurement.reasons, ...sampled.reasons])] };
        }
        return measurement;
    }
    // Trace samples are observed traffic, never a claim about the full request population.
    if (!spans.length) return empty(input, ['no_traffic']);
    if (input.serviceVersion !== undefined) return empty(input, ['span_version_unavailable']);
    const durations = spans.map(span => span.durationMs!).sort((left, right) => left - right);
    const percentile = (quantile: number) => durations[Math.max(0, Math.ceil(durations.length * quantile) - 1)]!;
    const p50Ms = percentile(0.5), p95Ms = percentile(0.95);
    const errorRate = spans.filter(span => span.outcome === 'error' || (span.httpStatusCode ?? 0) >= 500).length / spans.length;
    const producers = new Map(spans.map(span => {
        const serviceName = span.serviceName ?? undefined;
        return [serviceName, serviceName === undefined ? {} : { serviceName }] as const;
    }));
    return { measure: measure.statistic, value: measure.statistic === 'requests' ? spans.length
        : measure.statistic === 'errorRate' ? errorRate : measure.statistic === 'p50' ? p50Ms : p95Ms,
        unit: measure.statistic === 'requests' ? '{request}' : measure.statistic === 'errorRate' ? '1' : 'ms',
        p50Ms, p95Ms, errorRate, requestCount: spans.length,
        basis: 'sampled_spans', producers: [...producers.values()], window: input.window,
        completeness: 'partial', reasons: ['sampled_traffic'] };
}

/** Existing saved health lifecycle consumes this finite summary without telemetry-specific notices or state. */
export function evaluateKeyFlow(measurements: KeyFlowMeasurements, threshold: KeyFlowConfig['threshold'] | undefined,
    observedAt: number, observerMachineId: string): HealthCheckResultV1 {
    const unknown = measurements.completeness === 'unknown' || measurements.value === undefined;
    const failed = !unknown && threshold !== undefined && (threshold.operator === 'above'
        ? measurements.value! > threshold.value : measurements.value! < threshold.value);
    // A breached limit is a failing flow (warning), never an unreachable target: 'down' stays for checks that cannot answer (D33).
    const status = unknown ? 'unknown' : failed ? 'degraded' : 'up';
    const reason = unknown ? measurements.reasons[0] ?? 'measurement_unavailable' : failed ? 'threshold_exceeded' : 'within_threshold';
    return { status, observedAt, measurements,
        ...((measurements.measure === 'p50' || measurements.measure === 'p95') && measurements.value !== undefined
            ? { latencyMs: measurements.value } : {}),
        cause: { kind, observerMachineId, vantage: 'sameMachine', reason },
        evidence: { v: 1, items: [{ source: { kind: 'alert', label: 'Key flow' }, author: { kind: 'process' },
            text: `Key flow check: ${status} (${reason}).` }] } };
}
