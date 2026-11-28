import type {
  HappierSeries, HappierSeriesPoint, UsageAgentShare, UsageDayModel, UsageRunLengthModel, UsageScoreModel, UsageShippedModel, UsageSkyDay, UsageSkyModel,
  UsageSteeringTideModel, UsageConstellationModel, UsageRiverModel, UsageWeekHourModel, UsageDaylightModel, UsagePortraitModel,
} from '@happier-dev/plugin-ui/presentation';
import type { UsageHowYouWork } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { resolveUsageDayStreaks, projectUsageOrdinalLevels } from '@happier-dev/protocol/usage/usageActivitySummary';
import { compareUsageMeasurementsDescending } from '@happier-dev/protocol/usage/usageAggregation';
import { resolveUsageCalendarInstant, resolveUsageBucketBounds } from '@happier-dev/protocol/usage/usageCalendar';
import { isUsageNightHour, summarizeUsageConcurrency } from '@happier-dev/protocol/usage/usageWorkIntervals';
import { UsagePresentationMetricSchema, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageChartMetric } from './usageChartHost';
import type { UsageCalendarRange } from '@/sync/domains/usage/usageCalendarPresentation';
import { countUsageChartCalendarDates, projectUsageRiverWeekRange } from '@happier-dev/plugin-ui/components';
import { projectUsageCalendarArtModel } from '@happier-dev/plugin-ui/components';
import { type UsageCalendarArtModel, type UsageMoonsModel, type UsageMachinesModel, type UsageProjectsModel, type UsageAtmosphereModel, type UsageGalaxyModel } from '@happier-dev/plugin-ui/presentation';

/**
 * Private Usage → chart body models. Every figure comes from its canonical owner in the admitted slice
 * (`howYouWork.agentCalendar`, `intervals`, `steering`, `runLengths`, `collaboration`, `mergedOutcomes`); these
 * adapters only place and label them. A fact the owner does not supply stays null/unknown, never zero.
 */

/** The Agent calendar owner's result as the query carries it. */
export type UsageAgentCalendar = NonNullable<UsageHowYouWork['agentCalendar']>;
export type UsagePlanetFamilyModels = Readonly<{
  calendarArt: UsageCalendarArtModel;
  moons: UsageMoonsModel;
  machines: UsageMachinesModel;
  projects: UsageProjectsModel;
  atmosphere: UsageAtmosphereModel | null;
  galaxy: UsageGalaxyModel | null;
}>;

/** Private producer over the canonical admitted Usage facts, using the same finite art models. */
export function projectUsagePlanetFamilyModels(calendar: UsageAgentCalendar, slice: UsageQueryResultSlice | null,
  referenceMs: number, projects?: UsageProjectsModel['links']): UsagePlanetFamilyModels {
  const byDate = new Map(calendar.days.map(day => [day.date, day.totals.eventCount]));
  const dates = periodDates(calendar);
  const observations = dates.map(date => ({ date, eventCount: byDate.has(date) ? byDate.get(date)!
    : calendar.coverage.accounting === 'complete_for_supplied_facts' ? 0 : null }));
  const levels = projectUsageOrdinalLevels(observations.map(day => day.eventCount));
  const streaks = resolveUsageDayStreaks({ days: observations, referenceMs, timeZoneOffsetMinutes: calendar.timeZoneOffsetMinutes,
    range: calendar.period, coverage: calendar.coverage.accounting === 'complete_for_supplied_facts' ? 'complete' : 'partial' });
  const known = observations.some(day => day.eventCount !== null);
  const calendarArt = projectUsageCalendarArtModel({ period: { ...calendar.period, timeZoneOffsetMinutes: calendar.timeZoneOffsetMinutes },
    days: observations.map((day, index) => ({ date: day.date, level: levels[index]! })),
    ...(known && streaks.currentStreakDays !== null ? { currentStreakDays: streaks.currentStreakDays } : {}),
    ...(known && streaks.longestStreakDays !== null ? { bestStreakDays: streaks.longestStreakDays } : {}),
  });
  return { calendarArt,
    moons: { agents: projectUsageAgentShares(calendar, 'tokens'), periodDays: calendarArt.days.length },
    // The canonical owner currently has no witnessed kind taxonomy. Never infer one from machine ids or paths.
    machines: { kinds: null, coverage: { status: calendar.machineKinds.status, method: 'unknown' } },
    // A private Project label or allocation is not an SCM-admitted public link.
    projects: { links: projects ?? null },
    atmosphere: calendar.coverage.busy === 'unavailable' ? null : { weeks: calendar.weeklyPeakParallel.map(week => ({
      startMs: week.startMs, endMs: week.endMs, peak: week.peak, coverage: { status: week.coverage, method: 'runtime' },
    })), ...(slice?.howYouWork?.intervals ? { peakParallel: slice.howYouWork.intervals.maxParallel } : {}) },
    galaxy: slice ? projectUsageRunLengthModel(slice) : null,
  };
}
type CalendarBucket = UsageAgentCalendar['days'][number];
type CalendarMetrics = CalendarBucket['totals'];
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const METRIC_FIELDS = { tokens: 'tokens', cost: 'cost', sessions: 'sessions', busy: 'busyMs', steering: 'steeringCount', peakParallel: 'peakParallel' } as const;

export function readUsageCalendarMetric(metrics: CalendarMetrics, metric: UsageChartMetric): number | null {
  if (metric === 'cost') return metrics.cost?.amountUsd ?? null;
  return metrics[METRIC_FIELDS[metric]];
}

/** Normalizes the query's presentation metric to a chart measure (an unknown value is never read as tokens). */
export function resolveUsageChartMetric(metric: string | undefined, fallback: UsageChartMetric): UsageChartMetric {
  const result = UsagePresentationMetricSchema.safeParse(metric);
  return result.success ? result.data : fallback;
}

/** Every calendar date of the owner's period, oldest first (the owner lists only days it has facts for). */
function periodDates(calendar: UsageAgentCalendar): string[] {
  const dates: string[] = [];
  const offset = calendar.timeZoneOffsetMinutes;
  const first = resolveUsageCalendarInstant(calendar.period.startMs, offset);
  for (let start = first.bucketStartMs; start < calendar.period.endMs; start += DAY_MS) dates.push(resolveUsageCalendarInstant(start, offset).date);
  return dates;
}

/** A fixed end closes the range. A rolling read's exclusive endpoint only identifies the last admitted bucket. */
function runningUsageBucketStart(range: UsageCalendarRange, referenceMs: number, period: UsageQuery['period']): number | null {
  if (period.endMs !== undefined && period.endMs < referenceMs) return null;
  const { granularity, timeZoneOffsetMinutes, endMs } = range;
  const last = resolveUsageBucketBounds(granularity, endMs - 1, timeZoneOffsetMinutes);
  const current = resolveUsageBucketBounds(granularity, referenceMs, timeZoneOffsetMinutes);
  return last.bucketStartMs === current.bucketStartMs ? current.bucketStartMs : null;
}

export function projectUsageSkyModel(
  calendar: UsageAgentCalendar,
  metric: UsageChartMetric,
  colourBy: 'intensity' | 'leadingAgent',
  referenceMs: number,
  period: UsageQuery['period'],
): UsageSkyModel {
  const byDate = new Map(calendar.days.map((bucket) => [bucket.date, bucket]));
  const dates = periodDates(calendar);
  const field = METRIC_FIELDS[metric];
  const runningStart = runningUsageBucketStart({
    ...calendar.period, granularity: 'day', timeZoneOffsetMinutes: calendar.timeZoneOffsetMinutes,
  }, referenceMs, period);
  const running = runningStart === null ? null : resolveUsageCalendarInstant(runningStart, calendar.timeZoneOffsetMinutes).date;
  const days: UsageSkyDay[] = dates.map((date) => {
    const bucket = byDate.get(date);
    if (!bucket) return { date, state: emptyCalendarMetric(calendar, metric) === 0 ? 'inactive' : 'unknown' };
    const value = readUsageCalendarMetric(bucket.totals, metric);
    if (value === null) return { date, state: 'unknown' };
    if (value <= 0) return { date, state: 'inactive', value: 0 };
    const leader = bucket.leaders[field];
    return { date, state: 'active', value, ...(date === running ? { partial: true } : {}),
      leader: leader.status === 'leading' && leader.agentIds[0] ? { kind: 'agent', agentId: leader.agentIds[0] }
        : leader.status === 'tied' && leader.agentIds.length >= 2 ? { kind: 'tie', agentIds: [leader.agentIds[0]!, leader.agentIds[1]!, ...leader.agentIds.slice(2)] }
        : leader.status === 'unattributed' || (leader.status === 'tied' && leader.agentIds.length < 2) ? { kind: 'unknown' } : null };
  });
  // Streak lengths come from the shared day-streak owner; their positions are the matching runs of active days. Both
  // read the days as drawn, so a bracket never spans a day the sky draws as not recorded (USAGE-DESIGN-PASS-57 #15).
  const streaks = resolveUsageDayStreaks({ referenceMs, timeZoneOffsetMinutes: calendar.timeZoneOffsetMinutes,
    range: calendar.period, days: days.map(({ date, state }) => ({
      date, eventCount: state === 'active' ? 1 : state === 'inactive' ? 0 : null,
    })) });
  const runs: { startDate: string; endDate: string; days: number }[] = [];
  let start: number | null = null;
  days.forEach((day, index) => {
    const active = day.state === 'active';
    if (active && start === null) start = index;
    if ((!active || index === days.length - 1) && start !== null) {
      const end = active ? index : index - 1;
      runs.push({ startDate: days[start]!.date, endDate: days[end]!.date, days: end - start + 1 });
      start = null;
    }
  });
  const best = streaks.longestStreakDays ? [...runs].reverse().find((run) => run.days === streaks.longestStreakDays) ?? null : null;
  const last = runs[runs.length - 1];
  const current = streaks.currentStreakDays && last && last.days === streaks.currentStreakDays ? last : null;
  // Asked for leaders but none is known: the sky draws intensity, so the model says so for its caption (USAGE-ACCEPT 1118 #19).
  const drawnColourBy = colourBy === 'leadingAgent' && days.some((day) => day.leader != null) ? 'leadingAgent' : 'intensity';
  return { encoding: 'amount', days, colourBy: drawnColourBy, best, current };
}

/**
 * The period's unread end (today before its first reading lands: some series unknown, none above zero) is left off the
 * flow. Drawn, a stacked area ends in a vertical cut where one series is unknown while its neighbours fall to zero
 * (USAGE-ACCEPT #18). A measured zero day with every series read stays. The buckets before anything was recorded (a
 * Year whose history starts in October) are left off the front, so the flow spans the stretch it can draw; the daily
 * bars keep the whole period with its unrecorded weeks marked.
 */
export function trimUsageFlowUnreadTail<Series extends Readonly<{ points: readonly Readonly<{ y: number | null }>[] }>>(series: readonly Series[]): Series[] {
  const length = Math.max(0, ...series.map(entry => entry.points.length));
  let end = length;
  while (end > 2) {
    const at = series.map(entry => entry.points[end - 1]?.y ?? null);
    if (!at.some(value => value === null) || at.some(value => value !== null && value > 0)) break;
    end -= 1;
  }
  let start = 0;
  while (end - start > 2 && series.every(entry => (entry.points[start]?.y ?? null) === null)) start += 1;
  return start === 0 && end === length ? [...series] : series.map(entry => ({ ...entry, points: entry.points.slice(start, end) }) as Series);
}

type UsageFlowPoint = HappierSeriesPoint & Pick<UsageSkyDay, 'partial'>;
type UsageFlowSeries = Omit<HappierSeries, 'points'> & Readonly<{ points: readonly UsageFlowPoint[] }>;

export function projectUsageFlowModel(
  series: readonly HappierSeries[],
  range: UsageCalendarRange | null,
  referenceMs: number,
  timeUnitMs: number,
  period: UsageQuery['period'],
): Readonly<{ drawn: readonly UsageFlowSeries[]; trailingReading: readonly UsageFlowSeries[] | null }> {
  const trimmed = trimUsageFlowUnreadTail(series);
  const running = range ? runningUsageBucketStart(range, referenceMs, period) : null;
  if (running === null) return { drawn: trimmed, trailingReading: null };

  const isRunning = (point: HappierSeriesPoint | undefined) =>
    typeof point?.x === 'number' && point.x * timeUnitMs === running;
  // Remove the last bucket from the area. It keeps its admitted values, including a zero beside an unknown series.
  const drawn = trimmed.map(entry => isRunning(entry.points.at(-1)) ? { ...entry, points: entry.points.slice(0, -1) } : entry);
  const reading = series.map(entry => {
    const point = entry.points.at(-1);
    return { ...entry, points: point && isRunning(point) ? [{ ...point, partial: true }] : [] } satisfies UsageFlowSeries;
  });
  if (!reading.some(entry => entry.points[0]?.y != null)) return { drawn, trailingReading: null };
  // Before the first complete reading, the shared chart draws the admitted running reading as a lone mark.
  if (!drawn.some(entry => entry.points.some(point => point.y != null))) return { drawn: reading, trailingReading: null };
  return { drawn, trailingReading: reading };
}

function emptyCalendarMetric(calendar: UsageAgentCalendar, metric: UsageChartMetric): number | null {
  const coverage = metric === 'busy' || metric === 'peakParallel' ? calendar.coverage.busy
    : metric === 'steering' ? calendar.coverage.steering : calendar.coverage.accounting;
  // Complete absence proves no recorded quantity, but does not supply a monetary basis.
  return coverage === 'complete_for_supplied_facts' && metric !== 'cost' ? 0 : null;
}

/** Monday-first 7×24; the canonical owner already resolves each measure's reduction and coverage. */
export function projectUsageWeekHours(calendar: UsageAgentCalendar, metric: UsageChartMetric): UsageWeekHourModel | null {
  const empty = emptyCalendarMetric(calendar, metric);
  const grid = Array.from({ length: 7 }, () => Array.from<number | null>({ length: 24 }).fill(empty));
  const peakIneligibleCells: (readonly [weekday: number, hour: number])[] = [];
  let known = empty === 0;
  for (const bucket of calendar.weekdayHourBuckets) {
    const value = readUsageCalendarMetric(bucket.totals, metric);
    if (value !== null) known = true;
    const row = (bucket.weekday + 6) % 7;
    grid[row]![bucket.hour] = value;
    if (metric === 'cost' && bucket.totals.cost?.partial) peakIneligibleCells.push([row, bucket.hour]);
  }
  return known ? { encoding: 'amount', grid, ...(peakIneligibleCells.length ? { peakIneligibleCells } : {}) } : null;
}

export function projectUsageDaylight(calendar: UsageAgentCalendar, metric: UsageChartMetric, slice: UsageQueryResultSlice): UsageDaylightModel | null {
  const empty = emptyCalendarMetric(calendar, metric);
  const hours = Array.from<number | null>({ length: 24 }).fill(empty);
  const peakIneligibleHours: number[] = [];
  let known = empty === 0;
  for (const bucket of calendar.hourOfDayBuckets) {
    const value = readUsageCalendarMetric(bucket.totals, metric);
    if (value !== null) known = true;
    hours[bucket.hour] = value;
    if (metric === 'cost' && bucket.totals.cost?.partial) peakIneligibleHours.push(bucket.hour);
  }
  if (!known) return null;
  const window = slice.howYouWork?.nightShift ?? null;
  // Keep the private observed Agent-time share on the same basis as these columns,
  // not the separate elapsed busy union. Public Q17 retains its recorded-activity owner.
  let busyTotal: number | null = 0;
  let nightBusy = 0;
  if (metric === 'busy') for (const bucket of calendar.hourOfDayBuckets) {
    const amount = bucket.totals.busyMs;
    if (amount === null) { busyTotal = null; break; }
    busyTotal += amount;
    if (window && isUsageNightHour(bucket.hour, window)) nightBusy += amount;
  }
  const share = window && busyTotal !== null && busyTotal > 0 ? nightBusy / busyTotal : null;
  return { encoding: 'amount', hours, night: window ? { fromHour: window.startHour, toHour: window.endHour, share } : null,
    ...(peakIneligibleHours.length ? { peakIneligibleHours } : {}) };
}

/** The actual day shown: the chosen `day`, else the period's busiest day by witnessed peak. */
export function resolveUsageChartDay(calendar: UsageAgentCalendar, day: string | undefined): CalendarBucket | null {
  if (day) return calendar.days.find((bucket) => bucket.date === day) ?? null;
  let best: CalendarBucket | null = null;
  for (const bucket of calendar.days) if ((bucket.totals.peakParallel ?? 0) > (best?.totals.peakParallel ?? 0)) best = bucket;
  return best;
}

const DAY_BINS = 96;
export function projectUsageDayModel(slice: UsageQueryResultSlice, bucket: CalendarBucket): UsageDayModel | null {
  const lanes = slice.howYouWork?.intervals?.lanes;
  if (!lanes) return null;
  const dayStartMs = resolveUsageCalendarInstant(bucket.startMs, slice.shownQuery.timeZoneOffsetMinutes).bucketStartMs;
  const hourOf = (ms: number) => Math.max(0, Math.min(24, (ms - dayStartMs) / HOUR_MS));
  const byAgent = new Map<string | null, { spans: { fromHour: number; toHour: number; waits: [number, number][] }[] }>();
  const working: { agentId: string | null; from: number; to: number; waits: readonly (readonly [number, number])[] }[] = [];
  for (const lane of lanes) {
    for (const span of lane.busy) {
      if (span.endMs <= bucket.startMs || span.startMs >= bucket.endMs) continue;
      const entry = byAgent.get(lane.agentId) ?? { spans: [] };
      entry.spans.push({ fromHour: hourOf(span.startMs), toHour: hourOf(span.endMs), waits: [] });
      byAgent.set(lane.agentId, entry);
      working.push({ agentId: lane.agentId, from: hourOf(span.startMs), to: hourOf(span.endMs), waits: [] });
    }
    // The canonical interval owner subtracts waits from busy time. Retain those witnessed spans
    // separately for the hatch, without putting them back in concurrency or Agent-time totals.
    for (const wait of lane.waits) {
      if (wait.endMs <= bucket.startMs || wait.startMs >= bucket.endMs) continue;
      const entry = byAgent.get(lane.agentId) ?? { spans: [] };
      const fromHour = hourOf(wait.startMs), toHour = hourOf(wait.endMs);
      entry.spans.push({ fromHour, toHour, waits: [[fromHour, toHour]] });
      byAgent.set(lane.agentId, entry);
    }
  }
  // Display bins sample the witnessed spans at each bin's middle; the peak figure is the owner's own.
  const atOnce = Array.from({ length: DAY_BINS }, (_, bin) => {
    const at = ((bin + 0.5) / DAY_BINS) * 24;
    return working.filter((span) => at >= span.from && at < span.to && !span.waits.some(([from, to]) => at >= from && at < to)).length;
  });
  const concurrency = summarizeUsageConcurrency(lanes.flatMap(lane => lane.busy.flatMap(span => {
    const startMs = Math.max(span.startMs, bucket.startMs), endMs = Math.min(span.endMs, bucket.endMs);
    return endMs > startMs ? [{ startMs, endMs }] : [];
  })));
  const peakCount = concurrency.maxParallel;
  const at = hourOf(concurrency.peakAtMs ?? bucket.startMs);
  const peakBy = new Map<string | null, number>();
  for (const span of working) if (at >= span.from && at < span.to && !span.waits.some(([from, to]) => at >= from && at < to)) peakBy.set(span.agentId, (peakBy.get(span.agentId) ?? 0) + 1);
  const agentTime = new Map(bucket.agents.map(entry => [entry.agentId, entry.metrics.busyMs ?? 0] as const));
  return {
    date: bucket.date,
    lanes: [...byAgent.entries()].map(([agentId, entry]) => ({ agentId, spans: entry.spans, agentTimeMs: agentTime.get(agentId) ?? 0 }))
      .sort((a, b) => b.agentTimeMs - a.agentTimeMs),
    atOnce,
    peak: { count: peakCount, atHour: at, byAgent: [...peakBy.entries()].map(([agentId, count]) => ({ agentId, count })).sort((a, b) => b.count - a.count) },
    waitCount: [...byAgent.values()].reduce((sum, entry) => sum + entry.spans.reduce((inner, span) => inner + span.waits.length, 0), 0),
  };
}

/** A short period keeps its dates. Longer periods group all supplied time by weekday and hour. */
export function projectUsageScoreModel(calendar: UsageAgentCalendar, day: string | undefined): (UsageScoreModel & {
  dayCount: number; byWeekday: boolean; endDate: string;
}) | null {
  const offset = calendar.timeZoneOffsetMinutes;
  const selected = day === undefined ? null : calendar.days.find(bucket => bucket.date === day);
  if (selected === undefined) return null;
  const selectedWeek = selected ? resolveUsageBucketBounds('week', selected.startMs, offset) : null;
  const startMs = Math.max(calendar.period.startMs, selectedWeek?.bucketStartMs ?? calendar.period.startMs);
  const endMs = Math.min(calendar.period.endMs, selectedWeek?.bucketEndMs ?? calendar.period.endMs);
  if (endMs <= startMs) return null;
  const firstDayMs = resolveUsageBucketBounds('day', startMs, offset).bucketStartMs;
  const dateCount = Math.ceil((endMs - firstDayMs) / DAY_MS);
  const byWeekday = dateCount > 7;
  const dayCount = byWeekday ? 7 : dateCount;
  const firstColumnMs = byWeekday ? resolveUsageBucketBounds('week', firstDayMs, offset).bucketStartMs : firstDayMs;
  const emptyHours = Array.from({ length: dayCount }, () => Array<number | null>(24).fill(null));
  if (calendar.coverage.busy === 'complete_for_supplied_facts') {
    // Only a full admitted hour proves a zero. In weekday mode the cells repeat after one week.
    const firstFullHourMs = firstDayMs + Math.ceil((startMs - firstDayMs) / HOUR_MS) * HOUR_MS;
    const eligibleEndMs = Math.min(endMs, firstFullHourMs + dayCount * DAY_MS);
    for (let instant = firstFullHourMs; instant + HOUR_MS <= eligibleEndMs; instant += HOUR_MS) {
      const slot = ((instant - firstColumnMs) / HOUR_MS) % (dayCount * 24);
      emptyHours[Math.floor(slot / 24)]![slot % 24] = 0;
    }
  }
  const rows = new Map<string | null, (number | null)[][]>();
  const put = (dayIndex: number, hour: number, agents: UsageAgentCalendar['hours'][number]['agents']) => {
    for (const entry of agents) {
      if (!entry.metrics.busyMs) continue;
      const hours = rows.get(entry.agentId) ?? emptyHours.map(hours => hours.slice());
      hours[dayIndex]![hour] = entry.metrics.busyMs / 60_000;
      rows.set(entry.agentId, hours);
    }
  };
  if (byWeekday) {
    for (const bucket of calendar.weekdayHourBuckets) put((bucket.weekday + 6) % 7, bucket.hour, bucket.agents);
  } else {
    for (const bucket of calendar.hours) {
      if (bucket.hour === null || bucket.startMs < startMs || bucket.startMs >= endMs) continue;
      put(Math.floor((bucket.startMs - firstDayMs) / DAY_MS), bucket.hour, bucket.agents);
    }
  }
  if (rows.size === 0) return null;
  const total = (hours: (number | null)[][]) => hours.flat().reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return { weekStart: resolveUsageCalendarInstant(firstColumnMs, offset).date, dayCount, byWeekday,
    endDate: resolveUsageCalendarInstant(endMs - 1, offset).date, encoding: 'minutes',
    rows: [...rows.entries()].sort((a, b) => total(b[1]) - total(a[1])).map(([agentId, hours]) => ({ agentId, hours })) };
}

/** Every member consumes the owner's full-period shares, retaining canonical Unknown attribution. */
export function projectUsageAgentShares(calendar: UsageAgentCalendar, metric: UsageChartMetric,
  formatCoverage?: (status: UsageAgentCalendar['coverage']['accounting']) => UsageAgentShare['coverage']): readonly UsageAgentShare[] {
  const days = new Map(calendar.agentActiveDays.map((entry) => [entry.agentId, entry.days]));
  return calendar.periodSummary.agents.map((entry) => ({
    agentId: entry.agentId,
    share: metric === 'tokens' || metric === 'cost' ? entry.shares[metric] : null,
    activeDays: days.get(entry.agentId) ?? null,
    ...(formatCoverage ? { coverage: formatCoverage(entry.coverage.accounting) } : {}),
  }))
    .sort((a, b) => compareUsageMeasurementsDescending(a.share, b.share));
}

export function projectUsageRiverModel(calendar: UsageAgentCalendar, metric: UsageChartMetric,
  coverage?: UsageRiverModel['coverage']): UsageRiverModel | null {
  const weeks = calendar.weeks.map(week => {
    const total = readUsageCalendarMetric(week.totals, metric);
    const tokenMix = calendar.weeklyAgentMix.find(mix => mix.startMs === week.startMs);
    const measuredShares = metric === 'tokens'
      ? tokenMix?.mix.map(({ agentId, share }) => ({ agentId, share })) ?? []
      : week.agents.flatMap(entry => {
        const value = readUsageCalendarMetric(entry.metrics, metric);
        return value !== null && total !== null && total > 0 ? [{ agentId: entry.agentId, share: value / total }] : [];
      });
    const shares = total !== null && (measuredShares.length || total === 0 && !coverage) ? measuredShares : null;
    return { ...projectUsageRiverWeekRange(week, calendar.timeZoneOffsetMinutes), total, shares };
  });
  return weeks.length >= 2 ? { width: 'amount', weeks, ...(coverage ? { coverage } : {}) } : null;
}

/**
 * Whether the river has a course to draw: two complete weeks, as its empty state says. Two clipped weeks of a short
 * period are one swoop between two points (USAGE-ACCEPT 1121 #11); the daily charts beside it carry those days.
 */
export function usageRiverHasShape(model: UsageRiverModel): boolean {
  return model.weeks.filter(week => !week.partial).length >= 2;
}

/** The private portrait consumes the same day/streak and interval facts as the other Usage charts. */
export function projectUsagePortraitModel(calendar: UsageAgentCalendar, referenceMs: number): UsagePortraitModel {
  const total = countUsageChartCalendarDates(calendar.period, calendar.timeZoneOffsetMinutes);
  const peakParallel = calendar.periodSummary.totals.peakParallel;
  const streaks = resolveUsageDayStreaks({ referenceMs, timeZoneOffsetMinutes: calendar.timeZoneOffsetMinutes, range: calendar.period,
    days: calendar.days.map(day => ({ date: day.date, eventCount: day.totals.eventCount })),
    coverage: calendar.coverage.accounting === 'complete_for_supplied_facts' ? 'complete' : 'partial' });
  return {
    ...(streaks.activeDays !== null ? { activeDays: { active: streaks.activeDays, of: total } } : {}),
    ...(peakParallel === null ? {} : { peakParallel }),
    ...(streaks.currentStreakDays !== null ? { streak: { current: streaks.currentStreakDays, best: streaks.longestStreakDays } } : {}),
  };
}

export function projectUsageShippedModel(slice: UsageQueryResultSlice): UsageShippedModel | null {
  const merged = slice.mergedOutcomes;
  if (!merged) return null;
  const { mergedInPeriodCount, undatedMergedCount } = merged;
  if (mergedInPeriodCount === undefined && merged.mergeWeeks.length === 0 && undatedMergedCount === 0) return null;
  const weeks = merged.mergeWeeks.map((week) => ({ start: resolveUsageCalendarInstant(week.bucketStartMs, merged.timeZoneOffsetMinutes).date,
    spines: merged.outcomes.filter((outcome) => outcome.mergedAtMs !== null && outcome.mergedAtMs >= week.bucketStartMs && outcome.mergedAtMs < week.bucketEndMs)
      .map((outcome) => outcome.attribution === 'single' && outcome.leadingAgentIds[0] ? outcome.leadingAgentIds[0] : 'mixed' as const) }));
  return { mode: 'weeks', weeks, undated: undatedMergedCount,
    total: mergedInPeriodCount === undefined ? null : mergedInPeriodCount + undatedMergedCount };
}

const COLLABORATION_KIND = { spawn: 'session', run: 'run', review: 'run', plan: 'run', native: 'native' } as const;
export function projectUsageConstellationModel(slice: UsageQueryResultSlice, shares: readonly UsageAgentShare[]): UsageConstellationModel {
  const summary = slice.howYouWork?.collaboration ?? null;
  const members = new Set(shares.map(share => share.agentId));
  const edges = new Map<string, { from: string; to: string; kind: 'session' | 'run' | 'native'; count: number }>();
  // Reporting, replay and handoff are not collaboration between two Agents (moved or reported work); they are not drawn as edges.
  for (const edge of summary?.edges ?? []) {
    const kind = (COLLABORATION_KIND as Record<string, 'session' | 'run' | 'native' | undefined>)[edge.relation];
    if (!kind || !edge.sourceAgentId || !edge.targetAgentId
      || !members.has(edge.sourceAgentId) || !members.has(edge.targetAgentId)) continue;
    const key = `${edge.sourceAgentId}\u0000${edge.targetAgentId}\u0000${kind}`;
    const entry = edges.get(key) ?? { from: edge.sourceAgentId, to: edge.targetAgentId, kind, count: 0 };
    entry.count += edge.count;
    edges.set(key, entry);
  }
  return { nodes: shares.map(({ agentId, share }) => ({ agentId, share })),
    edges: summary ? [...edges.values()] : null, unknownStarts: summary?.unknownSourceAgentCount ?? 0 };
}

/** Per-Agent rows keep the owner's Agent order with the unnamed member last, as the other Agent charts list it. */
function unknownAgentLast<T extends Readonly<{ agentId: string | null }>>(rows: readonly T[]): T[] {
  return [...rows.filter((row) => row.agentId !== null), ...rows.filter((row) => row.agentId === null)];
}

export function projectUsageSteeringModel(slice: UsageQueryResultSlice): UsageSteeringTideModel | null {
  const steering = slice.howYouWork?.steering;
  if (!steering) return null;
  const night = slice.howYouWork?.nightShift ?? null;
  return { night: night ? { fromHour: night.startHour, toHour: night.endHour } : null,
    // A member with no busy time, no steer and no phone answer has nothing to draw; it is omitted rather than shown as dashes.
    rows: unknownAgentLast(steering.byAgent.filter((row) => (row.busyMs ?? 0) > 0 || (row.steeringCount ?? 0) > 0
      || row.byAnsweringClient.ios + row.byAnsweringClient.android > 0)).map((row) => {
      const hourly = steering.hourly.filter((entry) => entry.agentId === row.agentId);
      const steersByHour = Array.from<number | null>({ length: 24 }).fill(steering.inputsObserved ? 0 : null);
      const phoneAnswersByHour = Array.from<number | null>({ length: 24 }).fill(steering.permissionsObserved ? 0 : null);
      for (const entry of hourly) {
        if (entry.steeringCount !== null) steersByHour[entry.hour] = (steersByHour[entry.hour] ?? 0) + entry.steeringCount;
        if (steering.permissionsObserved) phoneAnswersByHour[entry.hour] = (phoneAnswersByHour[entry.hour] ?? 0) + entry.byAnsweringClient.ios + entry.byAnsweringClient.android;
      }
      return { agentId: row.agentId, steersByHour, phoneAnswersByHour, steers: row.steeringCount, busyMs: row.busyMs, perBusyHour: row.steersPerBusyHour,
        phoneAnswers: steering.permissionsObserved ? row.byAnsweringClient.ios + row.byAnsweringClient.android : null };
    }) };
}

/** Whether anyone steered or answered from a phone in the period; busy agents alone are a measured zero, said once. */
export function usageSteeringRecorded(model: UsageSteeringTideModel): boolean {
  return model.rows.some((row) => (row.steers ?? 0) > 0 || (row.phoneAnswers ?? 0) > 0);
}

export function projectUsageRunLengthModel(slice: UsageQueryResultSlice): (UsageRunLengthModel & Readonly<{ openCount: number; croppedCount: number }>) | null {
  const runs = slice.howYouWork?.runLengths;
  if (!runs || runs.sampleCount === 0) return null;
  // A member whose every closed turn took no wall time has no length to draw on the run axis; it is omitted like a
  // member with no closed turn, rather than listed as a column of "0 s".
  return { rows: unknownAgentLast(runs.byAgent.filter((row) => row.sampleCount > 0 && (row.p90Ms ?? 0) > 0)).map((row) => ({ agentId: row.agentId, samples: row.sampleCount, medianMs: row.medianMs,
    p90Ms: row.p90Ms, durationsMs: row.durationsMs })), openCount: runs.openCount, croppedCount: runs.croppedCount };
}

export type UsageRecordFacts = Readonly<{
  longestStreak: Readonly<{ days: number; startDate: string; endDate: string; ongoing: boolean }> | null;
  busiestDay: Readonly<{ date: string; value: number }> | null;
  peakParallel: Readonly<{ date: string; count: number }> | null;
  longestClosedTurn: Readonly<{ agentId: string | null; ms: number }> | null;
  mostAgents: Readonly<{ date: string; count: number }> | null;
}>;

/** In-period observed bests, each read from its owner; a record without an owner fact is omitted, never estimated. */
export function projectUsageRecordFacts(slice: UsageQueryResultSlice, metric: UsageChartMetric, referenceMs: number): UsageRecordFacts | null {
  const calendar = slice.howYouWork?.agentCalendar;
  if (!calendar) return null;
  const sky = projectUsageSkyModel(calendar, metric, 'intensity', referenceMs, slice.shownQuery.period);
  let busiest: { date: string; value: number } | null = null;
  let peak: { date: string; count: number } | null = null;
  let most: { date: string; count: number } | null = null;
  for (const bucket of calendar.days) {
    const value = readUsageCalendarMetric(bucket.totals, metric);
    if (value !== null && value > (busiest?.value ?? 0)) busiest = { date: bucket.date, value };
    if ((bucket.totals.peakParallel ?? 0) > (peak?.count ?? 0)) peak = { date: bucket.date, count: bucket.totals.peakParallel! };
    const agents = bucket.agents.filter((entry) => entry.agentId !== null && ((entry.metrics.eventCount ?? 0) > 0 || (entry.metrics.busyMs ?? 0) > 0)).length;
    if (agents > (most?.count ?? 0)) most = { date: bucket.date, count: agents };
  }
  let longest: { agentId: string | null; ms: number } | null = null;
  for (const row of slice.howYouWork?.runLengths?.byAgent ?? []) for (const ms of row.durationsMs) if (ms > (longest?.ms ?? 0)) longest = { agentId: row.agentId, ms };
  return {
    longestStreak: sky.best?.startDate !== undefined ? { days: sky.best.days, startDate: sky.best.startDate, endDate: sky.best.endDate,
      ongoing: sky.current !== null && sky.current !== undefined && sky.current.startDate === sky.best.startDate } : null,
    busiestDay: busiest, peakParallel: peak, longestClosedTurn: longest, mostAgents: most,
  };
}
