import { AgentIdV1Schema } from '../agents/agentIdV1.js';
import { getUsageQueryKey } from '../inputs/usageQuery.js';
import { resolveUsageCalendarInstant, resolveUsageBucketBounds } from '../usage/usageCalendar.js';
import { resolveUsageDayStreaks, projectUsageOrdinalLevels as levels } from '../usage/usageActivitySummary.js';
import { summarizeUsageExecutionSources } from '../usage/usageSourceSummary.js';
import { projectUsageAgentCalendar, type UsageAgentCalendar } from '../usage/usageAgentCalendar.js';
import { projectUsageFootprint } from '../usage/usageFootprint.js';
import { projectUsageWorkIntervals, type UsageWorkIntervalsProjection } from '../usage/usageWorkIntervals.js';
import { allocateUsageOutcomes, summarizeUsageMergedOutcomes } from '../usage/usageOutcomeAllocation.js';
import { canRetainUsageReadFailure, resolveUsageAccountingAsOfMs, type UsageQueryResultSlice } from '../usage/resolveUsagePageAggregation.js';
import type { UsageAnalyticsContribution } from '../usage/usageAnalyticsContracts.js';
import { PublicProfileSnapshotV1Schema, type PublicCoverage, type PublicProfilePolicyV1,
  type PublicProfileSnapshotV1, type PublicUsageFactsV1 } from './publicProfile.js';
import { projectPublicProfileSnapshot } from './projectPublicProfile.js';
import type { PublicProfileSnapshotUnavailableReasonV1 } from './publicProfileIntents.js';

export type PublicProfileSnapshotBuildResult = Readonly<{ kind: 'ready'; snapshot: PublicProfileSnapshotV1 }>
  | Readonly<{ kind: 'unavailable'; reason: PublicProfileSnapshotUnavailableReasonV1 }>;
type Accounting = NonNullable<UsageQueryResultSlice['accounting']>;
type Period = PublicProfileSnapshotV1['period'];

function method(rows: readonly UsageAnalyticsContribution[], accounting: Accounting): PublicCoverage['method'] {
  const methods = new Set(rows.map(row => {
    const source = accounting.coverage?.sources.find(source => source.source === row.source
      && source.path === (row.sourceContext?.path ?? 'unknown') && (source.machineId ?? null) === row.machineId);
    return source?.captureKind === 'from_logs' || source?.path === 'native' ? 'logs'
      : source?.captureKind === 'measured' || source?.path === 'runtime' ? 'runtime' : 'unknown';
  }));
  return methods.size === 1 ? [...methods][0]! : methods.size > 1 ? 'mixed' : 'unknown';
}

function publicCalendar(period: Period, supplied: readonly { date: string; eventCount: number | null }[], complete: boolean) {
  const days = new Map(supplied.map(day => [day.date, day.eventCount]));
  const values: Array<{ date: string; eventCount: number | null }> = [];
  for (let instant = resolveUsageBucketBounds('day', period.startMs, period.timeZoneOffsetMinutes).bucketStartMs;
    instant < period.endMs; instant = resolveUsageBucketBounds('day', instant, period.timeZoneOffsetMinutes).bucketEndMs) {
    const date = resolveUsageCalendarInstant(instant, period.timeZoneOffsetMinutes).date;
    values.push({ date, eventCount: days.has(date) ? days.get(date)! : complete ? 0 : null });
  }
  const ranked = levels(values.map(day => day.eventCount));
  return { days: values, calendar: values.map((day, index) => ({ date: day.date, level: ranked[index]! })) };
}

function rowFacts(input: Readonly<{ rows: readonly UsageAnalyticsContribution[]; accounting: Accounting; period: Period;
  calendar: UsageAgentCalendar; days?: readonly { date: string; eventCount: number | null }[]; nowMs: number }>) {
  const { rows, accounting, period, calendar } = input;
  const complete = accounting.coverage?.status === 'complete' && accounting.coverage.range.complete;
  const coverage: PublicCoverage = { status: complete ? 'complete_for_supplied_facts' : rows.length ? 'partial' : 'unknown', method: method(rows, accounting) };
  const facts: PublicUsageFactsV1 = {};
  if (!rows.length && !complete) return { facts, coverage };
  facts.tokens = rows.reduce((sum, row) => sum + row.tokens.total, 0);
  const suppliedDays = input.days ?? calendar.days.map(day => ({ date: day.date, eventCount: day.totals.eventCount }));
  const dayProjection = publicCalendar(period, suppliedDays, complete);
  facts.calendar = dayProjection.calendar;
  const streak = resolveUsageDayStreaks({ days: dayProjection.days, referenceMs: input.nowMs,
    range: period, timeZoneOffsetMinutes: period.timeZoneOffsetMinutes, coverage: complete ? 'complete' : 'partial' });
  const knownDays = dayProjection.days.some(day => day.eventCount !== null);
  if (knownDays && streak.activeDays !== null) facts.activeDays = streak.activeDays;
  if (knownDays && streak.currentStreakDays !== null) facts.currentStreakDays = streak.currentStreakDays;
  if (knownDays && streak.longestStreakDays !== null) facts.bestStreakDays = streak.longestStreakDays;
  facts.agentMix = calendar.periodSummary.agents.flatMap(agent => {
    const id = AgentIdV1Schema.safeParse(agent.agentId);
    return id.success && agent.shares.tokens !== null ? [{ agentId: id.data, share: agent.shares.tokens,
      ...(agent.metrics.tokens === null ? {} : { tokens: agent.metrics.tokens }),
      coverage: { status: agent.coverage.accounting, method: method(rows.filter(row => row.agentId === agent.agentId), accounting) } }] : [];
  });
  facts.agentActiveDays = calendar.agentActiveDays.flatMap(agent => {
    const id = AgentIdV1Schema.safeParse(agent.agentId);
    return id.success ? [{ agentId: id.data, days: agent.days,
      coverage: { status: agent.coverage, method: method(rows.filter(row => row.agentId === agent.agentId), accounting) } }] : [];
  });
  facts.weeklyAgentMix = calendar.weeklyAgentMix.map(week => ({ startMs: week.startMs, endMs: week.endMs,
    mix: week.mix.flatMap(agent => {
      const id = AgentIdV1Schema.safeParse(agent.agentId);
      return id.success ? [{ agentId: id.data, share: agent.share,
        coverage: { status: agent.coverage, method: method(rows.filter(row => row.agentId === agent.agentId), accounting) } }] : [];
    }),
  }));
  const footprint = projectUsageFootprint(accounting);
  facts.footprint = { status: footprint.status, reason: footprint.reason };
  return { facts, coverage };
}

function lensIntervals(slice: UsageQueryResultSlice, rows: readonly UsageAnalyticsContribution[], execution: 'happier' | 'outside', period: Period) {
  const original = slice.howYouWork?.intervals;
  if (!original || slice.howYouWork?.detailStatus === 'unknown') return undefined;
  const executions = new Map<string, Set<string>>();
  for (const row of slice.accounting?.contributions ?? []) {
    if (row.sessionId === null || row.turnId === null) continue;
    const key = JSON.stringify([row.sessionId, row.turnId]);
    const groups = executions.get(key) ?? new Set<string>();
    groups.add(row.sourceContext?.execution ?? 'unknown'); executions.set(key, groups);
  }
  if (rows.some(row => row.sessionId === null || row.turnId === null
    || executions.get(JSON.stringify([row.sessionId, row.turnId]))?.size !== 1)) return undefined;
  const work = new Set([...executions].filter(([, groups]) => groups.size === 1 && groups.has(execution)).map(([key]) => key));
  return projectUsageWorkIntervals({ period, timeZoneOffsetMinutes: period.timeZoneOffsetMinutes,
    facts: original.lanes.filter(lane => work.has(lane.workId)).flatMap(lane => lane.busy.map((span, index) => ({
      ...span, workId: lane.workId, evidenceId: String(index), agentId: lane.agentId, machineId: lane.machineId, kind: 'busy' as const,
    }))),
  });
}

function intervalFacts(facts: PublicUsageFactsV1, intervals: UsageWorkIntervalsProjection | undefined | null, calendar: UsageAgentCalendar) {
  if (intervals) { facts.agentTimeMs = intervals.agentTimeMs; facts.peakParallel = intervals.maxParallel; }
  if (calendar.coverage.busy !== 'unavailable') facts.weeklyPeakParallel = calendar.weeklyPeakParallel.map(week => ({
    startMs: week.startMs, endMs: week.endMs, peak: week.peak, coverage: { status: week.coverage, method: 'runtime' },
  }));
  if (calendar.dayNightActivity) {
    const activity = calendar.dayNightActivity;
    facts.dayNightActivity = { window: activity.window, dayShare: activity.dayShare, nightShare: activity.nightShare,
      coverage: { status: activity.coverage, method: 'runtime' } };
  }
}

/** One projection from the canonical, already admitted public Usage population; no raw recap or private model is serialized. */
export function buildPublicProfileSnapshot(input: Readonly<{ queryResult: UsageQueryResultSlice; policy: PublicProfilePolicyV1; nowMs: number }>): PublicProfileSnapshotBuildResult {
  const slice = input.queryResult;
  const unavailable = (reason: Extract<PublicProfileSnapshotBuildResult, { kind: 'unavailable' }>['reason']): PublicProfileSnapshotBuildResult => ({ kind: 'unavailable', reason });
  const query = slice.requestedQuery;
  if (query.population !== 'public_eligible_personal' || slice.shownQuery.population !== 'public_eligible_personal'
    || slice.key !== getUsageQueryKey(query) || getUsageQueryKey(query) !== getUsageQueryKey(slice.shownQuery)) return unavailable('query_mismatch');
  const accounting = slice.accounting;
  const source = slice.sources.find(source => source.source === 'accounting');
  if (!accounting?.contributions || !source || !['available', 'partial', 'stale', 'error'].includes(source.status)
    || !canRetainUsageReadFailure(source.errorCode)) return unavailable('usage_unavailable');
  const range = 'relative' in query.period ? accounting.coverage?.range : query.period;
  if (range?.startMs === undefined || range.endMs === undefined || range.endMs <= range.startMs) return unavailable('period_unavailable');
  const period = { startMs: range.startMs, endMs: range.endMs, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes };
  const rows = accounting.contributions;
  if (!rows.length && !(accounting.coverage?.status === 'complete' && accounting.coverage.range.complete)) {
    return unavailable('no_eligible_personal_usage');
  }
  const asOfMs = source.asOfMs ?? resolveUsageAccountingAsOfMs(accounting);
  if (asOfMs === undefined) return unavailable('source_time_unavailable');
  const detail = slice.howYouWork;
  const intervals = detail?.detailStatus !== 'unknown' ? detail?.intervals : undefined;
  const calendar = detail?.agentCalendar ?? projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: period.timeZoneOffsetMinutes,
    accounting, intervals, detailStatus: detail?.detailStatus ?? 'unknown', nightHours: detail?.nightShift ?? undefined });
  const { facts, coverage } = rowFacts({ rows, accounting, period, calendar, days: accounting.activity?.calendarDays, nowMs: input.nowMs });
  intervalFacts(facts, intervals, calendar);
  if (detail?.detailStatus !== 'unknown' && detail?.runLengths) facts.sessionDurations = detail.runLengths.byAgent.flatMap(agent => {
    const id = AgentIdV1Schema.safeParse(agent.agentId);
    return id.success ? agent.durationsMs.map(durationMs => ({ agentId: id.data, durationMs })) : [];
  });
  if (slice.mergedOutcomes) facts.mergedPrs = slice.mergedOutcomes.linkedMergedCount;
  const sourceSummary = summarizeUsageExecutionSources(rows);
  facts.sourceSplit = sourceSummary.groups.flatMap(group => group.share === null ? []
    : [{ execution: group.execution, tokens: group.tokens, share: group.share }]);
  if (accounting.activity?.weekdayHourBuckets) {
    const buckets = accounting.activity.weekdayHourBuckets;
    const ranked = levels(buckets.map(bucket => bucket.eventCount));
    facts.punch = buckets.map((bucket, index) => ({ weekday: bucket.weekday, hour: bucket.hour, level: ranked[index]! }));
  }
  facts.highlights = [
    ...(facts.activeDays === undefined ? [] : [{ kind: 'active_days' as const, count: facts.activeDays }]),
    ...(facts.peakParallel === undefined ? [] : [{ kind: 'peak_parallel' as const, count: facts.peakParallel }]),
    ...(facts.mergedPrs === undefined ? [] : [{ kind: 'merged_prs' as const, count: facts.mergedPrs }]),
  ];
  const detailCoverage: PublicCoverage = { status: intervals ? detail?.detailStatus === 'partial' || intervals.coverage === 'partial'
    ? 'partial' : 'complete_for_supplied_facts' : 'unavailable', method: intervals ? 'runtime' : 'unknown' };
  const fieldCoverage: PublicProfileSnapshotV1['fieldCoverage'] = {
    tokens: coverage,
    activeDays: facts.activeDays === undefined ? { status: 'unknown', method: 'unknown' } : coverage,
    currentStreak: facts.currentStreakDays === undefined ? { status: 'unknown', method: 'unknown' } : coverage,
    bestStreak: facts.bestStreakDays === undefined ? { status: 'unknown', method: 'unknown' } : coverage,
    calendar: facts.calendar?.some(day => day.level !== null) ? coverage : { status: 'unknown', method: 'unknown' }, agentMix: coverage,
    sourceSplit: { ...coverage, status: sourceSummary.coverage === 'unknown' ? 'unknown' : sourceSummary.coverage === 'partial' ? 'partial' : coverage.status },
    punch: accounting.activity?.weekdayHourBuckets ? coverage : { status: 'unavailable', method: 'unknown' },
    agentTime: detailCoverage, peakParallel: detailCoverage, weeklyPeakParallel: detailCoverage,
    mergedPrs: slice.mergedOutcomes ? { status: 'partial', method: 'runtime' } : { status: 'unavailable', method: 'unknown' },
    sessionDurations: detail?.runLengths ? { status: detail.runLengths.coverage, method: 'runtime' } : { status: 'unavailable', method: 'unknown' },
    agentActiveDays: coverage, weeklyAgentMix: coverage,
    dayNightActivity: calendar.dayNightActivity ? coverage : { status: 'unavailable', method: 'unknown' },
    machineKinds: { status: 'unavailable', method: 'unknown' }, footprint: { status: 'unavailable', method: 'unknown' }, highlights: coverage,
  };
  const lenses = (['happier', 'outside'] as const).map(execution => {
    const selected = sourceSummary.groups.find(group => group.execution === execution)?.contributions ?? [];
    if (!selected.length && !(sourceSummary.coverage === 'complete' && accounting.coverage?.status === 'complete'
      && accounting.coverage.range.complete)) return { execution, facts: {} };
    // Complete history does not establish complete membership of a source lens
    // while any contributor's execution context remains unclassified.
    const selectedAccounting = { ...accounting, contributions: selected,
      ...(accounting.coverage && sourceSummary.coverage !== 'complete' ? { coverage: { ...accounting.coverage,
        status: 'partial' as const, range: { ...accounting.coverage.range, complete: false } } } : {}),
    };
    const selectedIntervals = lensIntervals(slice, selected, execution, period);
    const selectedCalendar = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: period.timeZoneOffsetMinutes,
      accounting: selectedAccounting, intervals: selectedIntervals, detailStatus: selectedIntervals ? detail?.detailStatus : 'unknown',
      nightHours: detail?.nightShift ?? undefined });
    const projected = rowFacts({ rows: selected, accounting: selectedAccounting, period, calendar: selectedCalendar, nowMs: input.nowMs });
    intervalFacts(projected.facts, selectedIntervals, selectedCalendar);
    if (slice.work) {
      const work = allocateUsageOutcomes({ contributions: selected, evidence: slice.work.allocations.flatMap(row => row.evidence),
        branchEvidence: slice.work.branchAllocations.flatMap(row => row.evidence) });
      projected.facts.mergedPrs = summarizeUsageMergedOutcomes({ work, period, timeZoneOffsetMinutes: period.timeZoneOffsetMinutes }).linkedMergedCount;
    }
    return { execution, facts: projected.facts };
  });
  const parsed = PublicProfileSnapshotV1Schema.safeParse({ v: 1, computedAtMs: input.nowMs, period, coverage, fieldCoverage, facts, lenses });
  return parsed.success ? { kind: 'ready', snapshot: projectPublicProfileSnapshot(parsed.data, input.policy) } : unavailable('invalid_snapshot');
}
