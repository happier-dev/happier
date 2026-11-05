import { AgentIdV1Schema } from '../agents/agentIdV1.js';
import type { PublicCoverage, PublicPeriod, PublicUsageFactsV1 } from './publicProfile.js';
import type { UsageAnalyticsContribution, UsageAnalyticsQueryResponse } from '../usage/usageAnalyticsContracts.js';
import { projectUsageAgentCalendar, type UsageAgentCalendar } from '../usage/usageAgentCalendar.js';
import { summarizeUsageExecutionSources } from '../usage/usageSourceSummary.js';
import { projectUsageFootprint } from '../usage/usageFootprint.js';
import { projectUsageWorkIntervals, type UsageWorkIntervalsProjection } from '../usage/usageWorkIntervals.js';
import type { UsageHowYouWork } from '../usage/resolveUsageHowYouWork.js';
import { projectUsageAccountingSessionMembership } from '../usage/usageAccountingMembership.js';
import type { PublicProfileAccountingPopulation, PublicProfileAccountingProjection, PublicProfilePrivateFacts } from './publicProfileAccountingContracts.js';
export { PublicProfileAccountingProjectionSchema, PublicProfilePrivateFactsSchema, PublicProfilePrivateAccountingFactsSchema,
  PublicProfilePrivateFieldCoverageSchema, type PublicProfileAccountingPopulation, type PublicProfileAccountingProjection,
  type PublicProfilePrivateFacts } from './publicProfileAccountingContracts.js';

/** Public artifact metadata retains its bounded wire range independently of rendered calendar bounds. */
export function resolvePublicProfileArtifactPeriod(range: Readonly<{ startMs?: number; endMs?: number }> | undefined,
  timeZoneOffsetMinutes: number): PublicPeriod | undefined {
  const startMs = range?.startMs ?? 0;
  const endMs = range?.endMs;
  return endMs === undefined || endMs <= startMs ? undefined : { startMs, endMs, timeZoneOffsetMinutes };
}

/** Public capture labels derive once from the actual admitted source members. */
function captureMethods(rows: readonly UsageAnalyticsContribution[], accounting: UsageAnalyticsQueryResponse) {
  const sources = new Map<string, NonNullable<UsageAnalyticsQueryResponse['coverage']>['sources'][number]>();
  for (const source of accounting.coverage?.sources ?? []) {
    const key = JSON.stringify([source.source, source.path, source.machineId ?? null]);
    if (!sources.has(key)) sources.set(key, source);
  }
  const all = new Set<PublicCoverage['method']>();
  const agents = new Map<string | null, Set<PublicCoverage['method']>>();
  for (const row of rows) {
    const source = sources.get(JSON.stringify([row.source, row.sourceContext?.path ?? 'unknown', row.machineId]));
    const method = source?.captureKind === 'from_logs' || source?.path === 'native' ? 'logs'
      : source?.captureKind === 'measured' || source?.path === 'runtime' ? 'runtime' : 'unknown';
    all.add(method);
    const methods = agents.get(row.agentId) ?? new Set<PublicCoverage['method']>();
    methods.add(method); agents.set(row.agentId, methods);
  }
  const combine = (methods: ReadonlySet<PublicCoverage['method']>): PublicCoverage['method'] => methods.size === 1
    ? [...methods][0]! : methods.size > 1 ? 'mixed' : 'unknown';
  return { method: combine(all), agentMethods: [...agents].map(([agentId, methods]) => ({ agentId, method: combine(methods) })) };
}

/** Same public accounting reduction for rich reads and compact producer projections. */
export function projectPublicProfilePopulationFacts(population: PublicProfileAccountingPopulation,
  calendar: UsageAgentCalendar = population.calendar): PublicUsageFactsV1 {
  const facts: PublicUsageFactsV1 = { ...population.facts };
  if (population.contributionCount === 0 && population.coverage.status !== 'complete_for_supplied_facts') return facts;
  const methods = new Map(population.agentMethods.map(agent => [agent.agentId, agent.method]));
  facts.agentMix = calendar.periodSummary.agents.flatMap(agent => {
    const id = AgentIdV1Schema.safeParse(agent.agentId);
    return id.success && agent.shares.tokens !== null ? [{ agentId: id.data, share: agent.shares.tokens,
      ...(agent.metrics.tokens === null ? {} : { tokens: agent.metrics.tokens }),
      coverage: { status: agent.coverage.accounting, method: methods.get(agent.agentId) ?? 'unknown' } }] : [];
  });
  facts.agentActiveDays = calendar.agentActiveDays.flatMap(agent => {
    const id = AgentIdV1Schema.safeParse(agent.agentId);
    return id.success ? [{ agentId: id.data, days: agent.days,
      coverage: { status: agent.coverage, method: methods.get(agent.agentId) ?? 'unknown' } }] : [];
  });
  facts.weeklyAgentMix = calendar.weeklyAgentMix.map(week => ({ startMs: week.startMs, endMs: week.endMs,
    mix: week.mix.flatMap(agent => {
      const id = AgentIdV1Schema.safeParse(agent.agentId);
      return id.success ? [{ agentId: id.data, share: agent.share,
        coverage: { status: agent.coverage, method: methods.get(agent.agentId) ?? 'unknown' } }] : [];
    }) }));
  return facts;
}

function population(rows: readonly UsageAnalyticsContribution[], accounting: UsageAnalyticsQueryResponse,
  calendar: UsageAgentCalendar, days?: PublicProfileAccountingPopulation['days']): PublicProfileAccountingPopulation {
  const complete = accounting.coverage?.status === 'complete' && accounting.coverage.range.complete;
  const methods = captureMethods(rows, accounting);
  const footprint = projectUsageFootprint(accounting);
  const value: PublicProfileAccountingPopulation = { contributionCount: rows.length,
    coverage: { status: complete ? 'complete_for_supplied_facts' : rows.length ? 'partial' : 'unknown', method: methods.method },
    agentMethods: methods.agentMethods, calendar,
    days: days ?? calendar.days.map(day => ({ date: day.date, eventCount: day.totals.eventCount })),
    facts: rows.length || complete ? { tokens: rows.reduce((sum, row) => sum + row.tokens.total, 0),
      footprint: { status: footprint.status, reason: footprint.reason } } : {} };
  return { ...value, facts: projectPublicProfilePopulationFacts(value) };
}

/** A profile consumes rendered accounting grids and distinct historical turns, never event records. */
export function projectPublicProfileAccounting(accounting: UsageAnalyticsQueryResponse, period: PublicPeriod,
  calendar?: UsageAgentCalendar): PublicProfileAccountingProjection {
  const rows = accounting.contributions ?? [];
  const sources = summarizeUsageExecutionSources(rows);
  const membership = accounting.sessionMembership ?? projectUsageAccountingSessionMembership(rows);
  const turns = new Map(membership.turns.map(turn => [JSON.stringify([turn.sessionId, turn.turnId]), turn]));
  const project = (selected: UsageAnalyticsQueryResponse) => projectUsageAgentCalendar({ period: calendar?.period ?? period,
    timeZoneOffsetMinutes: period.timeZoneOffsetMinutes, accounting: selected });
  return { period, total: population(rows, accounting, calendar ?? project(accounting), accounting.activity?.calendarDays),
    lenses: (['happier', 'outside'] as const).map(execution => {
      const selected = sources.groups.find(group => group.execution === execution)?.contributions ?? [];
      const selectedAccounting = { ...accounting, contributions: selected,
        ...(accounting.coverage && sources.coverage !== 'complete' ? { coverage: { ...accounting.coverage,
          status: 'partial' as const, range: { ...accounting.coverage.range, complete: false } } } : {}) };
      return { execution, population: population(selected, selectedAccounting, project(selectedAccounting)),
        workMembershipComplete: selected.every(row => row.sessionId !== null && row.turnId !== null
          && turns.get(JSON.stringify([row.sessionId, row.turnId]))!.executions.length === 1) };
    }), membership };
}

export function projectPublicProfileIntervalFacts(intervals: UsageWorkIntervalsProjection | undefined | null,
  calendar: UsageAgentCalendar): PublicProfilePrivateFacts {
  const facts: PublicProfilePrivateFacts = {};
  if (intervals) { facts.agentTimeMs = intervals.agentTimeMs; facts.peakParallel = intervals.maxParallel; }
  if (calendar.coverage.busy !== 'unavailable') facts.weeklyPeakParallel = calendar.weeklyPeakParallel.map(week => ({
    startMs: week.startMs, endMs: week.endMs, peak: week.peak, coverage: { status: week.coverage, method: 'runtime' },
  }));
  if (calendar.dayNightActivity) {
    const activity = calendar.dayNightActivity;
    facts.dayNightActivity = { window: activity.window, dayShare: activity.dayShare, nightShare: activity.nightShare,
      coverage: { status: activity.coverage, method: 'runtime' } };
  }
  return facts;
}

/** Private source coverage is identical before and after the bounded profile projection. */
export function projectPublicProfilePrivateFieldCoverage(input: Readonly<{
  intervals?: UsageWorkIntervalsProjection | null;
  detailStatus: UsageHowYouWork['detailStatus'];
  runLengths?: UsageHowYouWork['runLengths'];
  calendar: Pick<UsageAgentCalendar, 'dayNightActivity'>;
  accountingCoverage: PublicCoverage;
  hasMergedOutcomes: boolean;
}>): Record<'agentTime' | 'peakParallel' | 'weeklyPeakParallel' | 'sessionDurations' | 'dayNightActivity' | 'mergedPrs', PublicCoverage> {
  const { intervals, detailStatus, runLengths, calendar, accountingCoverage, hasMergedOutcomes } = input;
  const detailCoverage: PublicCoverage = { status: intervals ? detailStatus === 'partial' || intervals.coverage === 'partial'
    ? 'partial' : 'complete_for_supplied_facts' : 'unavailable', method: intervals ? 'runtime' : 'unknown' };
  return { agentTime: detailCoverage, peakParallel: detailCoverage, weeklyPeakParallel: detailCoverage,
    sessionDurations: runLengths ? { status: runLengths.coverage, method: 'runtime' } : { status: 'unavailable', method: 'unknown' },
    dayNightActivity: calendar.dayNightActivity ? accountingCoverage : { status: 'unavailable', method: 'unknown' },
    mergedPrs: hasMergedOutcomes ? { status: 'partial', method: 'runtime' } : { status: 'unavailable', method: 'unknown' } };
}

/** Both rich snapshots and slim private preparation select source lanes from the same admitted turn membership. */
export function projectPublicProfileLensIntervals(input: Readonly<{
  intervals?: UsageWorkIntervalsProjection | null;
  detailStatus: UsageHowYouWork['detailStatus'];
  accounting: PublicProfileAccountingProjection;
  execution: 'happier' | 'outside';
  period: PublicPeriod;
}>): UsageWorkIntervalsProjection | undefined {
  const { intervals, detailStatus, accounting, execution, period } = input;
  if (!intervals || detailStatus === 'unknown') return undefined;
  if (!accounting.lenses.find(lens => lens.execution === execution)?.workMembershipComplete) return undefined;
  const work = new Set(accounting.membership.turns.filter(turn => turn.executions.length === 1 && turn.executions[0] === execution)
    .map(turn => JSON.stringify([turn.sessionId, turn.turnId])));
  return projectUsageWorkIntervals({ period, timeZoneOffsetMinutes: period.timeZoneOffsetMinutes,
    facts: intervals.lanes.filter(lane => work.has(lane.workId)).flatMap(lane => lane.busy.map((span, index) => ({
      ...span, workId: lane.workId, evidenceId: String(index), agentId: lane.agentId, machineId: lane.machineId, kind: 'busy' as const,
    }))),
  });
}

export function projectPublicProfileSessionDurations(runLengths: UsageHowYouWork['runLengths']): PublicUsageFactsV1['sessionDurations'] {
  return runLengths?.byAgent.flatMap(agent => {
    const id = AgentIdV1Schema.safeParse(agent.agentId);
    return id.success ? agent.durationsMs.map(durationMs => ({ agentId: id.data, durationMs })) : [];
  });
}
