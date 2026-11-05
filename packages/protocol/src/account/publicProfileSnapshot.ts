import { getUsageQueryKey, resolveUsageQueryPeriod } from '../inputs/usageQuery.js';
import { resolveUsageCalendarInstant, resolveUsageBucketBounds } from '../usage/usageCalendar.js';
import { resolveUsageDayStreaks, projectUsageOrdinalLevels as levels } from '../usage/usageActivitySummary.js';
import { summarizeUsageExecutionSources } from '../usage/usageSourceSummary.js';
import { projectUsageAgentCalendar, resolveUsageAccountingCalendarPeriod, type UsageAgentCalendar } from '../usage/usageAgentCalendar.js';
import { allocateUsageOutcomes, summarizeUsageMergedOutcomes } from '../usage/usageOutcomeAllocation.js';
import { canRetainUsageReadFailure, resolveUsageAccountingAsOfMs, type UsageQueryResultSlice } from '../usage/resolveUsagePageAggregation.js';
import { PublicProfileSnapshotV1Schema, type PublicProfilePolicyV1,
  type PublicProfileSnapshotV1 } from './publicProfile.js';
import { projectPublicProfileSnapshot } from './projectPublicProfile.js';
import type { PublicProfileSnapshotUnavailableReasonV1 } from './publicProfileIntents.js';
import { projectPublicProfileAccounting, resolvePublicProfileArtifactPeriod, projectPublicProfilePopulationFacts, projectPublicProfileIntervalFacts,
  projectPublicProfileSessionDurations, projectPublicProfileLensIntervals, projectPublicProfilePrivateFieldCoverage,
  type PublicProfileAccountingPopulation } from './publicProfileAccounting.js';
export { PublicProfileAccountingProjectionSchema, PublicProfilePrivateFactsSchema, PublicProfilePrivateFieldCoverageSchema,
  PublicProfilePrivateAccountingFactsSchema, projectPublicProfileAccounting, projectPublicProfilePopulationFacts,
  projectPublicProfileIntervalFacts, projectPublicProfileSessionDurations, projectPublicProfileLensIntervals, projectPublicProfilePrivateFieldCoverage,
  type PublicProfileAccountingPopulation, type PublicProfileAccountingProjection, type PublicProfilePrivateFacts } from './publicProfileAccounting.js';

export type PublicProfileSnapshotBuildResult = Readonly<{ kind: 'ready'; snapshot: PublicProfileSnapshotV1 }>
  | Readonly<{ kind: 'unavailable'; reason: PublicProfileSnapshotUnavailableReasonV1 }>;
type Period = PublicProfileSnapshotV1['period'];

function publicCalendar(period: Period, supplied: readonly { date: string; eventCount: number | null }[], complete: boolean) {
  const days = new Map(supplied.map(day => [day.date, day.eventCount]));
  const values: Array<{ date: string; eventCount: number | null }> = [];
  for (let instant = period.startMs;
    instant < period.endMs; instant = resolveUsageBucketBounds('day', instant, period.timeZoneOffsetMinutes).bucketEndMs) {
    const date = resolveUsageCalendarInstant(instant, period.timeZoneOffsetMinutes).date;
    values.push({ date, eventCount: days.has(date) ? days.get(date)! : complete ? 0 : null });
  }
  const ranked = levels(values.map(day => day.eventCount));
  return { days: values, calendar: values.map((day, index) => ({ date: day.date, level: ranked[index]! })) };
}

function rowFacts(input: Readonly<{ population: PublicProfileAccountingPopulation; period: Period;
  calendar: UsageAgentCalendar; days?: readonly { date: string; eventCount: number | null }[]; nowMs: number }>) {
  const { population, period, calendar } = input;
  const coverage = population.coverage;
  const complete = coverage.status === 'complete_for_supplied_facts';
  const facts = projectPublicProfilePopulationFacts(population, calendar);
  if (!population.contributionCount && !complete) return { facts, coverage, calendarKnown: false };
  const suppliedDays = input.days ?? population.days;
  const dayProjection = publicCalendar({ ...calendar.period, timeZoneOffsetMinutes: period.timeZoneOffsetMinutes }, suppliedDays, complete);
  facts.calendar = dayProjection.calendar;
  const streak = resolveUsageDayStreaks({ days: dayProjection.days, referenceMs: input.nowMs,
    range: period, timeZoneOffsetMinutes: period.timeZoneOffsetMinutes, coverage: complete ? 'complete' : 'partial' });
  const calendarKnown = complete && dayProjection.days.length === 0 || dayProjection.days.some(day => day.eventCount !== null);
  if (calendarKnown && streak.activeDays !== null) facts.activeDays = streak.activeDays;
  if (calendarKnown && streak.currentStreakDays !== null) facts.currentStreakDays = streak.currentStreakDays;
  if (calendarKnown && streak.longestStreakDays !== null) facts.bestStreakDays = streak.longestStreakDays;
  return { facts, coverage, calendarKnown };
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
  if (!accounting || accounting.contributions === undefined && !accounting.summary?.publicProfileAccounting
    || !source || !['available', 'partial', 'stale', 'error'].includes(source.status)
    || !canRetainUsageReadFailure(source.errorCode)) return unavailable('usage_unavailable');
  const range = 'relative' in query.period ? accounting.coverage?.range : query.period;
  const period = resolvePublicProfileArtifactPeriod(range, query.timeZoneOffsetMinutes);
  if (!period) return unavailable('period_unavailable');
  const contributionCount = accounting.contributions?.length ?? accounting.summary!.publicProfileAccounting!.total.contributionCount;
  if (!contributionCount && !(accounting.coverage?.status === 'complete' && accounting.coverage.range.complete)) {
    return unavailable('no_eligible_personal_usage');
  }
  const asOfMs = source.asOfMs ?? resolveUsageAccountingAsOfMs(accounting);
  if (asOfMs === undefined) return unavailable('source_time_unavailable');
  const detail = slice.howYouWork;
  const intervals = detail?.detailStatus !== 'unknown' ? detail?.intervals : undefined;
  const requestedPeriod = resolveUsageQueryPeriod(query, period.endMs);
  const carriedCalendar = accounting.contributions === undefined ? accounting.summary?.publicProfileAccounting?.total.calendar : undefined;
  const calendar = detail?.agentCalendar ?? carriedCalendar ?? projectUsageAgentCalendar({
    period: resolveUsageAccountingCalendarPeriod({
      period: { startMs: requestedPeriod.startMs === undefined ? undefined : period.startMs, endMs: period.endMs },
      accounting, timeZoneOffsetMinutes: period.timeZoneOffsetMinutes, observationStartMs: slice.accountingObservationRange?.startMs, intervals }),
    timeZoneOffsetMinutes: period.timeZoneOffsetMinutes,
    accounting, intervals, detailStatus: detail?.detailStatus ?? 'unknown', nightHours: detail?.nightShift ?? undefined });
  const prepared = accounting.contributions === undefined ? accounting.summary!.publicProfileAccounting!
    : projectPublicProfileAccounting(accounting, period, calendar);
  if (prepared.period.startMs !== period.startMs || prepared.period.endMs !== period.endMs
    || prepared.period.timeZoneOffsetMinutes !== period.timeZoneOffsetMinutes) return unavailable('query_mismatch');
  const { facts, coverage, calendarKnown } = rowFacts({ population: prepared.total, period, calendar, nowMs: input.nowMs });
  Object.assign(facts, projectPublicProfileIntervalFacts(intervals, calendar));
  if (detail?.detailStatus !== 'unknown' && detail?.runLengths) facts.sessionDurations = projectPublicProfileSessionDurations(detail.runLengths);
  if (slice.mergedOutcomes) facts.mergedPrs = slice.mergedOutcomes.linkedMergedCount;
  Object.assign(facts, slice.publicProfileEvidence?.facts);
  Object.assign(facts, slice.publicProfileEvidence?.accountingFacts);
  const sourceSummary = accounting.summary?.execution ?? summarizeUsageExecutionSources(accounting.contributions);
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
  const fieldCoverage: PublicProfileSnapshotV1['fieldCoverage'] = {
    tokens: coverage,
    activeDays: facts.activeDays === undefined ? { status: 'unknown', method: 'unknown' } : coverage,
    currentStreak: facts.currentStreakDays === undefined ? { status: 'unknown', method: 'unknown' } : coverage,
    bestStreak: facts.bestStreakDays === undefined ? { status: 'unknown', method: 'unknown' } : coverage,
    calendar: calendarKnown ? coverage : { status: 'unknown', method: 'unknown' }, agentMix: coverage,
    sourceSplit: { ...coverage, status: sourceSummary.coverage === 'unknown' ? 'unknown' : sourceSummary.coverage === 'partial' ? 'partial' : coverage.status },
    punch: accounting.activity?.weekdayHourBuckets ? coverage : { status: 'unavailable', method: 'unknown' },
    agentActiveDays: coverage, weeklyAgentMix: coverage,
    ...projectPublicProfilePrivateFieldCoverage({ intervals, detailStatus: detail?.detailStatus ?? 'unknown',
      runLengths: detail?.runLengths, calendar, accountingCoverage: coverage, hasMergedOutcomes: slice.mergedOutcomes !== undefined }),
    machineKinds: { status: 'unavailable', method: 'unknown' }, footprint: { status: 'unavailable', method: 'unknown' }, highlights: coverage,
    ...slice.publicProfileEvidence?.fieldCoverage,
  };
  const lenses = prepared.lenses.map(lens => {
    const { execution } = lens;
    if (!lens.population.contributionCount && !(sourceSummary.coverage === 'complete' && accounting.coverage?.status === 'complete'
      && accounting.coverage.range.complete)) return { execution, facts: {} };
    // Complete history does not establish complete membership of a source lens
    // while any contributor's execution context remains unclassified.
    const selectedIntervals = projectPublicProfileLensIntervals({ intervals, detailStatus: detail?.detailStatus ?? 'unknown',
      accounting: prepared, execution, period });
    const selectedCalendar = projectUsageAgentCalendar({ period: calendar.period, timeZoneOffsetMinutes: period.timeZoneOffsetMinutes,
      accounting, accountingCalendar: { accounting, period: lens.population.calendar.period, timeZoneOffsetMinutes: period.timeZoneOffsetMinutes,
        costMode: lens.population.calendar.costMode, projection: lens.population.calendar },
      costMode: lens.population.calendar.costMode, intervals: selectedIntervals, detailStatus: selectedIntervals ? detail?.detailStatus : 'unknown',
      nightHours: detail?.nightShift ?? undefined });
    const projected = rowFacts({ population: lens.population, period, calendar: selectedCalendar, nowMs: input.nowMs });
    Object.assign(projected.facts, projectPublicProfileIntervalFacts(selectedIntervals, selectedCalendar));
    if (slice.work) {
      const admitted = new Set(prepared.membership.turns.filter(turn => turn.executions.includes(execution))
        .map(turn => JSON.stringify([turn.sessionId, turn.turnId])));
      const selected = (accounting.contributions ?? slice.work.allocations.map(row => row.contribution))
        .filter(row => row.sessionId !== null && row.turnId !== null && admitted.has(JSON.stringify([row.sessionId, row.turnId])));
      const work = allocateUsageOutcomes({ contributions: selected, evidence: slice.work.allocations.flatMap(row => row.evidence),
        branchEvidence: slice.work.branchAllocations.flatMap(row => row.evidence) });
      projected.facts.mergedPrs = summarizeUsageMergedOutcomes({ work, period, timeZoneOffsetMinutes: period.timeZoneOffsetMinutes }).linkedMergedCount;
    }
    Object.assign(projected.facts, slice.publicProfileEvidence?.lenses.find(lens => lens.execution === execution)?.facts);
    Object.assign(projected.facts, slice.publicProfileEvidence?.lenses.find(lens => lens.execution === execution)?.accountingFacts);
    return { execution, facts: projected.facts };
  });
  const parsed = PublicProfileSnapshotV1Schema.safeParse({ v: 1, computedAtMs: input.nowMs, period, coverage, fieldCoverage, facts, lenses });
  return parsed.success ? { kind: 'ready', snapshot: projectPublicProfileSnapshot(parsed.data, input.policy) } : unavailable('invalid_snapshot');
}
