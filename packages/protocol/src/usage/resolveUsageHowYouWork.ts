import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { UsageAnalyticsQueryResponseSchema, type UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { resolveUsageCalendarInstant } from './usageCalendar.js';
import { projectUsageFootprint, UsageFootprintProjectionSchema } from './usageFootprint.js';
import { isUsageNightHour, projectUsageWorkIntervals, selectUsageWorkPermissions, UsageNightHoursV1Schema, UsageWorkIntervalsProjectionSchema, type UsageWorkIntervalFact,
    projectUsageClosedTurns, UsageRunLengthSummarySchema, type UsageClosedTurnFact,
    type UsageWorkPermissionFact, type UsageWorkIntervalsInput } from './usageWorkIntervals.js';
import { projectUsageSteering, UsageSteeringSummarySchema } from './usageSteering.js';
import { resolveUsageCollaboration, UsageCollaborationSummarySchema, type UsageCollaborationFact } from './usageCollaboration.js';
import { projectUsageAgentCalendar, resolveUsageAccountingCalendarPeriod, UsageAgentCalendarSchema, type UsageAgentAccountingCalendar } from './usageAgentCalendar.js';
import type { UsageCostMode } from './usageCostFacts.js';
import type { UsageCoachReadEvidence } from './coach/coachFinding.js';

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
    selected: CountSchema, admitted: CountSchema,
}).check(z.refine(value => value.admitted <= value.selected)));
export type UsageSessionEvidenceCoverage = z.infer<typeof UsageSessionEvidenceCoverageSchema>;
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
        ? projectUsageWorkIntervals({ ...input, facts: detail.facts, activityAtMs: detail.activityAtMs })
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
    const todayPeriod = today ? { startMs: Math.max(today.bucketStartMs, input.period.startMs),
        endMs: Math.min(today.bucketEndMs, input.period.endMs) } : null;
    const todayIntervals = detail?.facts !== undefined && todayPeriod && todayPeriod.startMs < todayPeriod.endMs
        ? projectUsageWorkIntervals({ period: todayPeriod, timeZoneOffsetMinutes: input.timeZoneOffsetMinutes, facts: detail.facts }) : null;
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
        const inPeriod = (instant: number) => Number.isSafeInteger(instant) && instant >= input.period.startMs && instant < input.period.endMs;
        if (detail.phaseEvents !== undefined || detail.coach?.detail?.compactions !== undefined) {
            const events: UsageAutopsyEvent[] = [...(detail.phaseEvents ?? []),
                ...(detail.coach?.detail?.compactions ?? []).map(record => ({ ...record, kind: 'compaction' as const, method: 'native_event' as const }))];
            result.autopsy = { coverage: 'partial', events: [...new Map(events.filter(event => inPeriod(event.observedAtMs))
                .map(event => [JSON.stringify([event.sessionId, event.evidenceId, event.kind]), event])).values()]
                .sort((left, right) => left.observedAtMs - right.observedAtMs || left.evidenceId.localeCompare(right.evidenceId)) };
        }
        const permissions: NonNullable<UsageHowYouWork['permissions']> = { requestCount: 0, pairedDecisionCount: 0,
            decisionLatencyMs: null, unknownRequestTimeCount: 0, unknownDecisionTimeCount: 0,
            byAnsweringClient: { ios: 0, android: 0, web: 0, desktop: 0, unknown: 0 }, byTool: [] };
        const tools = new Map<string | null, NonNullable<UsageHowYouWork['permissions']>['byTool'][number]>();
        const selectedPermissions = selectUsageWorkPermissions(detail.permissions ?? [], input.period);
        const pairedPermissions = new Set(selectedPermissions.paired);
        for (const fact of selectedPermissions.requests) {
            permissions.requestCount += 1;
            if (fact.requestedAtMs === null) permissions.unknownRequestTimeCount += 1;
            if (fact.decidedAtMs === null) permissions.unknownDecisionTimeCount += 1;
            if (fact.decidedAtMs !== null && inPeriod(fact.decidedAtMs)) permissions.byAnsweringClient[fact.answeringClientCategory ?? 'unknown'] += 1;
            const tool = tools.get(fact.toolId) ?? { toolId: fact.toolId, requestCount: 0, pairedDecisionCount: 0, decisionLatencyMs: null };
            tool.requestCount += 1;
            if (pairedPermissions.has(fact) && fact.requestedAtMs !== null && fact.decidedAtMs !== null) {
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
        for (const fact of detail.acceptedInputs ?? []) {
            const key = JSON.stringify([fact.workId, fact.inputId]);
            if (accepted.has(key) || !inPeriod(fact.acceptedAtMs)) continue;
            accepted.add(key);
            selectedInputs.push(fact);
            inputs.acceptedCount += 1;
            inputs.byDeliveryKind[fact.deliveryKind] += 1;
            if (fact.deliveryKind === 'steer') inputs.steeringCount += 1;
        }
        if (detail.permissions !== undefined && (detail.status === 'available' || permissions.requestCount > 0)) result.permissions = permissions;
        if (detail.acceptedInputs !== undefined) result.inputs = inputs;
        const coverage = detail.status === 'available' ? 'complete_for_supplied_facts' as const : 'partial' as const;
        if (detail.closedTurns !== undefined) result.runLengths = projectUsageClosedTurns({
            period: input.period, facts: detail.closedTurns, coverage,
        });
        if (detail.collaboration !== undefined) result.collaboration = resolveUsageCollaboration({
            period: input.period, facts: detail.collaboration,
        });
        if (input.includeSteering !== false && (detail.permissions !== undefined || detail.acceptedInputs !== undefined)) {
            result.steering = projectUsageSteering({ period: input.period, timeZoneOffsetMinutes: input.timeZoneOffsetMinutes,
                coverage, intervals, facts: detail.facts, closedTurns: detail.closedTurns,
                ...(detail.acceptedInputs === undefined ? {} : { acceptedInputs: selectedInputs }),
                ...(detail.permissions === undefined ? {} : { permissions: selectedPermissions }),
            });
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
