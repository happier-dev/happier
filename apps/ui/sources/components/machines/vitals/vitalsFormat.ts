import { formatHappierDataBytesParts } from '@happier-dev/plugin-ui/presentation';

import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import type { MachineVitalsRange } from '@/sync/domains/machines/resources/machineRpc';

import { resolveMachineUptimeParts, type MachineVitalsTimeline } from './machineVitalsPresentation';

/** "12", "0.4": whole percent from one, one decimal below it, so an idle machine never reads "0". */
export function formatVitalsPercent(value: number): string {
  if (value > 0 && value < 1)
    return (Math.round(value * 10) / 10).toLocaleString(undefined, {
      maximumFractionDigits: 1,
    });
  return Math.round(value).toLocaleString();
}

export function formatVitalsLoad(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** A transfer rate in the storage base ("2.1 MB/s", "340 KB/s"). */
export function formatVitalsRate(bytesPerSecond: number): string {
  const parts = formatHappierDataBytesParts(bytesPerSecond, {
    kind: 'storage',
  });
  return t('machineVitals.rate', { value: parts.value, unit: parts.unit });
}

export function formatVitalsRateParts(bytesPerSecond: number) {
  return formatHappierDataBytesParts(bytesPerSecond, { kind: 'storage' });
}

/** A history point's time, as the lens titles it. */
export function formatVitalsPointTime(at: number): string {
  return formatAsOfTime(at);
}

/** The light wash under a history line (lab: a whisper on light, a little more on dark). */
export function vitalsAreaWash(dark: boolean): number {
  return dark ? 0.16 : 0.08;
}

/** Percent charts keep a fixed 0–100 % scale, so a busy minute never reads as a near-empty machine. */
export const vitalsPercentScale = Object.freeze({
  domain: Object.freeze({ min: 0, max: 100 }),
  ticks: Object.freeze([
    Object.freeze({ value: 0, label: '' }),
    Object.freeze({ value: 50, label: '50%' }),
    Object.freeze({ value: 100, label: '100%' }),
  ]),
});

const RANGE_START_KEYS = {
  '1h': 'machineVitals.range.hourAgo',
  '24h': 'machineVitals.range.dayAgo',
  '7d': 'machineVitals.range.weekAgo',
} as const satisfies Record<MachineVitalsRange, string>;

/** The two ends under a chart: "1 h ago · now" while live, the real times once the values are held. */
export function resolveVitalsAxis(
  range: MachineVitalsRange,
  timeline: MachineVitalsTimeline | null,
  live: boolean,
): readonly [string, string] {
  if (live || !timeline)
    return [t(RANGE_START_KEYS[range]), t('machineVitals.range.now')];
  return [formatAsOfTime(timeline.start), formatAsOfTime(timeline.end)];
}

/** "Up 6 d 4 h", "Up 41 d", "Up 3 h 20 min", "Up 12 min": a machine's time since boot (header facts). */
/**
 * How long since `startedAt`, without the "Up" the header says ("2 d 6 h", "12 d"): a figure under a column
 * already titled Up (Machine → Services). Same rounding as {@link describeMachineUptime}.
 */
export function describeMachineUptimeSpan(startedAt: number, nowMs: number): string {
  const { days, hours, minutes } = resolveMachineUptimeParts(startedAt, nowMs);
  const daysText = t('machineVitals.alerts.durations.days', { days });
  if (days >= 7 || (days > 0 && hours === 0)) return daysText;
  if (days > 0) return `${daysText} ${t('machineVitals.alerts.durations.hours', { hours })}`;
  if (hours > 0) return minutes === 0 ? t('machineVitals.alerts.durations.hours', { hours }) : t('machineVitals.alerts.durations.hoursMinutes', { hours, minutes });
  return t('machineVitals.alerts.durations.minutes', { minutes });
}

export function describeMachineUptime(bootedAt: number, nowMs: number): string {
  const { days, hours, minutes } = resolveMachineUptimeParts(bootedAt, nowMs);
  if (days >= 7 || (days > 0 && hours === 0)) return t('machineVitals.header.upDays', { days });
  if (days > 0) return t('machineVitals.header.upDaysHours', { days, hours });
  if (hours > 0) return minutes === 0 ? t('machineVitals.header.upHours', { hours }) : t('machineVitals.header.upHoursMinutes', { hours, minutes });
  return t('machineVitals.header.upMinutes', { minutes });
}
