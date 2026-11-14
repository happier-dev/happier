import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { HappierSeries } from '@happier-dev/plugin-ui/presentation';

import { usageSignatureAccent, withUsageAccentAlpha } from '@/components/settings/usage/usageAccent';
import { MachineVitalsRangeBar, useMachineVitalsRange } from '@/components/machines/vitals/MachineVitalsRangeBar';
import { VitalsHistoryChart } from '@/components/machines/vitals/VitalsHistoryChart';
import { VitalsSheet, VitalsTile, VitalsValue } from '@/components/machines/vitals/VitalsSheet';
import {
  buildMachineServiceTimeline,
  formatMachineBytes,
  resolveMachineServiceUsageScales,
  type MachineVitalsTimeline,
} from '@/components/machines/vitals/machineVitalsPresentation';
import { formatVitalsPercent, resolveVitalsAxis, vitalsAreaWash } from '@/components/machines/vitals/vitalsFormat';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useMachineServiceUsageHistory } from '@/sync/domains/machines/resources/useMachineVitalsHistory';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

const NO_FRESHNESS = { kind: 'none' } as const;

/**
 * A service's CPU and memory over the chosen range (pfc-redesign service page), from the Machine's own per-service
 * history: the Machine Overview's range and charts, drawn for this service alone. It reads only while the page is
 * presented; a Machine that keeps no history for it says so instead of drawing an empty chart.
 */
export const MachineServiceUsageHistory = React.memo(function MachineServiceUsageHistory(props: Readonly<{
  serverId: string;
  machineId: string;
  serviceId: string;
  active: boolean;
}>) {
  const language = usePreferredLanguage();
  const { theme } = useUnistyles();
  const [range] = useMachineVitalsRange();
  const usage = useMachineServiceUsageHistory({ serverId: props.serverId, machineId: props.machineId,
    serviceId: props.serviceId, range, enabled: props.active });
  const read = React.useMemo(() => buildMachineServiceTimeline({ range, serviceId: props.serviceId, history: usage.history }),
    [range, props.serviceId, usage.history]);
  // While another range reads, the last drawn history stays (never a flash of nothing); the axis still names the new range.
  const lastDrawn = React.useRef<MachineVitalsTimeline | null>(null);
  if (read) lastDrawn.current = read;
  const timeline = read ?? (usage.status === 'loading' ? lastDrawn.current : null);
  const axis = React.useMemo(() => resolveVitalsAxis(range, timeline, false), [range, timeline, language]);
  const accent = usageSignatureAccent(theme);
  const charts = React.useMemo(() => timeline ? serviceCharts(timeline, accent, theme.dark) : null, [timeline, accent, theme.dark, language]);
  // The range picker shows with a history to draw; a service with none says so in one line, without a picker over nothing.
  return (
    <>
      {timeline && charts ? <MachineVitalsRangeBar freshness={NO_FRESHNESS} showRange /> : null}
      {timeline && charts ? (
        <VitalsSheet testID="machine-service-usage-history">
          <VitalsTile testID="machine-service-usage-history-cpu" label={t('machineServices.usage.cpu')}
            value={charts.cpu.latest === null ? <VitalsValue value={t('machineVitals.unmeasured')} />
              : <VitalsValue value={formatVitalsPercent(charts.cpu.latest)} unit="%" />}>
            <VitalsHistoryChart testID="machine-service-usage-history-cpu-chart" label={t('machineServices.usage.cpu')}
              timeline={timeline} series={charts.cpu.series} variant="area" domain={charts.cpu.domain}
              scaleTicks={charts.cpu.ticks} axis={axis} format={formatPercentLabel} freshness="live" live={false} />
          </VitalsTile>
          <VitalsTile testID="machine-service-usage-history-memory" label={t('machineServices.facts.memory')}
            value={<VitalsValue value={charts.memory.latest === null ? t('machineVitals.unmeasured')
              : formatMachineBytes(charts.memory.latest, 'memory')} />}>
            <VitalsHistoryChart testID="machine-service-usage-history-memory-chart" label={t('machineServices.facts.memory')}
              timeline={timeline} series={charts.memory.series} variant="area" domain={charts.memory.domain}
              scaleTicks={charts.memory.ticks} axis={axis} format={formatMemoryLabel} freshness="live" live={false} />
          </VitalsTile>
        </VitalsSheet>
      ) : usage.status === 'error' ? (
        <SurfaceStateCard testID="machine-service-usage-history-error" size="line" kind="error"
          title={t('common.requestFailed')} action={{ label: t('common.retry'), onPress: usage.retry }} />
      ) : usage.status === 'loading' ? null : (
        // An older Machine, or one that kept no minute for this service in the range: said, never drawn empty.
        <SurfaceStateCard testID="machine-service-usage-history-none" size="line" kind="unavailable"
          title={t('machineVitals.notReported')} />
      )}
    </>
  );
});

function formatPercentLabel(value: number): string {
  return `${formatVitalsPercent(value)}%`;
}

function formatMemoryLabel(value: number): string {
  return formatMachineBytes(value, 'memory');
}

function lastMeasured(timeline: MachineVitalsTimeline, key: 'cpu' | 'usedBytes'): number | null {
  for (let index = timeline.points.length - 1; index >= 0; index--) {
    const value = timeline.points[index]![key];
    if (value !== null) return value;
  }
  return null;
}

/** The two charts' series and scales: each the range's mean with its maximum overlaid, as the Machine's own. */
function serviceCharts(timeline: MachineVitalsTimeline, accent: string, dark: boolean) {
  const scales = resolveMachineServiceUsageScales(timeline);
  const series = (key: 'cpu' | 'usedBytes', maxKey: 'cpuMax' | 'usedBytesMax'): readonly HappierSeries[] => [
    { id: key, label: t('machineVitals.history.mean'), color: accent, fillOpacity: vitalsAreaWash(dark),
      points: timeline.points.map((point) => ({ id: String(point.t), x: point.t, y: point[key] })) },
    { id: `${key}-maximum`, label: t('machineVitals.history.maximum'), color: withUsageAccentAlpha(accent, 0.55), overlay: true,
      points: timeline.points.map((point) => ({ id: String(point.t), x: point.t, y: point[maxKey] })) },
  ];
  return {
    cpu: { series: series('cpu', 'cpuMax'), domain: scales.cpu.domain, latest: lastMeasured(timeline, 'cpu'),
      ticks: scales.cpu.ticks.map((value) => ({ value, label: value === 0 ? '' : formatPercentLabel(value) })) },
    memory: { series: series('usedBytes', 'usedBytesMax'), domain: scales.memory.domain, latest: lastMeasured(timeline, 'usedBytes'),
      ticks: scales.memory.ticks.map((value) => ({ value, label: value === 0 ? '' : formatMemoryLabel(value) })) },
  };
}
