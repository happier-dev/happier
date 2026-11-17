import { describe, expect, it } from 'vitest';
import type { TelemetryMetricsReadResultV1 } from '@happier-dev/database-protocol';
import type { HealthCheckResultV1 } from '@happier-dev/plugin-sdk';

import { readTelemetryMetricSeries } from './telemetryMetricSeries';

const measurements = {
  measure: 'requests', value: 4, unit: '{request}', basis: 'metric_points',
  producers: [{ serviceName: 'checkout', serviceVersion: 'v1' }],
  window: { since: 0, until: 4000 }, observedWindow: { since: 1000, until: 4000 },
  completeness: 'partial', reasons: ['boundary_gap'],
} satisfies NonNullable<HealthCheckResultV1['measurements']>;

describe('collector metric chart data', () => {
  it('keeps measured zero, unavailable readings and natural interval identities distinct', () => {
    const read = { result: { status: 'up' as const, observedAt: 4000, measurements,
      evidence: { v: 1 as const, items: [] } }, routes: [], trend: [
      { since: 1000, until: 2000, value: 4, unit: '{request}' },
      { since: 2000, until: 3000, value: 0, unit: '{request}' },
      { since: 3000, until: 4000, unit: '{request}' },
    ] } satisfies TelemetryMetricsReadResultV1;
    const chart = readTelemetryMetricSeries(read, { id: 'requests', label: 'Requests' });
    expect(chart.series).toEqual({ id: 'requests', label: 'Requests', points: [
      { id: '[1000,2000]', x: 2000, y: 4 },
      { id: '[2000,3000]', x: 3000, y: 0 },
      { id: '[3000,4000]', x: 4000, y: null },
    ] });
    expect(chart.measurements).toBe(measurements);
    expect(readTelemetryMetricSeries({ ...read, trend: read.trend.slice(1) }, { id: 'requests', label: 'Requests' })
      .series.points[0]?.id).toBe(chart.series.points[1]?.id);
  });

  it.each([
    ['requests', '{request}', 2], ['p95', 'ms', 91], ['errors', '1', 0.5], ['heap', 'By', 8192],
  ] as const)('leaves the collector-selected %s reading and its unit unchanged', (id, unit, value) => {
    const selected = { ...measurements, measure: id, value, unit };
    const read = { result: { status: 'up' as const, observedAt: 2000, measurements: selected,
      evidence: { v: 1 as const, items: [] } }, routes: [],
      trend: [{ since: 1500.25, until: 1500.25, value, unit }] } satisfies TelemetryMetricsReadResultV1;
    const chart = readTelemetryMetricSeries(read, { id, label: id });
    expect(chart.series.points).toEqual([{ id: '[1500.25,1500.25]', x: 1500.25, y: value }]);
    expect(chart.measurements).toBe(selected);
  });
});
