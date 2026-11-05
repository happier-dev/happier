import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { UsageAnalyticsContribution, UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { createEmptyUsageSelectedCost, mergeUsageSelectedCosts, resolveUsageContributionCosts, selectResolvedUsageCost,
    type UsageSelectedCostAccumulator } from './usageAggregation.js';
import { resolveUsageBucketBounds, resolveUsageCalendarDateStart, resolveUsageCalendarInstant } from './usageCalendar.js';
import type { UsageCostMode } from './usageCostFacts.js';
import { isUsageNightHour, summarizeUsageConcurrency, UsageNightHoursV1Schema,
    type UsageWorkIntervalSegment, type UsageWorkIntervalsInput, type UsageWorkIntervalsProjection } from './usageWorkIntervals.js';

const Count = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const Amount = lazyZodSchema(() => z.number().check(z.nonnegative()));
const Coverage = lazyZodSchema(() => z.enum(['complete_for_supplied_facts', 'partial', 'unknown', 'unavailable']));
const CoverageFields = lazyZodSchema(() => z.strictObject({ accounting: Coverage, busy: Coverage, steering: Coverage }));
const AgentId = lazyZodSchema(() => z.nullable(z.string().check(z.minLength(1))));
const Cost = lazyZodSchema(() => z.strictObject({ amountUsd: Amount, currency: z.string(), source: z.string(),
    kind: z.enum(['reported', 'estimated', 'api_equivalent', 'invoice', 'mixed']) }));
const Metrics = lazyZodSchema(() => z.strictObject({
    tokens: z.nullable(Count), eventCount: z.nullable(Count), sessions: z.nullable(Count), cost: z.nullable(Cost),
    busyMs: z.nullable(Amount), steeringCount: z.nullable(Count), peakParallel: z.nullable(Count),
}));
const Leader = lazyZodSchema(() => z.strictObject({
    status: z.enum(['unavailable', 'empty', 'leading', 'tied', 'unattributed']), agentIds: z.array(z.string()), includesUnknown: z.boolean(),
}));
const Leaders = lazyZodSchema(() => z.strictObject({ tokens: Leader, eventCount: Leader, sessions: Leader,
    cost: Leader, busyMs: Leader, steeringCount: Leader, peakParallel: Leader }));
const Bounds = { startMs: z.number().check(z.int()), endMs: z.number().check(z.int()) };
const AgentFigures = lazyZodSchema(() => z.strictObject({ agentId: AgentId, metrics: Metrics, coverage: CoverageFields }));
const Figures = lazyZodSchema(() => z.strictObject({
    totals: Metrics, agents: z.array(AgentFigures), leaders: Leaders,
}));
const PeriodSummary = lazyZodSchema(() => z.strictObject({
    ...Figures.shape,
    agents: z.array(z.strictObject({ ...AgentFigures.shape, shares: z.strictObject({
        tokens: z.nullable(z.number().check(z.minimum(0), z.maximum(1))),
        cost: z.nullable(z.number().check(z.minimum(0), z.maximum(1))),
    }) })),
}));
const Bucket = lazyZodSchema(() => z.strictObject({ ...Bounds, date: z.string(),
    weekday: z.number().check(z.int(), z.minimum(0), z.maximum(6)), hour: z.nullable(z.number().check(z.int(), z.minimum(0), z.maximum(23))),
    ...Figures.shape,
}));
const WeekdayHourBucket = lazyZodSchema(() => z.strictObject({
    weekday: z.number().check(z.int(), z.minimum(0), z.maximum(6)), hour: z.number().check(z.int(), z.minimum(0), z.maximum(23)), ...Figures.shape,
}));
const HourOfDayBucket = lazyZodSchema(() => z.strictObject({
    hour: z.number().check(z.int(), z.minimum(0), z.maximum(23)), ...Figures.shape,
}));

/** Private Usage projection. Public preparation selects only its separately consented leaves. */
export const UsageAgentCalendarSchema = lazyZodSchema(() => z.strictObject({
    period: z.strictObject(Bounds), timeZoneOffsetMinutes: z.number().check(z.int(), z.minimum(-840), z.maximum(840)),
    costMode: z.enum(['auto', 'reported', 'estimated', 'api_equivalent']), coverage: CoverageFields,
    periodSummary: PeriodSummary,
    // Days/weeks include empty covered buckets. Hour projections are fact-populated:
    // callers use the measure's coverage to distinguish absent empty cells from missing evidence.
    days: z.array(Bucket), weeks: z.array(Bucket), hours: z.array(Bucket),
    weekdayHourBuckets: z.array(WeekdayHourBucket),
    hourOfDayBuckets: z.array(HourOfDayBucket),
    agentActiveDays: z.array(z.strictObject({ agentId: AgentId, days: Count, coverage: Coverage })),
    weeklyAgentMix: z.array(z.strictObject({ ...Bounds, mix: z.array(z.strictObject({ agentId: AgentId,
        share: z.number().check(z.minimum(0), z.maximum(1)), coverage: Coverage })) })),
    weeklyPeakParallel: z.array(z.strictObject({ ...Bounds, peak: Count, coverage: Coverage })),
    dayNightActivity: z.nullable(z.strictObject({ basis: z.literal('recorded_activity'), window: UsageNightHoursV1Schema,
        dayShare: z.number().check(z.minimum(0), z.maximum(1)), nightShare: z.number().check(z.minimum(0), z.maximum(1)), coverage: Coverage })),
    machineKinds: z.strictObject({ status: z.literal('unavailable'), reason: z.literal('no_witnessed_kind') }),
}));
export type UsageAgentCalendar = z.infer<typeof UsageAgentCalendarSchema>;
type CalendarBucket = UsageAgentCalendar['days'][number];
type CalendarMetrics = CalendarBucket['totals'];
type CalendarCoverage = z.infer<typeof Coverage>;
type CalendarSteeringHour = Readonly<{ agentId: string | null; date: string; weekday: number; hour: number; steeringCount: number | null }>;
export interface UsageAgentCalendarInput {
    period: UsageWorkIntervalsInput['period'];
    timeZoneOffsetMinutes: number;
    accounting?: UsageAnalyticsQueryResponse;
    /** Selected money admitted once for these ordered rows; calendar still owns every partition and merge. */
    accountingSelectedCosts?: (rows: readonly UsageAnalyticsContribution[], mode: UsageCostMode) => readonly UsageSelectedCostAccumulator[];
    intervals?: UsageWorkIntervalsProjection | null;
    detailStatus?: 'available' | 'partial' | 'unknown';
    costMode?: UsageCostMode;
    nightHours?: UsageWorkIntervalsInput['nightHours'];
    /** Canonical Human-loop projection; this owner never reinterprets or deduplicates accepted inputs. */
    steering?: Readonly<{ inputsObserved: boolean; coverage: 'complete_for_supplied_facts' | 'partial'; hourly: readonly CalendarSteeringHour[] }> | null;
    /** Explicit derived value carried by the admitted read/batch, never a separate cache. */
    accountingCalendar?: UsageAgentAccountingCalendar;
}

export interface UsageAgentAccountingCalendar {
    accounting: UsageAnalyticsQueryResponse | undefined;
    period: UsageWorkIntervalsInput['period'];
    timeZoneOffsetMinutes: number;
    costMode: UsageCostMode;
    projection: UsageAgentCalendar;
}

/** Open accounting calendars begin on the selected population's first observed local day. */
export function resolveUsageAccountingCalendarPeriod(input: {
    period: Readonly<{ startMs?: number; endMs: number }>;
    accounting?: UsageAnalyticsQueryResponse;
    timeZoneOffsetMinutes: number;
    observationStartMs?: number;
    intervals?: UsageWorkIntervalsProjection | null;
    steering?: UsageAgentCalendarInput['steering'];
}): UsageWorkIntervalsInput['period'] {
    const { endMs } = input.period;
    if (input.period.startMs !== undefined) return { startMs: input.period.startMs, endMs };
    const carried = input.accounting?.summary?.accountingCalendar?.value;
    let firstObserved = input.observationStartMs ?? input.accounting?.summary?.observationRange?.startMs;
    if (firstObserved === undefined && carried?.period.endMs === endMs && carried.timeZoneOffsetMinutes === input.timeZoneOffsetMinutes
        && carried.period.startMs < endMs) firstObserved = carried.period.startMs;
    if (firstObserved === undefined) for (const row of input.accounting?.contributions ?? []) {
        const observedAtMs = row.observedAtMs;
        firstObserved = firstObserved === undefined ? observedAtMs : Math.min(firstObserved, observedAtMs);
    }
    for (const lane of input.intervals?.lanes ?? []) for (const span of lane.busy) {
        firstObserved = firstObserved === undefined ? span.startMs : Math.min(firstObserved, span.startMs);
    }
    for (const row of input.steering?.hourly ?? []) {
        const instant = resolveUsageCalendarDateStart(row.date, input.timeZoneOffsetMinutes) + row.hour * 3_600_000;
        firstObserved = firstObserved === undefined ? instant : Math.min(firstObserved, instant);
    }
    return { startMs: firstObserved === undefined ? endMs
        : resolveUsageBucketBounds('day', firstObserved, input.timeZoneOffsetMinutes).bucketStartMs, endMs };
}

export function projectUsageAgentAccountingCalendar(input: Pick<UsageAgentCalendarInput,
    'accounting' | 'period' | 'timeZoneOffsetMinutes' | 'costMode' | 'accountingSelectedCosts'>): UsageAgentAccountingCalendar {
    const carried = input.accounting?.contributions === undefined ? input.accounting?.summary?.accountingCalendar?.value : undefined;
    const projection = carried?.period.startMs === input.period.startMs && carried.period.endMs === input.period.endMs
        && carried.timeZoneOffsetMinutes === input.timeZoneOffsetMinutes && carried.costMode === (input.costMode ?? 'auto') ? carried : undefined;
    return { accounting: input.accounting, period: { ...input.period }, timeZoneOffsetMinutes: input.timeZoneOffsetMinutes,
        costMode: input.costMode ?? 'auto', projection: projection ?? projectUsageAgentCalendarPopulation({ accounting: input.accounting,
            period: input.period, timeZoneOffsetMinutes: input.timeZoneOffsetMinutes, costMode: input.costMode,
            accountingSelectedCosts: input.accountingSelectedCosts }) };
}

type BucketPopulation = { rows: UsageAnalyticsContribution[];
    busy: Map<string | null, UsageWorkIntervalSegment[]>; steering: Map<string | null, Array<number | null>>;
    costs: Map<string | null, UsageSelectedCostAccumulator> };
type BucketFacts = BucketPopulation & { startMs: number; endMs: number };
const compareAgent = (left: string | null, right: string | null) => (left ?? '').localeCompare(right ?? '');

/** Absent or zero measurements do not establish a measured share. */
export function resolveUsageCalendarShare(value: number | null, total: number | null): number | null {
    return value !== null && total !== null && value > 0 && total > 0 ? value / total : null;
}

function createBucketPopulation(): BucketPopulation {
    return { rows: [], busy: new Map(), steering: new Map(), costs: new Map() };
}

function appendBucketPopulation(target: BucketPopulation, source: BucketPopulation, costMode: UsageCostMode): void {
    for (const row of source.rows) target.rows.push(row);
    for (const [agentId, spans] of source.busy) {
        const combined = target.busy.get(agentId) ?? [];
        for (const span of spans) combined.push(span);
        target.busy.set(agentId, combined);
    }
    for (const [agentId, values] of source.steering) {
        const combined = target.steering.get(agentId) ?? [];
        for (const value of values) combined.push(value);
        target.steering.set(agentId, combined);
    }
    for (const [agentId, cost] of source.costs) target.costs.set(agentId,
        mergeUsageSelectedCosts(target.costs.get(agentId) ?? createEmptyUsageSelectedCost(), cost, costMode));
}

type CoverageSource = NonNullable<UsageAnalyticsQueryResponse['coverage']>['sources'][number];

/** Each contribution's source member, resolved once: coverage is asked per Agent in every bucket of every granularity. */
function createCoverageSourceLookup(accounting: UsageAnalyticsQueryResponse | undefined): (row: UsageAnalyticsContribution) => CoverageSource | undefined {
    // source → path → machine (null for none); nested maps avoid building a key string for every row of every projection.
    const index = new Map<string | null, Map<string, Map<string | null, CoverageSource>>>();
    for (const source of accounting?.coverage?.sources ?? []) {
        const byPath = index.get(source.source) ?? new Map<string, Map<string | null, CoverageSource>>();
        index.set(source.source, byPath);
        const byMachine = byPath.get(source.path) ?? new Map<string | null, CoverageSource>();
        byPath.set(source.path, byMachine);
        // The first matching entry wins, as the previous linear search did.
        const machineId = source.machineId ?? null;
        if (!byMachine.has(machineId)) byMachine.set(machineId, source);
    }
    return row => index.get(row.source)?.get(row.sourceContext?.path ?? 'unknown')?.get(row.machineId);
}

/** Completeness belongs to the actual source members, never a global badge copied to each Agent. */
function accountingCoverage(rows: readonly UsageAnalyticsContribution[] | undefined, accounting: UsageAnalyticsQueryResponse | undefined,
    sourceOf: (row: UsageAnalyticsContribution) => CoverageSource | undefined): CalendarCoverage {
    if (rows === undefined) return 'unavailable';
    if (rows.length === 0) return accounting?.coverage?.status === 'complete' && accounting.coverage.range.complete
        ? 'complete_for_supplied_facts' : 'unknown';
    const coverage = accounting?.coverage;
    const sources = rows.map(sourceOf);
    if (sources.some(source => source === undefined || source.status === 'unknown' || source.status === 'unsupported')) return 'unknown';
    return coverage?.range.complete && sources.every(source => source?.status === 'available' && source.historyComplete === true)
        ? 'complete_for_supplied_facts' : 'partial';
}

export function resolveUsageCalendarLeaders(agents: CalendarBucket['agents'], metric: keyof CalendarMetrics, total: CalendarMetrics): z.infer<typeof Leader> {
    const amount = (metrics: CalendarMetrics) => metric === 'cost' ? metrics.cost?.amountUsd ?? null : metrics[metric];
    const totalValue = amount(total);
    if (totalValue === null || agents.some(agent => amount(agent.metrics) === null)) return { status: 'unavailable', agentIds: [], includesUnknown: false };
    if (totalValue === 0) return { status: 'empty', agentIds: [], includesUnknown: false };
    const maximum = agents.reduce((maximum, agent) => Math.max(maximum, amount(agent.metrics) ?? 0), 0);
    const winners = agents.filter(agent => amount(agent.metrics) === maximum);
    const agentIds = winners.flatMap(agent => agent.agentId === null ? [] : [agent.agentId]);
    const includesUnknown = winners.some(agent => agent.agentId === null);
    return { status: winners.length > 1 ? 'tied' : includesUnknown ? 'unattributed' : 'leading', agentIds, includesUnknown };
}

function projectDayNightActivity(input: Pick<UsageAgentCalendarInput, 'accounting' | 'nightHours'>): UsageAgentCalendar['dayNightActivity'] {
    const activityBuckets = input.accounting?.activity?.weekdayHourBuckets;
    const activityTotal = activityBuckets?.reduce((sum, row) => sum + row.eventCount, 0) ?? 0;
    if (!input.nightHours || !activityBuckets || activityTotal === 0) return null;
    const nightCount = activityBuckets.reduce((sum, row) => sum + (isUsageNightHour(row.hour, input.nightHours!) ? row.eventCount : 0), 0);
    return { basis: 'recorded_activity', window: input.nightHours, dayShare: (activityTotal - nightCount) / activityTotal,
        nightShare: nightCount / activityTotal,
        coverage: input.accounting?.coverage?.status === 'complete' && input.accounting.coverage.range.complete ? 'complete_for_supplied_facts' : 'partial' };
}

function projectActiveDays(days: UsageAgentCalendar['days'], accounting: ReadonlyMap<string | null, CalendarCoverage>,
    busyAgents: ReadonlySet<string | null>, busyCoverage: CalendarCoverage): UsageAgentCalendar['agentActiveDays'] {
    const membership = new Map<string | null, Set<string>>();
    for (const day of days) for (const agent of day.agents) {
        if ((agent.metrics.tokens ?? 0) <= 0 && (agent.metrics.eventCount ?? 0) <= 0 && (agent.metrics.busyMs ?? 0) <= 0) continue;
        const active = membership.get(agent.agentId) ?? new Set<string>();
        active.add(day.date);
        membership.set(agent.agentId, active);
    }
    return [...membership.entries()].sort(([left], [right]) => compareAgent(left, right)).map(([agentId, active]) => {
        const observedBusy = busyAgents.has(agentId);
        let coverage = accounting.get(agentId) ?? (observedBusy ? busyCoverage : 'unavailable');
        if (observedBusy && busyCoverage !== 'complete_for_supplied_facts' && coverage === 'complete_for_supplied_facts') coverage = 'partial';
        return { agentId, days: active.size, coverage };
    });
}

function projectWeeklyAgentMix(weeks: UsageAgentCalendar['weeks']): UsageAgentCalendar['weeklyAgentMix'] {
    return weeks.filter(week => week.totals.tokens !== null).map(week => ({ startMs: week.startMs, endMs: week.endMs,
        mix: week.totals.tokens! > 0 ? week.agents.filter(agent => (agent.metrics.tokens ?? 0) > 0).map(agent => ({ agentId: agent.agentId,
            share: agent.metrics.tokens! / week.totals.tokens!, coverage: agent.coverage.accounting })) : [] }));
}

/** Compose private evidence onto a read-owned accounting reduction without folding its rows again. */
export function projectUsageAgentCalendar(input: UsageAgentCalendarInput): UsageAgentCalendar {
    const carried = input.accountingCalendar ?? (input.accounting?.contributions === undefined && input.accounting?.summary?.accountingCalendar
        ? projectUsageAgentAccountingCalendar(input) : undefined);
    if (!carried || carried.accounting !== input.accounting || carried.period.startMs < input.period.startMs
        || carried.period.endMs !== input.period.endMs || carried.timeZoneOffsetMinutes !== input.timeZoneOffsetMinutes
        || carried.costMode !== (input.costMode ?? 'auto')) return projectUsageAgentCalendarPopulation(input);
    const accounting = carried.projection;
    if ((!input.intervals && !input.steering || input.detailStatus === 'unknown') && carried.period.startMs === input.period.startMs) return input.nightHours
        ? { ...accounting, dayNightActivity: projectDayNightActivity(input) } : accounting;
    const detail = projectUsageAgentCalendarPopulation({ ...input, accounting: undefined, accountingCalendar: undefined });
    const defaultAccounting = (): CalendarMetrics => ({ tokens: accounting.coverage.accounting === 'complete_for_supplied_facts' ? 0 : null,
        eventCount: accounting.coverage.accounting === 'complete_for_supplied_facts' ? 0 : null,
        sessions: accounting.coverage.accounting === 'complete_for_supplied_facts' ? 0 : null, cost: null,
        busyMs: null, peakParallel: null, steeringCount: null });
    const defaultPrivate = (): CalendarMetrics => ({ tokens: null, eventCount: null, sessions: null, cost: null,
        busyMs: detail.coverage.busy === 'complete_for_supplied_facts' ? 0 : null,
        peakParallel: detail.coverage.busy === 'complete_for_supplied_facts' ? 0 : null,
        steeringCount: detail.coverage.steering === 'complete_for_supplied_facts' ? 0 : null });
    const combineMetrics = (a: CalendarMetrics, b: CalendarMetrics): CalendarMetrics => ({
        tokens: a.tokens, eventCount: a.eventCount, sessions: a.sessions, cost: a.cost,
        busyMs: b.busyMs, peakParallel: b.peakParallel, steeringCount: b.steeringCount,
    });
    const combineFigures = (a: z.infer<typeof Figures> | undefined, b: z.infer<typeof Figures> | undefined): z.infer<typeof Figures> => {
        const accountingAgents = new Map(a?.agents.map(agent => [agent.agentId, agent]));
        const privateAgents = new Map(b?.agents.map(agent => [agent.agentId, agent]));
        const agents = [...new Set([...accountingAgents.keys(), ...privateAgents.keys()])].sort(compareAgent).map(agentId => {
            const aa = accountingAgents.get(agentId);
            const bb = privateAgents.get(agentId);
            return { agentId, metrics: combineMetrics(aa?.metrics ?? defaultAccounting(), bb?.metrics ?? defaultPrivate()),
                coverage: { accounting: aa?.coverage.accounting ?? (input.accounting?.contributions === undefined && !input.accounting?.summary ? 'unavailable' as const : 'unknown' as const),
                    busy: detail.coverage.busy, steering: detail.coverage.steering } };
        });
        const totals = combineMetrics(a?.totals ?? defaultAccounting(), b?.totals ?? defaultPrivate());
        return { totals, agents, leaders: { tokens: resolveUsageCalendarLeaders(agents, 'tokens', totals), eventCount: resolveUsageCalendarLeaders(agents, 'eventCount', totals),
            sessions: resolveUsageCalendarLeaders(agents, 'sessions', totals), cost: resolveUsageCalendarLeaders(agents, 'cost', totals), busyMs: resolveUsageCalendarLeaders(agents, 'busyMs', totals),
            steeringCount: resolveUsageCalendarLeaders(agents, 'steeringCount', totals), peakParallel: resolveUsageCalendarLeaders(agents, 'peakParallel', totals) } };
    };
    const combineGroups = <T extends z.infer<typeof Figures>>(a: readonly T[], b: readonly T[], key: (row: T) => string): T[] => {
        const groups = new Map<string, { accounting?: T; detail?: T }>();
        for (const row of a) groups.set(key(row), { accounting: row });
        for (const row of b) { const group = groups.get(key(row)) ?? {}; group.detail = row; groups.set(key(row), group); }
        return [...groups.values()].map(group => ({ ...(group.accounting ?? group.detail!), ...combineFigures(group.accounting, group.detail) }));
    };
    const days = combineGroups(accounting.days, detail.days, row => row.date).sort((a, b) => a.startMs - b.startMs);
    const accountingWeeks = accounting.weeks.map(week => {
        const startMs = Math.max(input.period.startMs, resolveUsageBucketBounds('week', week.startMs, input.timeZoneOffsetMinutes).bucketStartMs);
        if (startMs === week.startMs) return week;
        const { date, weekday } = resolveUsageCalendarInstant(startMs, input.timeZoneOffsetMinutes);
        return { ...week, startMs, date, weekday };
    });
    const weeks = combineGroups(accountingWeeks, detail.weeks, row => String(row.startMs)).sort((a, b) => a.startMs - b.startMs);
    const hours = combineGroups(accounting.hours, detail.hours, row => String(row.startMs)).sort((a, b) => a.startMs - b.startMs);
    const weekdayHourBuckets = combineGroups(accounting.weekdayHourBuckets, detail.weekdayHourBuckets, row => `${row.weekday}:${row.hour}`)
        .sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
    const hourOfDayBuckets = combineGroups(accounting.hourOfDayBuckets, detail.hourOfDayBuckets, row => String(row.hour)).sort((a, b) => a.hour - b.hour);
    const figures = combineFigures(accounting.periodSummary, detail.periodSummary);
    const accountingAgents = new Map(accounting.periodSummary.agents.map(agent => [agent.agentId, agent]));
    const periodSummary: UsageAgentCalendar['periodSummary'] = { ...figures, agents: figures.agents.map(agent => ({ ...agent,
        shares: accountingAgents.get(agent.agentId)?.shares ?? { tokens: null, cost: null } })) };
    const agentActiveDays = projectActiveDays(days, new Map(accounting.periodSummary.agents.map(agent => [agent.agentId, agent.coverage.accounting])),
        new Set(detail.periodSummary.agents.filter(agent => (agent.metrics.busyMs ?? 0) > 0).map(agent => agent.agentId)), detail.coverage.busy);
    return { ...accounting, period: input.period, coverage: { accounting: accounting.coverage.accounting, busy: detail.coverage.busy, steering: detail.coverage.steering },
        days, weeks, hours, weekdayHourBuckets, hourOfDayBuckets, periodSummary, agentActiveDays,
        weeklyAgentMix: projectWeeklyAgentMix(weeks), weeklyPeakParallel: detail.weeklyPeakParallel, dayNightActivity: projectDayNightActivity(input) };
}

/** Complete reconciled accounting and already-clipped witnessed lanes are the only populations. */
function projectUsageAgentCalendarPopulation(input: UsageAgentCalendarInput): UsageAgentCalendar {
    const { period, timeZoneOffsetMinutes } = input;
    if (!Number.isSafeInteger(period.startMs) || !Number.isSafeInteger(period.endMs) || period.endMs < period.startMs
        || !Number.isInteger(timeZoneOffsetMinutes) || Math.abs(timeZoneOffsetMinutes) > 840) throw new RangeError('Invalid usage calendar period or offset');
    const costMode = input.costMode ?? 'auto';
    const suppliedRows = input.accounting?.contributions;
    const rows = suppliedRows?.filter(row => row.observedAtMs >= period.startMs && row.observedAtMs < period.endMs);
    // Resolve overlap against the whole selected query before partitioning; the report's
    // covered earlier estimates cannot become another charge in an earlier calendar bucket.
    const selectedCosts = rows === undefined ? [] : input.accountingSelectedCosts
        ? input.accountingSelectedCosts(rows, costMode)
        : resolveUsageContributionCosts(rows, costMode).map(cost => selectResolvedUsageCost(cost, costMode));
    const selectedRows = rows;
    const intervals = input.detailStatus !== 'unknown' && input.intervals && input.intervals.period.startMs <= period.startMs
        && input.intervals.period.endMs === period.endMs && input.intervals.timeZoneOffsetMinutes === timeZoneOffsetMinutes ? input.intervals : null;
    const busyCoverage: CalendarCoverage = intervals === null ? 'unavailable'
        : input.detailStatus === 'partial' || intervals.coverage === 'partial' ? 'partial' : 'complete_for_supplied_facts';
    const steering = input.detailStatus === 'unknown' ? null : input.steering;
    const steeringCoverage: CalendarCoverage = steering?.inputsObserved ? steering.coverage : 'unavailable';
    const sourceIndex = createCoverageSourceLookup(input.accounting);
    const coverage: UsageAgentCalendar['coverage'] = { accounting: accountingCoverage(rows, input.accounting, sourceIndex), busy: busyCoverage, steering: steeringCoverage };

    const metrics = (rows: readonly UsageAnalyticsContribution[], busy: readonly UsageWorkIntervalSegment[], steers: readonly (number | null)[],
        cost: UsageSelectedCostAccumulator): CalendarMetrics => {
        const hasAccounting = selectedRows !== undefined && (rows.length > 0 || coverage.accounting === 'complete_for_supplied_facts');
        const hasBusy = intervals !== null && (busy.length > 0 || busyCoverage === 'complete_for_supplied_facts');
        const hasSteers = steering?.inputsObserved === true && (steers.length > 0 || steeringCoverage === 'complete_for_supplied_facts');
        const sessions = rows.filter(row => row.tokens.total > 0 || row.eventCount !== 0);
        return { tokens: hasAccounting ? rows.reduce((sum, row) => sum + row.tokens.total, 0) : null,
            eventCount: hasAccounting && rows.every(row => row.eventCount !== undefined) ? rows.reduce((sum, row) => sum + row.eventCount!, 0) : null,
            sessions: hasAccounting && sessions.every(row => row.sessionId !== null) ? new Set(sessions.map(row => row.sessionId)).size : null,
            cost: cost.available ? cost.selected : null,
            busyMs: hasBusy ? busy.reduce((sum, span) => sum + span.endMs - span.startMs, 0) : null,
            steeringCount: hasSteers && steers.every(value => value !== null) ? steers.reduce<number>((sum, value) => sum + value!, 0) : null,
            peakParallel: hasBusy ? summarizeUsageConcurrency(busy).maxParallel : null };
    };
    const projectFigures = (population: BucketPopulation): z.infer<typeof Figures> => {
        const rowsByAgent = new Map<string | null, UsageAnalyticsContribution[]>();
        for (const row of population.rows) {
            const group = rowsByAgent.get(row.agentId) ?? [];
            group.push(row);
            rowsByAgent.set(row.agentId, group);
        }
        const members = [...new Set([...rowsByAgent.keys(), ...population.busy.keys(), ...population.steering.keys()])].sort(compareAgent);
        const agents = members.map(agentId => {
            const rows = rowsByAgent.get(agentId) ?? [];
            return { agentId, metrics: metrics(rows, population.busy.get(agentId) ?? [], population.steering.get(agentId) ?? [],
                population.costs.get(agentId) ?? createEmptyUsageSelectedCost()),
                coverage: { accounting: rows.length > 0 ? accountingCoverage(rows, input.accounting, sourceIndex) : selectedRows === undefined ? 'unavailable' as const : 'unknown' as const,
                    busy: busyCoverage, steering: steeringCoverage } };
        });
        const totalCost = [...population.costs.values()].reduce((total, cost) => mergeUsageSelectedCosts(total, cost, costMode), createEmptyUsageSelectedCost());
        const totals = metrics(population.rows, [...population.busy.values()].flat(), [...population.steering.values()].flat(), totalCost);
        return { totals, agents,
            leaders: { tokens: resolveUsageCalendarLeaders(agents, 'tokens', totals), eventCount: resolveUsageCalendarLeaders(agents, 'eventCount', totals),
                sessions: resolveUsageCalendarLeaders(agents, 'sessions', totals), cost: resolveUsageCalendarLeaders(agents, 'cost', totals), busyMs: resolveUsageCalendarLeaders(agents, 'busyMs', totals),
                steeringCount: resolveUsageCalendarLeaders(agents, 'steeringCount', totals), peakParallel: resolveUsageCalendarLeaders(agents, 'peakParallel', totals) } };
    };
    const projectBuckets = (granularity: 'day' | 'week' | 'hour', hours?: readonly BucketFacts[]): { facts: BucketFacts[]; buckets: CalendarBucket[] } => {
        const buckets = new Map<number, BucketFacts>();
        for (let cursor = period.startMs; granularity !== 'hour' && cursor < period.endMs;) {
            const bounds = resolveUsageBucketBounds(granularity, cursor, timeZoneOffsetMinutes);
            const endMs = Math.min(period.endMs, bounds.bucketEndMs);
            buckets.set(bounds.bucketStartMs, { startMs: cursor, endMs, ...createBucketPopulation() });
            cursor = endMs;
        }
        const bucketAt = (instant: number) => {
            const bounds = resolveUsageBucketBounds(granularity, instant, timeZoneOffsetMinutes);
            let bucket = buckets.get(bounds.bucketStartMs);
            if (!bucket && granularity === 'hour' && instant >= period.startMs && instant < period.endMs) {
                bucket = { startMs: Math.max(period.startMs, bounds.bucketStartMs), endMs: Math.min(period.endMs, bounds.bucketEndMs),
                    ...createBucketPopulation() };
                buckets.set(bounds.bucketStartMs, bucket);
            }
            return bucket;
        };
        if (hours) for (const hour of hours) appendBucketPopulation(bucketAt(hour.startMs)!, hour, costMode);
        else {
        for (const [index, row] of (selectedRows ?? []).entries()) {
            const bucket = bucketAt(row.observedAtMs)!;
            bucket.rows.push(row);
            bucket.costs.set(row.agentId, mergeUsageSelectedCosts(bucket.costs.get(row.agentId) ?? createEmptyUsageSelectedCost(),
                selectedCosts[index]!, costMode));
        }
        for (const lane of intervals?.lanes ?? []) for (const span of lane.busy) {
            for (let cursor = Math.max(span.startMs, period.startMs); cursor < Math.min(span.endMs, period.endMs);) {
                const bucket = bucketAt(cursor)!;
                const endMs = Math.min(bucket.endMs, span.endMs);
                const spans = bucket.busy.get(lane.agentId) ?? [];
                spans.push({ startMs: cursor, endMs });
                bucket.busy.set(lane.agentId, spans);
                cursor = endMs;
            }
        }
        for (const row of steering?.hourly ?? []) {
            const instant = resolveUsageCalendarDateStart(row.date, timeZoneOffsetMinutes) + row.hour * 3_600_000;
            // The canonical steering reducer already selects exact instants; a partial
            // leading hour remains part of the same admitted local calendar cell.
            const bucket = bucketAt(Math.max(instant, period.startMs));
            if (!bucket || instant + 3_600_000 <= period.startMs || instant >= period.endMs) continue;
            const values = bucket.steering.get(row.agentId) ?? [];
            values.push(row.steeringCount);
            bucket.steering.set(row.agentId, values);
        }
        }
        const facts = [...buckets.values()].sort((left, right) => left.startMs - right.startMs);
        return { facts, buckets: facts.map(bucket => {
            const calendar = resolveUsageCalendarInstant(bucket.startMs, timeZoneOffsetMinutes);
            return { startMs: bucket.startMs, endMs: bucket.endMs, date: calendar.date, weekday: calendar.weekday,
                hour: granularity === 'hour' ? calendar.hour : null, ...projectFigures(bucket) };
        }) };
    };
    const hourProjection = projectBuckets('hour');
    const days = projectBuckets('day', hourProjection.facts).buckets;
    const weeks = projectBuckets('week', hourProjection.facts).buckets;
    const hours = hourProjection.buckets;
    const periodPopulation = createBucketPopulation();
    const weekdayHours = new Map<string, BucketPopulation & { weekday: number; hour: number }>();
    const hoursOfDay = new Map<number, BucketPopulation & { hour: number }>();
    for (const facts of hourProjection.facts) {
        appendBucketPopulation(periodPopulation, facts, costMode);
        const { weekday, hour } = resolveUsageCalendarInstant(facts.startMs, timeZoneOffsetMinutes);
        const key = `${weekday}:${hour}`;
        const cell: BucketPopulation & { weekday: number; hour: number } = weekdayHours.get(key)
            ?? { weekday, hour, ...createBucketPopulation() };
        appendBucketPopulation(cell, facts, costMode);
        weekdayHours.set(key, cell);
        const dayCell: BucketPopulation & { hour: number } = hoursOfDay.get(hour)
            ?? { hour, ...createBucketPopulation() };
        appendBucketPopulation(dayCell, facts, costMode);
        hoursOfDay.set(hour, dayCell);
    }
    // A witnessed wait or unknown-ended lane still establishes Agent membership,
    // although it supplies no measured busy span or accounting denominator.
    for (const lane of intervals?.lanes ?? []) if (!periodPopulation.busy.has(lane.agentId)) periodPopulation.busy.set(lane.agentId, []);
    const periodFigures = projectFigures(periodPopulation);
    // Context-only runtime observations currently encode absent accounting as zero.
    // The query has no measurement-presence marker, so zero cannot establish a
    // measured share or a context-only classification. Preserve nullable shares.
    const periodSummary: UsageAgentCalendar['periodSummary'] = { ...periodFigures, agents: periodFigures.agents.map(agent => ({ ...agent,
        shares: { tokens: resolveUsageCalendarShare(agent.metrics.tokens, periodFigures.totals.tokens),
            cost: agent.metrics.cost?.currency === periodFigures.totals.cost?.currency
                ? resolveUsageCalendarShare(agent.metrics.cost?.amountUsd ?? null, periodFigures.totals.cost?.amountUsd ?? null) : null } })) };
    // Dated spans stay on their real instants: the same sweep takes the maximum
    // across weeks, while Sessions are deduplicated from their witnessed Session ids.
    const weekdayHourBuckets = [...weekdayHours.values()].sort((left, right) => left.weekday - right.weekday || left.hour - right.hour)
        .map(cell => ({ weekday: cell.weekday, hour: cell.hour, ...projectFigures(cell) }));
    const hourOfDayBuckets = [...hoursOfDay.values()].sort((left, right) => left.hour - right.hour)
        .map(cell => ({ hour: cell.hour, ...projectFigures(cell) }));
    const dayNightActivity = projectDayNightActivity(input);
    const busyAgents = new Set(intervals?.lanes.filter(lane => lane.busy.length > 0).map(lane => lane.agentId));
    const accountingAgents = new Set(periodPopulation.rows.map(row => row.agentId));
    const result: UsageAgentCalendar = { period, timeZoneOffsetMinutes, costMode, coverage, periodSummary, days, weeks, hours, weekdayHourBuckets, hourOfDayBuckets,
        agentActiveDays: projectActiveDays(days, new Map(periodFigures.agents.filter(agent => accountingAgents.has(agent.agentId))
            .map(agent => [agent.agentId, agent.coverage.accounting])), busyAgents, busyCoverage),
        weeklyAgentMix: projectWeeklyAgentMix(weeks),
        weeklyPeakParallel: weeks.flatMap(week => week.totals.peakParallel === null ? [] : [{ startMs: week.startMs, endMs: week.endMs, peak: week.totals.peakParallel, coverage: busyCoverage }]),
        dayNightActivity, machineKinds: { status: 'unavailable', reason: 'no_witnessed_kind' } };
    return result;
}
