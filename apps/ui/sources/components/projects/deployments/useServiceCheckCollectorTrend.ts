import * as React from 'react';
import type { TelemetryKeyFlowConfigV1, TelemetryMetricsReadResultV1 } from '@happier-dev/database-protocol';

import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import { SERVICE_CHECK_RESPONSE_WINDOW_MS, type ServiceCheckCollectorTrend } from './serviceCheckPresentation';
import { readTelemetryCheckHistory } from './telemetryMetricSeries';

type CollectorTrend = Awaited<ReturnType<typeof readTelemetryCheckHistory>>;

export type ServiceCheckCollectorTrendRead =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'ready'; read: CollectorTrend }>;

export type ServiceCheckCollectorTrendReader = (
  input: Parameters<typeof readTelemetryCheckHistory>[0],
  signal: AbortSignal,
) => Promise<CollectorTrend>;

/** The collector read through the Action front door, on the Machine the check runs on. */
const readThroughFrontDoor: ServiceCheckCollectorTrendReader = (input, signal) =>
  readTelemetryCheckHistory(input, undefined, { signal });

/** The network edge of every collector trend read; dev specimens supply fixture reads here, as other specimens do. */
export const ServiceCheckCollectorTrendReaderContext = React.createContext<ServiceCheckCollectorTrendReader>(readThroughFrontDoor);

/** The latency a flow's trend draws: its saved p50 or p95, else the p95 the collector reports beside an error-rate flow. */
export function serviceCheckCollectorLatency(config: TelemetryKeyFlowConfigV1,
  interval: TelemetryMetricsReadResultV1['trend'][number]): number | null {
  if (config.measure.kind !== 'route') return interval.value ?? null;
  if (interval.count === 0) return null;
  if (config.measure.statistic === 'p50') return interval.p50 ?? interval.value ?? null;
  return interval.p95 ?? (config.measure.statistic === 'p95' ? interval.value ?? null : null);
}

const IDLE: ServiceCheckCollectorTrendRead = { kind: 'idle' };
const LOADING: ServiceCheckCollectorTrendRead = { kind: 'loading' };
const UNAVAILABLE: ServiceCheckCollectorTrendRead = { kind: 'unavailable' };

/**
 * A Key flow check's 24-hour trend, read from the collector that runs it (D33, R2-B) while the surface that draws it is
 * mounted. Each new persisted result moves the window's end, so the trend follows pushed results without a timer; the
 * last read stays drawn while the next one settles. Every other kind has no collector trend and reads nothing.
 */
export function useServiceCheckCollectorTrend(
  scope: Readonly<{ serverId: string; accountId: string }>,
  trend: ServiceCheckCollectorTrend | null,
): ServiceCheckCollectorTrendRead {
  const [state, setState] = React.useState<Readonly<{ key: string; selectionKey: string; read: ServiceCheckCollectorTrendRead }> | null>(null);
  const configKey = trend ? JSON.stringify(trend.config) : null;
  const key = trend ? JSON.stringify([scope.serverId, scope.accountId, trend.collectorMachineId, configKey, trend.until]) : null;
  const selectionKey = trend ? JSON.stringify([scope.serverId, scope.accountId, trend.collectorMachineId, configKey]) : null;
  const reader = React.useContext(ServiceCheckCollectorTrendReaderContext);
  const latest = React.useRef(trend);
  latest.current = trend;
  React.useEffect(() => {
    const selected = latest.current;
    if (!key || !selected) return;
    const lifetime = captureActiveServerAccountScopeLifetime();
    const controller = new AbortController();
    void reader({ scope: { serverId: scope.serverId, accountId: scope.accountId }, collectorMachineId: selected.collectorMachineId,
      config: selected.config, since: selected.until - SERVICE_CHECK_RESPONSE_WINDOW_MS, until: selected.until }, controller.signal)
      .then((read) => {
        if (!controller.signal.aborted && (lifetime?.isCurrent() ?? true)) setState({ key, selectionKey: selectionKey!, read: { kind: 'ready', read } });
      })
      .catch(() => {
        if (!controller.signal.aborted && (lifetime?.isCurrent() ?? true)) setState({ key, selectionKey: selectionKey!, read: UNAVAILABLE });
      });
    return () => controller.abort();
    // The selection and window end decide the read; the scope object's identity does not.
  }, [key, selectionKey, reader, scope.serverId, scope.accountId]);
  if (!key) return IDLE;
  if (state?.key === key) return state.read;
  // A newer window keeps the last settled trend for the same selection until its own read settles.
  return state?.selectionKey === selectionKey ? state.read : LOADING;
}
