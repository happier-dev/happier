import type { HeatmapProps, IntervalTimelineInterval } from '@happier-dev/plugin-ui/presentation';
import { isUsageNightHour } from '@happier-dev/protocol/usage/usageWorkIntervals';
import { withUsageAccentAlpha } from '../usageAccent';
import type { UsageHowYouWork } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';
import { getPreferredLanguage, t } from '@/text';
import { formatUsageDuration as formatSharedUsageDuration, formatUsageDurationCompact as formatSharedUsageDurationCompact,
  type UsageDurationLabels } from '@happier-dev/protocol/usage/usageFormatting';
export { formatUsageUtcOffset } from '@happier-dev/protocol/usage/usageFormatting';

/**
 * Presentation-only shaping of the How-you-work projection (Protocol `resolveUsageHowYouWork` owns
 * every number). Nothing here infers presence, fills a gap or turns unknown into zero.
 */

const MINUTE_MS = 60_000;

/** "02:40" for minutes from the start of the query's own calendar day (its fixed offset already applied). */
export function formatUsageClockMinutes(minutes: number): string {
  if (!Number.isFinite(minutes)) return t('usage.board.howYouWork.notRecorded');
  const whole = Math.round(minutes);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

/** "3 h 12 min", "18 min", "40 s": a measured duration. A measured nothing reads "0 min", never blank. */
const durationLabels: UsageDurationLabels = {
  seconds: seconds => t('usage.board.howYouWork.durationSeconds', { seconds }),
  minutes: minutes => t('usage.board.howYouWork.durationMinutes', { minutes }),
  hours: (hours, minutes) => t('usage.board.howYouWork.durationHours', { hours, minutes }),
};

export function formatUsageDuration(ms: number): string {
  return formatSharedUsageDuration(ms, durationLabels);
}

/** Ask the duration formatter which measured amount its visible units retain, without parsing localized text. */
export function isUsageDurationFullyVisible(ms: number): boolean {
  return formatSharedUsageDuration(ms, {
    seconds: seconds => String(seconds * 1000),
    minutes: minutes => String(minutes * MINUTE_MS),
    hours: (hours, minutes) => String((hours * 60 + minutes) * MINUTE_MS),
  }) === String(ms);
}

const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * "7 days", "14 hours": how far back a rolling window reaches, said in the whole calendar units a person picks a
 * period by ("Last 7 days") rather than as the exact measured span ("153 h 59 min") that period resolves to
 * partway through a day. Rounds up to the unit, so the window is never claimed shorter than it is.
 */
export function formatUsageLookbackPeriod(ms: number): string {
  const unit = (value: number, name: 'day' | 'hour') =>
    new Intl.NumberFormat(getPreferredLanguage(), { style: 'unit', unit: name, unitDisplay: 'long' }).format(value);
  return ms >= DAY_MS ? unit(Math.ceil(ms / DAY_MS), 'day') : unit(Math.max(1, Math.ceil(ms / HOUR_MS)), 'hour');
}

/**
 * "3h 12m", "18m", "40s": the same measured duration at a width that never wraps inside a statistic cell, from
 * the platform's own narrow unit names for the reader's language. A measured nothing reads "0m", never blank.
 */
export function formatUsageDurationCompact(ms: number): string {
  return formatSharedUsageDurationCompact(ms, getPreferredLanguage());
}

/** Work ids are the canonical `[sessionId, turnId]` key; anything else names no Session. */
export function readUsageWorkSessionId(workId: string): string | null {
  try {
    const value: unknown = JSON.parse(workId);
    return Array.isArray(value) &&
      typeof value[0] === 'string' &&
      value[0].length > 0
      ? value[0]
      : null;
  } catch {
    return null;
  }
}

/** The turn half of the same canonical `[sessionId, turnId]` key; null when it names none. */
export function readUsageWorkTurnId(workId: string): string | null {
  try {
    const value: unknown = JSON.parse(workId);
    return Array.isArray(value) && typeof value[1] === 'string' && value[1].length > 0
      ? value[1]
      : null;
  } catch {
    return null;
  }
}

type Lanes = NonNullable<UsageHowYouWork['intervals']>['lanes'];
type WaitKind = Lanes[number]['waits'][number]['kind'];
/** A drawn row; `waitKind` stays presentation metadata and is never shown as a raw value. */
export type UsageTodayInterval = IntervalTimelineInterval &
  Readonly<{ waitKind?: WaitKind }>;
export type UsageTodayMachineGroup = Readonly<{
  id: string;
  label: string;
  intervals: readonly UsageTodayInterval[];
}>;

/**
 * Today's slice of each witnessed lane, in minutes from the day's start, grouped by machine. Each busy
 * span and wait is its own interval (a run's gaps are not busy; waits are hatched), and one run's
 * intervals share a track so the machine's lane packs them onto one line.
 */
export function groupUsageTodayLanes(
  lanes: Lanes,
  today: Readonly<{ startMs: number; endMs: number }>,
  labels: Readonly<{
    session(workId: string): string;
    machine(machineId: string | null): string;
    agent(agentId: string): string;
    /** The Agent's identity hue (the Agent dimension's governed palette). */
    agentColor(agentId: string): string;
    waitColor: string;
  }>,
): UsageTodayMachineGroup[] {
  const groups = new Map<
    string,
    {
      id: string;
      label: string;
      intervals: (UsageTodayInterval & { order: number })[];
    }
  >();
  const clip = (startMs: number, endMs: number) => {
    const start = Math.max(startMs, today.startMs);
    const end = Math.min(endMs, today.endMs);
    return start < end
      ? {
          start: (start - today.startMs) / MINUTE_MS,
          end: (end - today.startMs) / MINUTE_MS,
        }
      : null;
  };
  for (const lane of lanes) {
    const key = lane.machineId ?? '';
    const group = groups.get(key) ?? {
      id: key || 'unknown',
      label: labels.machine(lane.machineId),
      intervals: [],
    };
    const title = labels.session(lane.workId);
    const agent = lane.agentId ? labels.agent(lane.agentId) : undefined;
    lane.busy.forEach((span, index) => {
      const clipped = clip(span.startMs, span.endMs);
      if (clipped)
        group.intervals.push({
          id: `${lane.workId}:busy:${index}`,
          label: title,
          lane: group.label,
          track: lane.workId,
          ...clipped,
          order: clipped.start,
          color: labels.agentColor(lane.agentId ?? ''),
          ...(agent ? { annotation: agent } : {}),
        });
    });
    lane.waits.forEach((span) => {
      const clipped = clip(span.startMs, span.endMs);
      if (clipped)
        group.intervals.push({
          id: `${lane.workId}:wait:${span.evidenceId}`,
          ...clipped,
          lane: group.label,
          track: lane.workId,
          order: clipped.start,
          label: `${title} · ${t(
            span.kind === 'child_wait'
              ? 'usage.board.howYouWork.waitChild'
              : span.kind === 'permission_wait'
                ? 'usage.board.howYouWork.waitApproval'
                : 'usage.board.howYouWork.waitReply',
          )}`,
          color: labels.waitColor,
          pattern: 'hatched',
          waitKind: span.kind,
        });
    });
    if (group.intervals.length > 0) groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((group) => ({
      id: group.id,
      label: group.label,
      intervals: group.intervals
        .sort((a, b) => a.order - b.order)
        .map(({ order: _order, ...interval }) => interval),
    }));
}

/** Time spent waiting on the person (approvals and replies), today; sub-agent waits are the agent's own. */
export function sumUsageWaitingOnYouMs(
  groups: readonly UsageTodayMachineGroup[],
): number {
  return groups.reduce(
    (sum, group) =>
      sum +
      group.intervals.reduce(
        (inner, interval) =>
          interval.waitKind !== undefined &&
          interval.waitKind !== 'child_wait' &&
          interval.start !== null &&
          interval.end !== null
            ? inner + (interval.end - interval.start) * MINUTE_MS
            : inner,
        0,
      ),
    0,
  );
}

export type UsageAnsweringClient = keyof NonNullable<
  UsageHowYouWork['permissions']
>['byAnsweringClient'];
export const USAGE_ANSWERING_CLIENTS: readonly Exclude<
  UsageAnsweringClient,
  'unknown'
>[] = ['desktop', 'web', 'ios', 'android'];

/** Answering-device shares only over witnessed categories; unknown stays its own count, never spread. */
export function readUsageAnsweringShares(
  permissions: NonNullable<UsageHowYouWork['permissions']>,
): Readonly<{
  witnessed: number;
  unknown: number;
  shares: readonly Readonly<{
    client: Exclude<UsageAnsweringClient, 'unknown'>;
    count: number;
  }>[];
}> {
  const counts = permissions.byAnsweringClient;
  const shares = USAGE_ANSWERING_CLIENTS.map((client) => ({
    client,
    count: counts[client],
  })).filter((row) => row.count > 0);
  return {
    witnessed: shares.reduce((sum, row) => sum + row.count, 0),
    unknown: counts.unknown,
    shares,
  };
}

/** The night window's hours in clock order from its start ("23, 0, 1 … 6"). */
export function listUsageNightHours(night: Readonly<{ startHour: number; endHour: number }>): number[] {
    const hours: number[] = [];
    for (let hour = night.startHour; hours.length < 24; hour = (hour + 1) % 24) {
        if (!isUsageNightHour(hour, night)) break;
        hours.push(hour);
    }
    return hours;
}

/**
 * Weekday × night-hour cells from the admitted activity buckets: positioning only, the counts are the
 * producer's. A night hour with no bucket is a recorded nothing for that hour, shown as an empty dot.
 */
export function usageNightGridPresentation(input: Readonly<{
    buckets: readonly Readonly<{ weekday: number; hour: number; eventCount: number }>[];
    night: Readonly<{ startHour: number; endHour: number }>;
    accentColor: string;
    emptyColor: string;
    weekdayLabel(weekday: number): string;
    eventsLabel(count: number): string;
}>): Pick<HeatmapProps, 'label' | 'rows' | 'columns' | 'cells'> {
    const hours = listUsageNightHours(input.night);
    const counts = new Map<string, number>();
    for (const bucket of input.buckets) {
        if (!isUsageNightHour(bucket.hour, input.night)) continue;
        const key = `${bucket.weekday}:${bucket.hour}`;
        counts.set(key, (counts.get(key) ?? 0) + bucket.eventCount);
    }
    const peak = Math.max(1, ...counts.values());
    return {
        label: t('usage.board.howYouWork.nightGrid'),
        // Monday-first, as the Rhythm punch card reads.
        rows: [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({ id: String(weekday), label: input.weekdayLabel(weekday) })),
        columns: hours.map((hour) => ({ id: String(hour), label: hour === hours[0] || hour % 3 === 0 ? String(hour).padStart(2, '0') : '' })),
        cells: Array.from({ length: 7 }, (_, weekday) => hours.map((hour) => {
            const value = counts.get(`${weekday}:${hour}`) ?? 0;
            return { id: `${weekday}:${hour}`, row: String(weekday), column: String(hour),
                label: `${input.weekdayLabel(weekday)} · ${String(hour).padStart(2, '0')}:00`, value, valueLabel: input.eventsLabel(value),
                color: value > 0 ? withUsageAccentAlpha(input.accentColor, 0.2 + 0.8 * value / peak) : input.emptyColor };
        })).flat(),
    };
}
