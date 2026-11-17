import type { TelemetryMetricsReadResultV1 } from '@happier-dev/database-protocol';
import type { HappierSeries } from '@happier-dev/plugin-ui/presentation';

/** The collector owns values, units and coverage; charts consume its natural intervals. */
export function readTelemetryMetricSeries(
  read: TelemetryMetricsReadResultV1,
  identity: Pick<HappierSeries, 'id' | 'label'>,
): Readonly<{
  series: HappierSeries;
  measurements: TelemetryMetricsReadResultV1['result']['measurements'];
}> {
  return {
    series: { id: identity.id, label: identity.label, points: read.trend.map(interval => ({
      id: JSON.stringify([interval.since, interval.until]), x: interval.until, y: interval.value ?? null,
    })) },
    measurements: read.result.measurements,
  };
}
