import { PUBLIC_PROFILE_FACT_FIELDS_V1, resolveUsageCalendarInstant, summarizeUsageRunLengthObservations,
  type PublicProfileSnapshotV1, type PublicProfileViewV1 } from '@happier-dev/plugin-sdk';
import type { UsageAgentShare, UsageConstellationModel, UsageRiverModel, UsageShippedModel } from '../presentation/usage/charts/UsageAgentsCharts.js';
import type { UsageDaylightModel, UsageWeekHourModel } from '../presentation/usage/charts/UsageRhythmEncodings.js';
import type { UsageSkyModel } from '../presentation/usage/charts/UsageSkyOfDays.js';
import type { UsageRecordsModel, UsageRunLengthModel } from '../presentation/usage/charts/UsageWorkCharts.js';
import type { UsageCalendarArtModel, PublicUsageChartModels, PublicUsageRecordKind } from '../presentation/usage/charts/publicUsageChartModels.js';
import { countUsageChartCalendarDates, projectUsageRiverWeekRange } from './usageChartCalendar.js';
export type { PublicUsageChartModels, PublicUsageRecordKind } from '../presentation/usage/charts/publicUsageChartModels.js';

/** Complete the selected period with unknown dates; never infer a missing day to be inactive. */
export function projectUsageCalendarArtModel(input: UsageCalendarArtModel): UsageCalendarArtModel {
  const { period } = input;
  const supplied = new Map(input.days.map(day => [day.date, day.level]));
  const days: UsageCalendarArtModel['days'][number][] = [];
  for (let instant = resolveUsageCalendarInstant(period.startMs, period.timeZoneOffsetMinutes).bucketStartMs;
    instant < period.endMs; instant = resolveUsageCalendarInstant(instant, period.timeZoneOffsetMinutes).bucketEndMs) {
    const date = resolveUsageCalendarInstant(instant, period.timeZoneOffsetMinutes).date;
    days.push({ date, level: supplied.get(date) ?? null });
  }
  return { ...input, days };
}


/** Host-localized record lines for the same Personal-records body, with no private dates or chronology. */
export function projectPublicUsageRecords(snapshot: PublicProfileSnapshotV1,
  format: (kind: PublicUsageRecordKind, value: number) => Omit<UsageRecordsModel[number], 'id'>): UsageRecordsModel {
  const { facts } = snapshot;
  const rows: UsageRecordsModel[number][] = [];
  for (const kind of ['activeDays', 'currentStreakDays', 'bestStreakDays', 'peakParallel'] as const) {
    const value = facts[kind];
    if (value !== undefined) rows.push({ id: kind, ...format(kind, value) });
  }
  if (facts.sessionDurations !== undefined) {
    const summary = summarizeUsageRunLengthObservations(facts.sessionDurations);
    if (summary.sampleCount > 0) {
      const longest = summary.byAgent.reduce((max, row) => Math.max(max, row.durationsMs[row.durationsMs.length - 1]!), 0);
      rows.push({ id: 'longestTurnMs', ...format('longestTurnMs', longest) });
    }
  }
  return rows;
}


/**
 * Adapts the already policy-projected snapshot, never private query results. This is not a mask:
 * the publication owner must project before calling it. Optional facts remain independent, including
 * geometry denominators. Public ordinal levels are never converted back into amounts or leaders.
 */
export function projectPublicUsageChartModels(snapshot: PublicProfileSnapshotV1,
  metadata?: Pick<PublicProfileViewV1['metadata'], 'projects'>): PublicUsageChartModels {
  const { facts, period } = snapshot;
  const sky: UsageSkyModel | null = facts.calendar === undefined ? null : {
    encoding: 'ordinal', colourBy: 'intensity',
    days: facts.calendar.map(day => day.level === null ? { date: day.date, state: 'unknown' }
      : day.level === 0 ? { date: day.date, state: 'inactive' }
        : { date: day.date, state: 'active', level: day.level }),
    // The approved counts carry no private run positions. The body must not invent them.
    ...(facts.currentStreakDays === undefined ? {} : { current: { days: facts.currentStreakDays } }),
    ...(facts.bestStreakDays === undefined ? {} : { best: { days: facts.bestStreakDays } }),
  };
  const activeDays = new Map(facts.agentActiveDays?.map(row => [row.agentId, row.days]));
  const mixes = new Map(facts.agentMix?.map(row => [row.agentId, row]));
  const memberIds = new Set([...mixes.keys(), ...activeDays.keys()]);
  const agentShares: readonly UsageAgentShare[] | null = facts.agentMix === undefined && facts.agentActiveDays === undefined ? null
    : [...memberIds].map(agentId => {
      const mix = mixes.get(agentId);
      return { agentId, share: mix === undefined || mix.coverage.method === 'context_only' ? null : mix.share,
        ...(activeDays.has(agentId) ? { activeDays: activeDays.get(agentId)! } : {}) };
    });
  const grid = Array.from({ length: 7 }, () => Array.from<number | null>({ length: 24 }).fill(null));
  for (const cell of facts.punch ?? []) grid[(cell.weekday + 6) % 7]![cell.hour] = cell.level;
  // An ordinal maximum, not a sum or an amount: the strongest shared weekday cell at each hour.
  const hours = Array.from<number | null>({ length: 24 }).fill(null);
  for (const cell of facts.punch ?? []) if (cell.level !== null) hours[cell.hour] = Math.max(hours[cell.hour] ?? 0, cell.level);
  const night = facts.dayNightActivity;
  const distribution = facts.sessionDurations === undefined ? null : summarizeUsageRunLengthObservations(facts.sessionDurations);
  const calendarArt = facts.calendar === undefined ? null : projectUsageCalendarArtModel({ period, days: facts.calendar,
    ...(facts.currentStreakDays === undefined ? {} : { currentStreakDays: facts.currentStreakDays }),
    ...(facts.bestStreakDays === undefined ? {} : { bestStreakDays: facts.bestStreakDays }),
  });
  const runLength: UsageRunLengthModel | null = distribution === null ? null : { rows: distribution.byAgent.map(row => ({ agentId: row.agentId,
    samples: row.sampleCount, medianMs: row.medianMs, p90Ms: row.p90Ms, durationsMs: row.durationsMs })), openCount: null, croppedCount: null };
  const summary: PublicUsageChartModels['summary'] = Object.fromEntries(
    (['tokens', 'activeDays', 'agentTimeMs', 'mergedPrs', 'currentStreakDays', 'bestStreakDays', 'peakParallel'] as const).flatMap(kind => {
      const value = facts[kind];
      // Coverage has already passed the publication owner's same consent projection as the facts.
      return value !== undefined || snapshot.fieldCoverage[PUBLIC_PROFILE_FACT_FIELDS_V1[kind]]
        ? [[kind, value ?? null] as const] : [];
    }));
  return {
    summary,
    coverage: snapshot.coverage,
    highlights: facts.highlights ?? null,
    footprint: facts.footprint === undefined ? null : { ...(facts.tokens === undefined ? {} : { accountedTokens: facts.tokens }) },
    sourceShares: facts.sourceSplit ?? null,
    agentMix: facts.agentMix ?? null,
    sky,
    weekHours: facts.punch === undefined ? null : { encoding: 'ordinal', grid },
    daylight: facts.punch === undefined && !night ? null : { encoding: 'ordinal', hours,
      night: night ? { fromHour: night.window.startHour, toHour: night.window.endHour, share: night.nightShare } : null },
    agentShares,
    // Equal width explicitly means composition only. Tokens and calendar cannot become a hidden width channel.
    river: facts.weeklyAgentMix === undefined ? null : { width: 'share', weeks: facts.weeklyAgentMix.map(week => ({
      ...projectUsageRiverWeekRange(week, period.timeZoneOffsetMinutes), total: null,
      shares: week.mix.filter(row => row.coverage.method !== 'context_only').map(row => ({ agentId: row.agentId, share: row.share })),
    })) },
    shipped: facts.mergedPrs === undefined ? null : { mode: 'count', total: facts.mergedPrs },
    constellation: agentShares === null ? null : { nodes: agentShares, edges: null, unknownStarts: null },
    portrait: {
      ...(facts.activeDays === undefined ? {} : { activeDays: { active: facts.activeDays,
        of: countUsageChartCalendarDates(period, period.timeZoneOffsetMinutes) } }),
      ...(facts.peakParallel === undefined ? {} : { peakParallel: facts.peakParallel }),
      ...(facts.currentStreakDays === undefined ? {} : { streak: { current: facts.currentStreakDays, best: facts.bestStreakDays ?? null } }),
    },
    runLength,
    calendarArt,
    moons: agentShares === null ? null : { agents: agentShares, periodDays: countUsageChartCalendarDates(period, period.timeZoneOffsetMinutes) },
    machines: { kinds: facts.machineKinds ?? null,
      coverage: snapshot.fieldCoverage.machineKinds ?? { status: 'unavailable', method: 'unknown' } },
    projects: { links: metadata?.projects ?? null },
    atmosphere: facts.weeklyPeakParallel === undefined ? null : { weeks: facts.weeklyPeakParallel,
      ...(facts.peakParallel === undefined ? {} : { peakParallel: facts.peakParallel }) },
    galaxy: runLength,
    peak: facts.peakParallel ?? null,
  };
}
