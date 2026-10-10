import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { UsageAnalyticsQueryResponseSchema, type UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { resolveUsageCalendarInstant } from './usageCalendar.js';
import { projectUsageFootprint, UsageFootprintProjectionSchema } from './usageFootprint.js';
import { isUsageNightHour, projectUsageWorkIntervals, UsageNightHoursV1Schema, UsageWorkIntervalsProjectionSchema, type UsageWorkIntervalFact,
    type UsageWorkPermissionFact, type UsageWorkIntervalsInput } from './usageWorkIntervals.js';
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
    activityAtMs?: readonly number[];
    /** Same admitted private detail read; never an accounting metadata carrier. */
    coach?: UsageCoachReadEvidence;
}
const CountSchema = lazyZodSchema(() => z.number().int().nonnegative());
const DurationSchema = lazyZodSchema(() => z.number().finite().nonnegative());
export const UsageHowYouWorkSchema = lazyZodSchema(() => z.object({
    detailStatus: z.enum(['available', 'partial', 'unknown']),
    intervals: UsageWorkIntervalsProjectionSchema.nullable(),
    todayInParallel: z.object({ date: z.string(), startMs: z.number().int(), endMs: z.number().int(),
        agentTimeMs: DurationSchema, elapsedBusyMs: DurationSchema, parallelBusyMs: DurationSchema, maxParallel: CountSchema,
    }).strict().nullable(),
    nightShift: UsageNightHoursV1Schema.safeExtend({
        recordedActivityCount: CountSchema.nullable(), observedBusyMs: DurationSchema.nullable(),
    }).strict().nullable(),
    activity: UsageAnalyticsQueryResponseSchema.shape.activity.unwrap().nullable(),
    permissions: z.object({ requestCount: CountSchema, pairedDecisionCount: CountSchema,
        decisionLatencyMs: DurationSchema.nullable(), unknownRequestTimeCount: CountSchema, unknownDecisionTimeCount: CountSchema,
        byAnsweringClient: z.object({ ios: CountSchema, android: CountSchema, web: CountSchema, desktop: CountSchema, unknown: CountSchema }).strict(),
        byTool: z.array(z.object({ toolId: z.string().nullable(), requestCount: CountSchema, pairedDecisionCount: CountSchema,
            decisionLatencyMs: DurationSchema.nullable() }).strict()),
    }).strict().nullable(),
    inputs: z.object({ acceptedCount: CountSchema, steeringCount: CountSchema,
        byDeliveryKind: z.object({ newTurn: CountSchema, followUp: CountSchema, steer: CountSchema }).strict(),
    }).strict().nullable(),
    footprint: UsageFootprintProjectionSchema.nullable(),
}).strict().superRefine((value, context) => {
    if (value.detailStatus === 'unknown') {
        if (value.nightShift?.observedBusyMs !== undefined && value.nightShift.observedBusyMs !== null) {
            context.addIssue({ code: 'custom', path: ['nightShift', 'observedBusyMs'], message: 'Unknown private detail cannot disclose busy duration' });
        }
        for (const field of ['intervals', 'todayInParallel', 'permissions', 'inputs'] as const) {
            if (value[field] !== null) context.addIssue({ code: 'custom', path: [field], message: 'Unknown private detail cannot disclose facts' });
        }
    }
}));
export type UsageHowYouWork = z.infer<typeof UsageHowYouWorkSchema>;

export function resolveUsageHowYouWork(input: Readonly<{
    period: UsageWorkIntervalsInput['period']; timeZoneOffsetMinutes: number; nowMs?: number;
    accounting?: UsageAnalyticsQueryResponse; detail?: UsageHowYouWorkDetailInput; nightHours?: UsageWorkIntervalsInput['nightHours'];
}>): UsageHowYouWork {
    const detail = input.detail?.status === 'unknown' ? undefined : input.detail;
    const intervals = detail?.facts !== undefined
        ? projectUsageWorkIntervals({ ...input, facts: detail.facts, activityAtMs: detail.activityAtMs }) : null;
    const nightHours = input.nightHours ? UsageNightHoursV1Schema.parse(input.nightHours) : undefined;
    const buckets = input.accounting?.activity?.weekdayHourBuckets;
    const nightShift = nightHours ? { ...nightHours, observedBusyMs: intervals?.night?.busyMs ?? null,
        recordedActivityCount: input.accounting ? buckets === undefined ? null : buckets.reduce((sum, row) =>
            sum + (isUsageNightHour(row.hour, nightHours) ? row.eventCount : 0), 0) : intervals?.night?.activityCount ?? null,
    } : null;
    if (intervals?.night && nightShift) intervals.night.activityCount = nightShift.recordedActivityCount;
    const today = input.nowMs === undefined ? null : resolveUsageCalendarInstant(input.nowMs, input.timeZoneOffsetMinutes);
    const todayPeriod = today ? { startMs: Math.max(today.bucketStartMs, input.period.startMs),
        endMs: Math.min(today.bucketEndMs, input.period.endMs) } : null;
    const todayIntervals = detail?.facts !== undefined && todayPeriod && todayPeriod.startMs < todayPeriod.endMs
        ? projectUsageWorkIntervals({ period: todayPeriod, timeZoneOffsetMinutes: input.timeZoneOffsetMinutes, facts: detail.facts }) : null;
    const result: UsageHowYouWork = {
        detailStatus: !detail ? 'unknown' : detail.status === 'partial' || intervals?.coverage === 'partial' ? 'partial' : 'available',
        intervals, todayInParallel: todayIntervals && today ? { date: today.date, ...todayIntervals.period,
            agentTimeMs: todayIntervals.agentTimeMs, elapsedBusyMs: todayIntervals.elapsedBusyMs,
            parallelBusyMs: todayIntervals.parallelBusyMs, maxParallel: todayIntervals.maxParallel } : null,
        nightShift, activity: input.accounting?.activity ?? null, footprint: input.accounting ? projectUsageFootprint(input.accounting) : null,
        permissions: null, inputs: null,
    };
    if (detail) {
        const inPeriod = (instant: number) => Number.isSafeInteger(instant) && instant >= input.period.startMs && instant < input.period.endMs;
        const permissions: NonNullable<UsageHowYouWork['permissions']> = { requestCount: 0, pairedDecisionCount: 0,
            decisionLatencyMs: null, unknownRequestTimeCount: 0, unknownDecisionTimeCount: 0,
            byAnsweringClient: { ios: 0, android: 0, web: 0, desktop: 0, unknown: 0 }, byTool: [] };
        const tools = new Map<string | null, NonNullable<UsageHowYouWork['permissions']>['byTool'][number]>();
        const seenPermissions = new Set<string>();
        for (const fact of detail.permissions ?? []) {
            const key = JSON.stringify([fact.workId, fact.requestId]);
            if (seenPermissions.has(key)) continue;
            seenPermissions.add(key);
            if (!(fact.requestedAtMs !== null && inPeriod(fact.requestedAtMs))
                && !(fact.decidedAtMs !== null && inPeriod(fact.decidedAtMs))) continue;
            permissions.requestCount += 1;
            if (fact.requestedAtMs === null) permissions.unknownRequestTimeCount += 1;
            if (fact.decidedAtMs === null) permissions.unknownDecisionTimeCount += 1;
            if (fact.decidedAtMs !== null && inPeriod(fact.decidedAtMs)) permissions.byAnsweringClient[fact.answeringClientCategory ?? 'unknown'] += 1;
            const tool = tools.get(fact.toolId) ?? { toolId: fact.toolId, requestCount: 0, pairedDecisionCount: 0, decisionLatencyMs: null };
            tool.requestCount += 1;
            if (fact.requestedAtMs !== null && fact.decidedAtMs !== null && fact.decidedAtMs >= fact.requestedAtMs
                && Number.isSafeInteger(fact.requestedAtMs) && inPeriod(fact.decidedAtMs)) {
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
        for (const fact of detail.acceptedInputs ?? []) {
            const key = JSON.stringify([fact.workId, fact.inputId]);
            if (accepted.has(key) || !inPeriod(fact.acceptedAtMs)) continue;
            accepted.add(key);
            inputs.acceptedCount += 1;
            inputs.byDeliveryKind[fact.deliveryKind] += 1;
            if (fact.deliveryKind === 'steer') inputs.steeringCount += 1;
        }
        if (detail.permissions !== undefined) result.permissions = permissions;
        if (detail.acceptedInputs !== undefined) result.inputs = inputs;
    }
    return UsageHowYouWorkSchema.parse(result);
}
