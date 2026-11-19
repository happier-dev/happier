import { describe, expect, it } from 'vitest';
import { analyzeKeyFlow, evaluateKeyFlow } from './keyFlows.js';
import type { CaptureSummary } from '../store/capture.js';
import type { NormalizedMetricPoint } from '../otlp/types.js';

const selector = { serviceName: 'checkout', measure: { kind: 'route' as const,
    routes: [{ method: 'POST', route: '/checkout' }], statistic: 'p95' as const } };
const window = { since: 1000, until: 2000 };
function request(id: string, durationMs: number, outcome = 'ok'): CaptureSummary {
    return { id, worktree: 'environment:env', kind: 'span', source: 'otlp', at: 1500,
        spanKind: 2, serviceName: 'checkout', endpointMethod: 'POST', endpointRoute: '/checkout', durationMs, outcome };
}

describe('authored key-flow measured health', () => {
    it('keeps retained spans with no emitted service identity without publishing a null producer name', () => {
        const measured = analyzeKeyFlow({ window, points: [],
            spans: [{ ...request('unnamed', 20), serviceName: null }],
            measure: { kind: 'http', statistic: 'requests' } });
        expect(measured).toMatchObject({ value: 1, requestCount: 1 });
        expect(measured.producers).toEqual([{}]);
    });

    it('recovers measured error rate when retained cumulative error counts stop increasing', () => {
        const histogram = (status: number, count: string, at: string): NormalizedMetricPoint => ({ metricType: 'histogram',
            name: 'http.server.request.duration', unit: 's', temporality: 'cumulative', serviceName: 'checkout', serviceInstanceId: 'one',
            startTimeUnixNano: '1000000000', timeUnixNano: at, count, bucketCounts: [count, '0', '0'], explicitBounds: [0.01, 0.1],
            dimensions: { 'http.request.method': 'POST', 'http.route': '/checkout', 'http.response.status_code': status } });
        const input = { ...selector, measure: { ...selector.measure, statistic: 'errorRate' as const },
            window: { since: 2000, until: 3000 }, spans: [], points: [histogram(200, '1', '2000000000'),
                histogram(200, '2', '3000000000'), histogram(500, '1', '2000000000'), histogram(500, '1', '3000000000')] };
        const measured = analyzeKeyFlow(input);
        expect(measured).toMatchObject({ value: 0, requestCount: 1, errorRate: 0, completeness: 'complete' });
        expect(evaluateKeyFlow(measured, { operator: 'above', value: 0.1 }, 3000, 'collector').status).toBe('up');
        const reset = { ...histogram(500, '0', '3000000000') };
        expect(analyzeKeyFlow({ ...input, points: [...input.points.slice(0, 3), reset] }))
            .toMatchObject({ completeness: 'unknown' });
        expect(analyzeKeyFlow({ ...input, points: input.points.slice(0, 3) }))
            .toMatchObject({ completeness: 'unknown' });
    });
    it('aggregates whole-service HTTP evidence across routes while retaining the selected population', () => {
        const measured = analyzeKeyFlow({ serviceName: 'checkout', measure: { kind: 'http', statistic: 'requests' },
            window, points: [], spans: [request('one', 10), { ...request('two', 90, 'error'), endpointRoute: '/returns' },
                { ...request('another-service', 999), serviceName: 'another-service' }, { ...request('client', 999), spanKind: 3 }] });
        expect(measured).toMatchObject({ value: 2, unit: '{request}', requestCount: 2, p50Ms: 10, p95Ms: 90,
            errorRate: 0.5, basis: 'sampled_spans', completeness: 'partial', window });
    });
    it('measures only selected emitted routes, preserves sampled basis and evaluates explicit thresholds', () => {
        const measured = analyzeKeyFlow({ ...selector, window, points: [], spans: [request('fast', 10), request('slow', 90, 'error'),
            { ...request('other', 999), endpointRoute: '/another' }, { ...request('client', 999), spanKind: 3 }] });
        expect(measured).toMatchObject({ value: 90, unit: 'ms', p50Ms: 10, p95Ms: 90, errorRate: 0.5,
            requestCount: 2, basis: 'sampled_spans', completeness: 'partial', window });
        expect(evaluateKeyFlow(measured, { operator: 'above', value: 50 }, 2000, 'collector')).toMatchObject({
            status: 'degraded', latencyMs: 90, measurements: measured,
            cause: { kind: { pluginId: 'happier.telemetry', localId: 'key-flow' }, observerMachineId: 'collector', reason: 'threshold_exceeded' },
        });
        expect(evaluateKeyFlow(measured, { operator: 'above', value: 100 }, 2000, 'collector').status).toBe('up');
    });

    it('leaves absent traffic unknown instead of claiming healthy or zero errors', () => {
        const measured = analyzeKeyFlow({ ...selector, window, points: [], spans: [] });
        expect(measured).toMatchObject({ completeness: 'unknown', reasons: ['no_traffic'], window });
        expect(measured.value).toBeUndefined();
        expect(evaluateKeyFlow(measured, { operator: 'above', value: 50 }, 2000, 'collector').status).toBe('unknown');
    });

    it('measures a selected runtime dimension and exposes expired cumulative baselines', () => {
        const point: NormalizedMetricPoint = { metricType: 'gauge', name: 'nodejs.memory.heap.used', unit: 'By',
            temporality: 'unspecified', startTimeUnixNano: '0', timeUnixNano: '2000000000',
            serviceName: 'checkout', serviceInstanceId: 'one', dimensions: { space: 'old' }, value: 100 };
        const input = { serviceName: 'checkout', window, spans: [], measure: { kind: 'runtime' as const,
            metricName: point.name, statistic: 'latest' as const, dimensions: [{ name: 'space', value: 'old' }] } };
        const measured = analyzeKeyFlow({ ...input, points: [point, { ...point, dimensions: { space: 'new' }, value: 900 }] });
        expect(measured).toMatchObject({ value: 100, unit: 'By', completeness: 'complete', basis: 'metric_points' });
        const expired: NormalizedMetricPoint = { ...point, metricType: 'sum', isMonotonic: true, temporality: 'cumulative' };
        expect(analyzeKeyFlow({ ...input, measure: { ...input.measure, statistic: 'sum' }, points: [expired] }))
            .toMatchObject({ completeness: 'unknown', reasons: expect.arrayContaining(['missing_baseline']) });
    });
});
