import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { UsageAnalyticsQueryResponseSchema, type UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { resolveUsageCalendarInstant } from './usageCalendar.js';
import { projectUsageFootprint, UsageFootprintProjectionSchema } from './usageFootprint.js';
import { isUsageNightHour, prepareUsageWorkIntervals, projectPreparedUsageWorkIntervals, prepareUsageWorkPermissions, selectPreparedUsageWorkPermissions, UsageNightHoursV1Schema, UsageWorkIntervalsProjectionSchema, type UsageWorkIntervalFact,
    prepareUsageClosedTurns, projectPreparedUsageClosedTurns, UsageRunLengthSummarySchema, type UsageClosedTurnFact,
    type UsageWorkPermissionFact, type UsageWorkIntervalsInput } from './usageWorkIntervals.js';
import { createUsageSteeringHourResolver, prepareUsageSteeringEvidence, projectPreparedUsageSteering, UsageSteeringSummarySchema,
    type PreparedUsageSteeringEvidence } from './usageSteering.js';
import { prepareUsageCollaborationFacts, resolvePreparedUsageCollaboration, resolveUsageCollaborationHistoricalSource,
    UsageCollaborationSummarySchema, type UsageCollaborationFact } from './usageCollaboration.js';
import { projectUsageAgentCalendar, resolveUsageAccountingCalendarPeriod, UsageAgentCalendarSchema, type UsageAgentAccountingCalendar } from './usageAgentCalendar.js';
import type { UsageCostMode } from './usageCostFacts.js';
import type { UsageCoachReadEvidence } from './coach/coachFinding.js';
import type { OpenedUsageSession } from './usageWorkEvidence.js';

/** Exact accepted custody outcomes; queued intent is not an accepted input. */
export interface UsageAcceptedInputFact {
    inputId: string;
    workId: string;
    acceptedAtMs: number;
    deliveryKind: 'newTurn' | 'followUp' | 'steer';
    turnId: string;
}
/** Already-authorized private detail. This owner never fetches or broadens scope. */
export interface UsageHowYouWorkDetailInput {
    status: 'available' | 'partial' | 'unknown';
    /** Absent is unknown; an array is a supplied observed subset, including empty. */
    facts?: readonly UsageWorkIntervalFact[];
    permissions?: readonly UsageWorkPermissionFact[];
    acceptedInputs?: readonly UsageAcceptedInputFact[];
    closedTurns?: readonly UsageClosedTurnFact[];
    collaboration?: readonly UsageCollaborationFact[];
    activityAtMs?: readonly number[];
    /** Same admitted private detail read; never an accounting metadata carrier. */
    coach?: UsageCoachReadEvidence;
    /** Content-free points observed in the already-opened transcript; no inferred turn or duration. */
    phaseEvents?: readonly UsageAutopsyEvent[];
}
const UsageAutopsyEventSchema = lazyZodSchema(() => z.strictObject({
    evidenceId: z.string().check(z.minLength(1)), sessionId: z.string().check(z.minLength(1)), turnId: z.nullable(z.string()),
    observedAtMs: z.number().check(z.int(), z.nonnegative()), kind: z.enum(['read', 'change', 'execute', 'delegate', 'compaction', 'unknown']),
    method: z.enum(['tool_classification', 'native_event']),
}));
export type UsageAutopsyEvent = z.infer<typeof UsageAutopsyEventSchema>;
const CountSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const DurationSchema = lazyZodSchema(() => z.number().check(z.nonnegative()));
/** Coverage of the exact Session evidence read, including admitted empty Sessions. */
export const UsageSessionEvidenceCoverageSchema = lazyZodSchema(() => z.strictObject({
    selected: CountSchema, admitted: CountSchema, notRead: z.optional(CountSchema),
}).check(z.refine(value => value.admitted <= value.selected
    && (value.notRead === undefined || value.notRead <= value.admitted))));
export type UsageSessionEvidenceCoverage = z.infer<typeof UsageSessionEvidenceCoverageSchema>;

/** Admission permits a read; only observed private evidence counts as checked. */
export function countUsageCheckedSessions(coverage: UsageSessionEvidenceCoverage | undefined): number | undefined {
    return coverage === undefined ? undefined : coverage.admitted - (coverage.notRead ?? 0);
}

export const UsageHowYouWorkSchema = lazyZodSchema(() => z.strictObject({
    detailStatus: z.enum(['available', 'partial', 'unknown']),
    sessionCoverage: z.optional(UsageSessionEvidenceCoverageSchema),
    autopsy: z.optional(z.strictObject({ coverage: z.enum(['complete', 'partial']), events: z.array(UsageAutopsyEventSchema) })),
    intervals: z.nullable(UsageWorkIntervalsProjectionSchema),
    runLengths: z.optional(z.nullable(UsageRunLengthSummarySchema)),
    steering: z.optional(z.nullable(UsageSteeringSummarySchema)),
    collaboration: z.optional(z.nullable(UsageCollaborationSummarySchema)),
    agentCalendar: z.optional(z.nullable(UsageAgentCalendarSchema)),
    todayInParallel: z.nullable(z.strictObject({ date: z.string(), startMs: z.number().check(z.int()), endMs: z.number().check(z.int()),
        agentTimeMs: DurationSchema, elapsedBusyMs: DurationSchema, parallelBusyMs: DurationSchema, maxParallel: CountSchema,
    })),
    nightShift: z.nullable((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(UsageNightHoursV1Schema, {
        recordedActivityCount: z.nullable(CountSchema), observedBusyMs: z.nullable(DurationSchema),
    }))),
    activity: z.nullable(UsageAnalyticsQueryResponseSchema.shape.activity._zod.def.innerType),
    permissions: z.nullable(z.strictObject({ requestCount: CountSchema, pairedDecisionCount: CountSchema,
        decisionLatencyMs: z.nullable(DurationSchema), unknownRequestTimeCount: CountSchema, unknownDecisionTimeCount: CountSchema,
        byAnsweringClient: z.strictObject({ ios: CountSchema, android: CountSchema, web: CountSchema, desktop: CountSchema, unknown: CountSchema }),
        byTool: z.array(z.strictObject({ toolId: z.nullable(z.string()), requestCount: CountSchema, pairedDecisionCount: CountSchema,
            decisionLatencyMs: z.nullable(DurationSchema) })),
    })),
    inputs: z.nullable(z.strictObject({ acceptedCount: CountSchema, steeringCount: CountSchema,
        byDeliveryKind: z.strictObject({ newTurn: CountSchema, followUp: CountSchema, steer: CountSchema }),
    })),
    footprint: z.nullable(UsageFootprintProjectionSchema),
}).check(z.superRefine((value, context) => {
    if (value.detailStatus === 'unknown') {
        if (value.nightShift?.observedBusyMs !== undefined && value.nightShift.observedBusyMs !== null) {
            context.addIssue({ code: 'custom', path: ['nightShift', 'observedBusyMs'], message: 'Unknown private detail cannot disclose busy duration' });
        }
        if (value.autopsy !== undefined) context.addIssue({ code: 'custom', path: ['autopsy'], message: 'Unknown private detail cannot disclose autopsy facts' });
        for (const field of ['intervals', 'todayInParallel', 'permissions', 'inputs', 'runLengths', 'steering', 'collaboration'] as const) {
            if (value[field] != null) context.addIssue({ code: 'custom', path: [field], message: 'Unknown private detail cannot disclose facts' });
        }
        const calendar = value.agentCalendar;
        if (calendar && (calendar.coverage.busy !== 'unavailable' || calendar.coverage.steering !== 'unavailable'
            || calendar.weeklyPeakParallel.length > 0
            || [calendar.periodSummary, ...calendar.days, ...calendar.weeks, ...calendar.hours, ...calendar.weekdayHourBuckets, ...calendar.hourOfDayBuckets].some(bucket => [bucket.totals, ...bucket.agents.map(agent => agent.metrics)]
                .some(metrics => metrics.busyMs !== null || metrics.steeringCount !== null || metrics.peakParallel !== null)))) {
            context.addIssue({ code: 'custom', path: ['agentCalendar'], message: 'Unknown private detail cannot disclose calendar interventions or busy facts' });
        }
    }
})));
export type UsageHowYouWork = z.infer<typeof UsageHowYouWorkSchema>;

type UsagePrivateDetailProjection = Readonly<{
    value: Pick<UsageHowYouWork, 'autopsy' | 'permissions' | 'inputs' | 'runLengths' | 'collaboration'>;
    selectedInputs: readonly UsageAcceptedInputFact[];
    selectedPermissions: Readonly<{ requests: readonly UsageWorkPermissionFact[]; paired: readonly UsageWorkPermissionFact[] }>;
    sources: readonly UsagePrivateSourceProjection[];
    steering: Map<number, NonNullable<UsageHowYouWork['steering']>>;
}>;
type UsagePrivateSourceProjection = Readonly<{
    intervals: ReturnType<typeof prepareUsageWorkIntervals>;
    permissions: ReturnType<typeof prepareUsageWorkPermissions>;
    inputs: readonly Readonly<{ source: UsageAcceptedInputFact; fact: UsageAcceptedInputFact; identity: string; selected: boolean }>[];
    turns: ReturnType<typeof prepareUsageClosedTurns>;
    events: readonly Readonly<{ source: object; event: UsageAutopsyEvent; identity: string; nativeCompaction: boolean }>[];
    collaboration: ReturnType<typeof prepareUsageCollaborationFacts>;
    detail: UsageHowYouWorkDetailInput;
    steering: Map<number, PreparedUsageSteeringEvidence>;
}>;
type UsagePrivateDetailState = {
    intervals: WeakMap<UsageWorkIntervalsInput['period'], ReturnType<typeof prepareUsageWorkIntervals>>;
    prepared: WeakMap<UsageWorkIntervalsInput['period'], UsagePrivateSourceProjection>;
    projections: WeakMap<UsageWorkIntervalsInput['period'], UsagePrivateDetailProjection>;
    historicalSources: Map<UsageCollaborationFact, Readonly<{ source: OpenedUsageSession | undefined;
        membership: readonly boolean[] | undefined; value: UsageCollaborationFact }>>;
};
// Opened evidence can outlive many rolling queries. Prepared populations belong
// to each admitted period, so retiring that query also retires its preparation.
const privateDetailProjections = new WeakMap<UsageHowYouWorkDetailInput, UsagePrivateDetailState>();
const privateTodayPeriods = new WeakMap<UsageWorkIntervalsInput['period'], UsageWorkIntervalsInput['period']>();
const privateDetailPartitions = Symbol('usage private source partitions');
type PartitionedPrivateDetail = UsageHowYouWorkDetailInput & {
    [privateDetailPartitions]?: Readonly<{ sources: readonly UsageHowYouWorkDetailInput[];
        collaborationSources: ReadonlyMap<UsageCollaborationFact, UsageCollaborationFact> }>;
};
function privateDetailState(detail: UsageHowYouWorkDetailInput): UsagePrivateDetailState {
    let state = privateDetailProjections.get(detail);
    if (!state) {
        state = { intervals: new WeakMap(), prepared: new WeakMap(), projections: new WeakMap(), historicalSources: new Map() };
        privateDetailProjections.set(detail, state);
    }
    return state;
}
function projectUsagePrivateIntervals(detail: UsageHowYouWorkDetailInput, input: UsageWorkIntervalsInput) {
    const intervals = projectPreparedUsageWorkIntervals(input, () => {
        const sources = (detail as PartitionedPrivateDetail)[privateDetailPartitions]?.sources ?? [detail];
        const allowed = new Set(input.facts);
        return sources.flatMap(source => prepareUsagePrivateIntervals(source, input.period)).filter(row => allowed.has(row.source));
    });
    // An empty partial read cannot establish zero work; complete observed emptiness can.
    return detail.status === 'partial' && intervals.coverage === 'complete_for_supplied_facts' && intervals.lanes.length === 0
        ? null : intervals;
}
function prepareUsagePrivateIntervals(detail: UsageHowYouWorkDetailInput, period: UsageWorkIntervalsInput['period']) {
    const state = privateDetailState(detail);
    let intervals = state.intervals.get(period);
    if (!intervals) {
        intervals = prepareUsageWorkIntervals(detail.facts ?? [], period);
        state.intervals.set(period, intervals);
    }
    return intervals;
}

/** Today's clipping shares the admitted query's lifetime, including across source phases. */
function retainPrivateTodayPeriod(period: UsageWorkIntervalsInput['period'], today: UsageWorkIntervalsInput['period']) {
    if (period.startMs === today.startMs && period.endMs === today.endMs) return period;
    const retained = privateTodayPeriods.get(period);
    if (retained?.startMs === today.startMs && retained.endMs === today.endMs) return retained;
    privateTodayPeriods.set(period, today);
    return today;
}
/** Internal provenance from the canonical query projector; never serialized or admitted as new evidence. */
export function retainUsagePrivateDetailPartitions(detail: UsageHowYouWorkDetailInput,
    sources: readonly UsageHowYouWorkDetailInput[], collaborationSources: ReadonlyMap<UsageCollaborationFact, UsageCollaborationFact>) {
    Object.defineProperty(detail, privateDetailPartitions, { value: { sources, collaborationSources } });
    return detail;
}
/** Reuse a historical join only while its actual source Session and admitted turn membership stay unchanged. */
export function projectUsagePrivateCollaborationSources(detail: UsageHowYouWorkDetailInput,
    sessions: ReadonlyMap<string, OpenedUsageSession>, admittedWork?: ReadonlySet<string>): readonly UsageCollaborationFact[] {
    const state = privateDetailState(detail);
    return (detail.collaboration ?? []).map(fact => {
        const source = fact.sourceSessionId === null ? undefined : sessions.get(fact.sourceSessionId);
        const membership = source && admittedWork ? source.sessionTurns?.turns.map(turn => admittedWork.has(JSON.stringify([source.id, turn.turnId]))) ?? [] : undefined;
        const previous = state.historicalSources.get(fact);
        if (previous && previous.source === source && (previous.membership === membership
            || previous.membership && membership && previous.membership.length === membership.length
            && previous.membership.every((value, index) => value === membership[index]))) return previous.value;
        const value = resolveUsageCollaborationHistoricalSource(fact, source, admittedWork);
        state.historicalSources.set(fact, { source, membership, value });
        return value;
    });
}

export function resolveUsageHowYouWork(input: Readonly<{
    period: UsageWorkIntervalsInput['period']; timeZoneOffsetMinutes: number; nowMs?: number;
    accounting?: UsageAnalyticsQueryResponse; detail?: UsageHowYouWorkDetailInput; nightHours?: UsageWorkIntervalsInput['nightHours'];
    accountingCalendar?: UsageAgentAccountingCalendar;
    /** Admitted calendar bounds may have an open start independently of private evidence intervals. */
    calendarPeriod?: Readonly<{ startMs?: number; endMs: number }>;
    /** The query's existing transcript demand; interval-only charts do not shape intervention grids. */
    includeSteering?: boolean;
    /** Existing accounting Activity/timeline demand, not another query or cache. */
    includeAgentCalendar?: boolean;
    costMode?: UsageCostMode;
    sessionCoverage?: UsageSessionEvidenceCoverage;
    /** Already admitted private projection for this exact query, only while its source is pending. */
    retained?: UsageHowYouWork;
}>): UsageHowYouWork {
    const detail = input.detail?.status === 'unknown' ? undefined : input.detail;
    const retained = input.detail === undefined ? input.retained : undefined;
    const nightHours = input.nightHours ? UsageNightHoursV1Schema.parse(input.nightHours) : undefined;
    let intervals = detail?.facts !== undefined
        ? projectUsagePrivateIntervals(detail, { ...input, facts: detail.facts, activityAtMs: detail.activityAtMs })
        : retained?.intervals ? { ...retained.intervals, night: nightHours ? { ...nightHours,
            busyMs: retained.intervals.weekdayHourBuckets.reduce((sum, row) =>
                sum + (isUsageNightHour(row.hour, nightHours) ? row.busyMs : 0), 0),
            activityCount: null,
        } : null } : null;
    const buckets = input.accounting?.activity?.weekdayHourBuckets;
    const nightShift = nightHours ? { ...nightHours, observedBusyMs: intervals?.night?.busyMs ?? null,
        recordedActivityCount: input.accounting ? buckets === undefined ? null : buckets.reduce((sum, row) =>
            sum + (isUsageNightHour(row.hour, nightHours) ? row.eventCount : 0), 0) : intervals?.night?.activityCount ?? null,
    } : null;
    if (intervals?.night && nightShift && intervals.night.activityCount !== nightShift.recordedActivityCount) {
        intervals = { ...intervals, night: { ...intervals.night, activityCount: nightShift.recordedActivityCount } };
    }
    const today = input.nowMs === undefined ? null : resolveUsageCalendarInstant(input.nowMs, input.timeZoneOffsetMinutes);
    const todayPeriod = today ? retainPrivateTodayPeriod(input.period, { startMs: Math.max(today.bucketStartMs, input.period.startMs),
        endMs: Math.min(today.bucketEndMs, input.period.endMs) }) : null;
    const todayIntervals = detail?.facts !== undefined && todayPeriod && todayPeriod.startMs < todayPeriod.endMs
        ? projectUsagePrivateIntervals(detail, { period: todayPeriod, timeZoneOffsetMinutes: input.timeZoneOffsetMinutes, facts: detail.facts }) : null;
    const result: UsageHowYouWork = {
        ...((input.sessionCoverage ?? retained?.sessionCoverage) === undefined ? {} : {
            sessionCoverage: input.sessionCoverage ?? retained?.sessionCoverage,
        }),
        ...(retained?.autopsy === undefined ? {} : { autopsy: retained.autopsy }),
        detailStatus: !detail ? retained?.detailStatus ?? 'unknown' : detail.status === 'partial' || intervals?.coverage === 'partial' ? 'partial' : 'available',
        // An empty historical subset cannot establish that no work ran today.
        // Keep complete observed emptiness distinct from missing lifecycle coverage.
        intervals, todayInParallel: todayIntervals && today && (
            detail?.status === 'available' && todayIntervals.coverage === 'complete_for_supplied_facts'
            || todayIntervals.lanes.some(lane => lane.busy.length > 0 || lane.waits.length > 0))
            ? { date: today.date, ...todayIntervals.period,
            agentTimeMs: todayIntervals.agentTimeMs, elapsedBusyMs: todayIntervals.elapsedBusyMs,
            parallelBusyMs: todayIntervals.parallelBusyMs, maxParallel: todayIntervals.maxParallel } : retained?.todayInParallel ?? null,
        nightShift, activity: input.accounting?.activity ?? null, footprint: input.accounting ? projectUsageFootprint(input.accounting) : null,
        permissions: retained?.permissions ?? null, inputs: retained?.inputs ?? null,
        runLengths: retained?.runLengths ?? null, steering: retained?.steering ?? null,
        collaboration: retained?.collaboration ?? null,
    };
    if (detail) {
        const projection = projectUsagePrivateDetail(detail, input.period);
        Object.assign(result, projection.value);
        if (input.includeSteering !== false && (detail.permissions !== undefined || detail.acceptedInputs !== undefined)) {
            let steering = projection.steering.get(input.timeZoneOffsetMinutes);
            if (!steering) {
                const hourAt = createUsageSteeringHourResolver(input.period, input.timeZoneOffsetMinutes);
                const preparations = projection.sources.map(source => {
                    let prepared = source.steering.get(input.timeZoneOffsetMinutes);
                    if (!prepared) {
                        prepared = prepareUsageSteeringEvidence({ facts: source.intervals.map(row => row.fact),
                            closedTurns: source.turns.map(row => row.witness),
                            acceptedInputs: source.inputs.filter(row => row.selected).map(row => row.fact),
                            permissions: { requests: source.permissions.filter(row => row.answered).map(row => row.fact), paired: [] } }, hourAt);
                        const turnSources = new Map<UsageWorkIntervalFact | UsageClosedTurnFact, UsageWorkIntervalFact | UsageClosedTurnFact>([
                            ...source.turns.map(row => [row.witness, row.source] as const),
                            ...source.intervals.map(row => [row.fact, row.source] as const),
                        ]);
                        prepared = { ...prepared, identities: prepared.identities.map(row => ({ ...row,
                            source: turnSources.get(row.source) ?? row.source })) };
                        source.steering.set(input.timeZoneOffsetMinutes, prepared);
                    }
                    return prepared;
                });
                const allowedIdentities = new Set<UsageWorkIntervalFact | UsageClosedTurnFact>([...(detail.facts ?? []), ...(detail.closedTurns ?? [])]);
                steering = projectPreparedUsageSteering({ period: input.period, timeZoneOffsetMinutes: input.timeZoneOffsetMinutes,
                    coverage: detail.status === 'available' ? 'complete_for_supplied_facts' : 'partial',
                    intervals, facts: detail.facts, closedTurns: detail.closedTurns,
                    ...(detail.acceptedInputs === undefined ? {} : { acceptedInputs: projection.selectedInputs }),
                    ...(detail.permissions === undefined ? {} : { permissions: projection.selectedPermissions }),
                }, { identities: preparations.flatMap(prepared => prepared.identities).filter(row => allowedIdentities.has(row.source)),
                    hours: new Map(preparations.flatMap(prepared => [...prepared.hours])) });
                projection.steering.set(input.timeZoneOffsetMinutes, steering);
            }
            result.steering = steering;
        }
    }
    // Accounting can advance a rolling window before private evidence answers.
    // Keep that evidence's calendar at its witnessed window, like its intervals
    // and Coach projection, rather than combining it with a different period
    // and turning admitted busy facts into unavailable values.
    const retainedCalendar = retained?.agentCalendar && intervals
        && (intervals.period.startMs !== input.period.startMs || intervals.period.endMs !== input.period.endMs)
        ? retained.agentCalendar : undefined;
    if (input.includeAgentCalendar !== false) result.agentCalendar = retainedCalendar ?? projectUsageAgentCalendar({
        period: resolveUsageAccountingCalendarPeriod({ period: input.calendarPeriod ?? input.period,
            accounting: input.accounting, timeZoneOffsetMinutes: input.timeZoneOffsetMinutes,
            intervals, steering: result.steering }),
        timeZoneOffsetMinutes: input.timeZoneOffsetMinutes, accounting: input.accounting,
        accountingCalendar: input.accountingCalendar,
        intervals, detailStatus: result.detailStatus, steering: result.steering, nightHours, costMode: input.costMode,
    });
    return result;
}

function projectUsagePrivateDetail(detail: UsageHowYouWorkDetailInput,
    period: UsageWorkIntervalsInput['period']): UsagePrivateDetailProjection {
    const state = privateDetailState(detail);
    const previous = state.projections.get(period);
    if (previous) return previous;
    const partitions = (detail as PartitionedPrivateDetail)[privateDetailPartitions];
    const sources = (partitions?.sources ?? [detail]).map(source => prepareUsagePrivateSource(source, period));
    const allowedPermissions = new Set(detail.permissions);
    const allowedInputs = new Set(detail.acceptedInputs);
    const allowedTurns = new Set(detail.closedTurns);
    const allowedEvents = new Set<object>([...(detail.phaseEvents ?? []), ...(detail.coach?.detail?.compactions ?? [])]);
    const allowedCollaboration = new Set(detail.collaboration);
    const result: UsagePrivateDetailProjection['value'] = { permissions: null, inputs: null, runLengths: null, collaboration: null };
    if (detail.phaseEvents !== undefined || detail.coach?.detail?.compactions !== undefined) {
        // The original order is all phase points, then all compaction points.
        const events = sources.flatMap(source => source.events).filter(row => allowedEvents.has(row.source))
            .sort((left, right) => Number(left.nativeCompaction) - Number(right.nativeCompaction));
        result.autopsy = { coverage: 'partial', events: [...new Map(events.map(row => [row.identity, row.event])).values()]
            .sort((left, right) => left.observedAtMs - right.observedAtMs || left.evidenceId.localeCompare(right.evidenceId)) };
    }
    const permissions: NonNullable<UsageHowYouWork['permissions']> = { requestCount: 0, pairedDecisionCount: 0,
        decisionLatencyMs: null, unknownRequestTimeCount: 0, unknownDecisionTimeCount: 0,
        byAnsweringClient: { ios: 0, android: 0, web: 0, desktop: 0, unknown: 0 }, byTool: [] };
    const tools = new Map<string | null, NonNullable<UsageHowYouWork['permissions']>['byTool'][number]>();
    const selected = selectPreparedUsageWorkPermissions(sources.flatMap(source => source.permissions)
        .filter(row => allowedPermissions.has(row.source)));
    const selectedPermissions = { requests: selected.requests.map(row => row.fact), paired: selected.paired.map(row => row.fact) };
    for (const prepared of selected.requests) {
        const fact = prepared.fact;
        permissions.requestCount += 1;
        if (fact.requestedAtMs === null) permissions.unknownRequestTimeCount += 1;
        if (fact.decidedAtMs === null) permissions.unknownDecisionTimeCount += 1;
        if (prepared.answered) permissions.byAnsweringClient[fact.answeringClientCategory ?? 'unknown'] += 1;
        const tool = tools.get(fact.toolId) ?? { toolId: fact.toolId, requestCount: 0, pairedDecisionCount: 0, decisionLatencyMs: null };
        tool.requestCount += 1;
        if (prepared.paired && fact.requestedAtMs !== null && fact.decidedAtMs !== null) {
            permissions.pairedDecisionCount += 1;
            permissions.decisionLatencyMs = (permissions.decisionLatencyMs ?? 0) + fact.decidedAtMs - fact.requestedAtMs;
            tool.pairedDecisionCount += 1;
            tool.decisionLatencyMs = (tool.decisionLatencyMs ?? 0) + fact.decidedAtMs - fact.requestedAtMs;
        }
        tools.set(fact.toolId, tool);
    }
    permissions.byTool = [...tools.values()].sort((a, b) => (a.toolId ?? '').localeCompare(b.toolId ?? ''));
    const inputs: NonNullable<UsageHowYouWork['inputs']> = { acceptedCount: 0, steeringCount: 0,
        byDeliveryKind: { newTurn: 0, followUp: 0, steer: 0 } };
    const accepted = new Set<string>();
    const selectedInputs: UsageAcceptedInputFact[] = [];
    for (const prepared of sources.flatMap(source => source.inputs)) {
        if (!allowedInputs.has(prepared.source) || !prepared.selected || accepted.has(prepared.identity)) continue;
        accepted.add(prepared.identity);
        const fact = prepared.fact;
        selectedInputs.push(fact);
        inputs.acceptedCount += 1;
        inputs.byDeliveryKind[fact.deliveryKind] += 1;
        if (fact.deliveryKind === 'steer') inputs.steeringCount += 1;
    }
    if (detail.permissions !== undefined && (detail.status === 'available' || permissions.requestCount > 0)) result.permissions = permissions;
    if (detail.acceptedInputs !== undefined) result.inputs = inputs;
    const coverage = detail.status === 'available' ? 'complete_for_supplied_facts' as const : 'partial' as const;
    if (detail.closedTurns !== undefined) result.runLengths = projectPreparedUsageClosedTurns({
        facts: sources.flatMap(source => source.turns).filter(row => allowedTurns.has(row.source)), coverage });
    if (detail.collaboration !== undefined) result.collaboration = resolvePreparedUsageCollaboration(sources.flatMap(source => source.collaboration)
        .flatMap(row => {
            const fact = partitions?.collaborationSources.get(row.source) ?? row.source;
            return allowedCollaboration.has(fact) ? [{ ...row, fact: fact === row.source ? row.fact : fact }] : [];
        }));
    const projection = { value: result, selectedInputs, selectedPermissions, sources,
        steering: new Map<number, NonNullable<UsageHowYouWork['steering']>>() } satisfies UsagePrivateDetailProjection;
    state.projections.set(period, projection);
    return projection;
}

function prepareUsagePrivateSource(detail: UsageHowYouWorkDetailInput,
    period: UsageWorkIntervalsInput['period']): UsagePrivateSourceProjection {
    const state = privateDetailState(detail);
    const previous = state.prepared.get(period);
    if (previous) return previous;
    const inPeriod = (instant: number) => Number.isSafeInteger(instant) && instant >= period.startMs && instant < period.endMs;
    const events = [...(detail.phaseEvents ?? []).map(source => ({ source, event: { ...source }, nativeCompaction: false })),
        ...(detail.coach?.detail?.compactions ?? []).map(source => ({ source, nativeCompaction: true,
            event: { ...source, kind: 'compaction' as const, method: 'native_event' as const } }))]
        .filter(({ event }) => inPeriod(event.observedAtMs))
        .map(row => ({ ...row, identity: JSON.stringify([row.event.sessionId, row.event.evidenceId, row.event.kind]) }));
    const inputs = (detail.acceptedInputs ?? []).map(source => {
        const fact = { ...source };
        return { source, fact, identity: JSON.stringify([fact.workId, fact.inputId]), selected: inPeriod(fact.acceptedAtMs) };
    });
    const prepared: UsagePrivateSourceProjection = { detail, events, inputs,
        intervals: prepareUsagePrivateIntervals(detail, period),
        permissions: prepareUsageWorkPermissions(detail.permissions ?? [], period),
        turns: prepareUsageClosedTurns(detail.closedTurns ?? [], period),
        collaboration: prepareUsageCollaborationFacts(detail.collaboration ?? [], period), steering: new Map() };
    state.prepared.set(period, prepared);
    return prepared;
}
