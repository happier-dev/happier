import type {
  UsageAgentShare, UsageDayModel, UsageRunLengthModel, UsageScoreModel, UsageShippedModel, UsageSkyDay, UsageSkyModel,
  UsageSteeringTideModel, UsageConstellationModel, UsageRiverModel, UsageWeekHourModel, UsageDaylightModel, UsagePortraitModel,
} from '@happier-dev/plugin-ui/presentation';
import type { UsageHowYouWork } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { resolveUsageDayStreaks, projectUsageOrdinalLevels } from '@happier-dev/protocol/usage/usageActivitySummary';
import { compareUsageMeasurementsDescending } from '@happier-dev/protocol/usage/usageAggregation';
import { resolveUsageCalendarInstant, resolveUsageBucketBounds } from '@happier-dev/protocol/usage/usageCalendar';
import { isUsageNightHour, summarizeUsageConcurrency } from '@happier-dev/protocol/usage/usageWorkIntervals';
import { UsagePresentationMetricSchema } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageChartMetric } from './usageChartHost';
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

export function projectUsageSkyModel(calendar: UsageAgentCalendar, metric: UsageChartMetric, colourBy: 'intensity' | 'leadingAgent', referenceMs: number): UsageSkyModel {
  const byDate = new Map(calendar.days.map((bucket) => [bucket.date, bucket]));
  const dates = periodDates(calendar);
  const field = METRIC_FIELDS[metric];
  const days: UsageSkyDay[] = dates.map((date) => {
    const bucket = byDate.get(date);
    if (!bucket) return { date, state: emptyCalendarMetric(calendar, metric) === 0 ? 'inactive' : 'unknown' };
    const value = readUsageCalendarMetric(bucket.totals, metric);
    if (value === null) return { date, state: 'unknown' };
    if (value <= 0) return { date, state: 'inactive', value: 0 };
    const leader = bucket.leaders[field];
    return { date, state: 'active', value,
      leader: leader.status === 'leading' && leader.agentIds[0] ? { kind: 'agent', agentId: leader.agentIds[0] }
        : leader.status === 'tied' && leader.agentIds.length >= 2 ? { kind: 'tie', agentIds: [leader.agentIds[0]!, leader.agentIds[1]!, ...leader.agentIds.slice(2)] }
        : leader.status === 'unattributed' || (leader.status === 'tied' && leader.agentIds.length < 2) ? { kind: 'unknown' } : null };
  });
  // Streak lengths come from the shared day-streak owner; their positions are the matching runs of active days.
  const streaks = resolveUsageDayStreaks({ referenceMs, timeZoneOffsetMinutes: calendar.timeZoneOffsetMinutes,
    range: calendar.period, days: dates.map((date) => { const bucket = byDate.get(date); return { date, eventCount: bucket ? bucket.totals.eventCount : 0 }; }) });
  const runs: { startDate: string; endDate: string; days: number }[] = [];
  let start: number | null = null;
  dates.forEach((date, index) => {
    const active = (byDate.get(date)?.totals.eventCount ?? 0) > 0;
    if (active && start === null) start = index;
    if ((!active || index === dates.length - 1) && start !== null) {
      const end = active ? index : index - 1;
      runs.push({ startDate: dates[start]!, endDate: dates[end]!, days: end - start + 1 });
      start = null;
    }
  });
  const best = streaks.longestStreakDays ? [...runs].reverse().find((run) => run.days === streaks.longestStreakDays) ?? null : null;
  const last = runs[runs.length - 1];
  const current = streaks.currentStreakDays && last && last.days === streaks.currentStreakDays ? last : null;
  return { encoding: 'amount', days, colourBy, best, current };
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
  let known = empty === 0;
  for (const bucket of calendar.weekdayHourBuckets) {
    const value = readUsageCalendarMetric(bucket.totals, metric);
    if (value !== null) known = true;
    const row = (bucket.weekday + 6) % 7;
    grid[row]![bucket.hour] = value;
  }
  return known ? { encoding: 'amount', grid } : null;
}

export function projectUsageDaylight(calendar: UsageAgentCalendar, metric: UsageChartMetric, slice: UsageQueryResultSlice): UsageDaylightModel | null {
  const empty = emptyCalendarMetric(calendar, metric);
  const hours = Array.from<number | null>({ length: 24 }).fill(empty);
  let known = empty === 0;
  for (const bucket of calendar.hourOfDayBuckets) {
    const value = readUsageCalendarMetric(bucket.totals, metric);
    if (value !== null) known = true;
    hours[bucket.hour] = value;
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
  return { encoding: 'amount', hours, night: window ? { fromHour: window.startHour, toHour: window.endHour, share } : null };
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

/** The week shown: the one containing `day`, else the period's busiest week by witnessed busy time. */
export function projectUsageScoreModel(calendar: UsageAgentCalendar, day: string | undefined): UsageScoreModel | null {
  const selectedDayMs = day ? calendar.days.find(bucket => bucket.date === day)?.startMs : undefined;
  const week = day ? calendar.weeks.find((bucket) => selectedDayMs !== undefined && bucket.startMs <= selectedDayMs && bucket.endMs > selectedDayMs)
    : calendar.weeks.reduce<UsageAgentCalendar['weeks'][number] | null>((best, bucket) => (bucket.totals.busyMs ?? 0) > (best?.totals.busyMs ?? 0) ? bucket : best, null);
  if (!week) return null;
  const weekStartMs = resolveUsageBucketBounds('week', week.startMs, calendar.timeZoneOffsetMinutes).bucketStartMs;
  const rows = new Map<string | null, (number | null)[][]>();
  for (const bucket of calendar.hours) {
    if (bucket.hour === null || bucket.startMs < week.startMs || bucket.startMs >= week.endMs) continue;
    const dayIndex = Math.floor((bucket.startMs - weekStartMs) / DAY_MS);
    for (const entry of bucket.agents) {
      if (!entry.metrics.busyMs) continue;
      const hours = rows.get(entry.agentId) ?? Array.from({ length: 7 }, (_, dayIndex) => Array.from({ length: 24 }, (_, hour) => {
        const instant = weekStartMs + dayIndex * DAY_MS + hour * HOUR_MS;
        return calendar.coverage.busy === 'complete_for_supplied_facts' && instant >= calendar.period.startMs && instant + HOUR_MS <= calendar.period.endMs ? 0 : null;
      }));
      hours[dayIndex]![bucket.hour] = entry.metrics.busyMs / 60_000;
      rows.set(entry.agentId, hours);
    }
  }
  if (rows.size === 0) return null;
  const total = (hours: (number | null)[][]) => hours.flat().reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return { weekStart: resolveUsageCalendarInstant(weekStartMs, calendar.timeZoneOffsetMinutes).date, encoding: 'minutes',
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

export function projectUsageRiverModel(calendar: UsageAgentCalendar, metric: UsageChartMetric): UsageRiverModel | null {
  const weeks = calendar.weeks.map(week => {
    const total = readUsageCalendarMetric(week.totals, metric);
    const tokenMix = calendar.weeklyAgentMix.find(mix => mix.startMs === week.startMs);
    return { ...projectUsageRiverWeekRange(week, calendar.timeZoneOffsetMinutes), total,
      shares: total === null ? null : metric === 'tokens' ? (tokenMix?.mix.map(({ agentId, share }) => ({ agentId, share })) ?? [])
        : week.agents.flatMap(entry => {
          const value = readUsageCalendarMetric(entry.metrics, metric);
          return value !== null && total > 0 ? [{ agentId: entry.agentId, share: value / total }] : [];
        }),
    };
  });
  return weeks.length >= 2 ? { width: 'amount', weeks } : null;
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
  const weeks = merged.mergeWeeks.map((week) => ({ start: resolveUsageCalendarInstant(week.bucketStartMs, merged.timeZoneOffsetMinutes).date,
    spines: merged.outcomes.filter((outcome) => outcome.mergedAtMs !== null && outcome.mergedAtMs >= week.bucketStartMs && outcome.mergedAtMs < week.bucketEndMs)
      .map((outcome) => outcome.attribution === 'single' && outcome.leadingAgentIds[0] ? outcome.leadingAgentIds[0] : 'mixed' as const) }));
  return { mode: 'weeks', weeks, undated: merged.undatedMergedCount, total: merged.mergedInPeriodCount + merged.undatedMergedCount };
}

const COLLABORATION_KIND = { spawn: 'session', run: 'run', review: 'run', plan: 'run', native: 'native' } as const;
export function projectUsageConstellationModel(slice: UsageQueryResultSlice, shares: readonly UsageAgentShare[]): UsageConstellationModel {
  const summary = slice.howYouWork?.collaboration ?? null;
  const edges = new Map<string, { from: string; to: string; kind: 'session' | 'run' | 'native'; count: number }>();
  // Reporting, replay and handoff are not collaboration between two Agents (moved or reported work); they are not drawn as edges.
  for (const edge of summary?.edges ?? []) {
    const kind = (COLLABORATION_KIND as Record<string, 'session' | 'run' | 'native' | undefined>)[edge.relation];
    if (!kind || !edge.sourceAgentId || !edge.targetAgentId) continue;
    const key = `${edge.sourceAgentId}\u0000${edge.targetAgentId}\u0000${kind}`;
    const entry = edges.get(key) ?? { from: edge.sourceAgentId, to: edge.targetAgentId, kind, count: 0 };
    entry.count += edge.count;
    edges.set(key, entry);
  }
  const ids = new Set(shares.map((share) => share.agentId));
  for (const edge of edges.values()) { ids.add(edge.from); ids.add(edge.to); }
  return { nodes: [...ids].map((agentId) => ({ agentId, share: shares.find((share) => share.agentId === agentId)?.share ?? null })),
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

export function projectUsageRunLengthModel(slice: UsageQueryResultSlice): (UsageRunLengthModel & Readonly<{ openCount: number; croppedCount: number }>) | null {
  const runs = slice.howYouWork?.runLengths;
  if (!runs || runs.sampleCount === 0) return null;
  return { rows: unknownAgentLast(runs.byAgent.filter((row) => row.sampleCount > 0)).map((row) => ({ agentId: row.agentId, samples: row.sampleCount, medianMs: row.medianMs,
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
  const sky = projectUsageSkyModel(calendar, metric, 'intensity', referenceMs);
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
