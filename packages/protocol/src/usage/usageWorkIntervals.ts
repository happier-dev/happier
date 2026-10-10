import { resolveUsageBucketBounds, resolveUsageCalendarInstant } from './usageCalendar.js';
import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';

export const UsageNightHoursV1Schema = lazyZodSchema(() => z.object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) }).strict().refine(value => value.startHour !== value.endHour));

export type UsageWorkIntervalKind = 'busy' | 'permission_wait' | 'user_wait' | 'child_wait';

/** A projection of witnessed lifecycle/tool facts, not a lifecycle authority.
 * workId names exact work across parent/child representations; parentWorkId alone
 * never authorizes deduplication or numeric rollup.
 */
export interface UsageWorkIntervalFact {
    workId: string;
    evidenceId: string;
    agentId: string | null;
    machineId: string | null;
    parentWorkId?: string | null;
    kind: UsageWorkIntervalKind;
    startMs: number;
    endMs: number | null;
}

export interface UsageWorkPermissionFact {
    requestId: string;
    workId: string;
    requestedAtMs: number | null;
    decidedAtMs: number | null;
    toolId: string | null;
    answeringClientCategory: 'ios' | 'android' | 'web' | 'desktop' | null;
}

export interface UsageWorkIntervalsInput {
    period: Readonly<{ startMs: number; endMs: number }>;
    timeZoneOffsetMinutes: number;
    facts: readonly UsageWorkIntervalFact[];
    activityAtMs?: readonly number[];
    nightHours?: Readonly<{ startHour: number; endHour: number }>;
}

export interface UsageWorkIntervalSegment { startMs: number; endMs: number }
export interface UsageWorkIntervalLane {
    workId: string;
    agentId: string | null;
    machineId: string | null;
    parentWorkId: string | null;
    busy: UsageWorkIntervalSegment[];
    waits: Array<UsageWorkIntervalSegment & { kind: Exclude<UsageWorkIntervalKind, 'busy'>; evidenceId: string }>;
}
export interface UsageWorkIntervalsProjection {
    method: 'witnessed_intervals_v1';
    period: Readonly<{ startMs: number; endMs: number }>;
    timeZoneOffsetMinutes: number;
    coverage: 'complete_for_supplied_facts' | 'partial';
    unknownEndCount: number;
    invalidIntervalCount: number;
    agentTimeMs: number;
    elapsedBusyMs: number;
    elapsedWaitMs: number;
    parallelBusyMs: number;
    maxParallel: number;
    lanes: UsageWorkIntervalLane[];
    calendarDays: Array<{ date: string; busyMs: number; waitMs: number }>;
    weekdayHourBuckets: Array<{ weekday: number; hour: number; busyMs: number; waitMs: number }>;
    night: { startHour: number; endHour: number; busyMs: number; activityCount: number | null } | null;
}

const SpanSchema = lazyZodSchema(() => z.object({ startMs: z.number().int(), endMs: z.number().int() }).strict());
const DurationSchema = lazyZodSchema(() => z.number().finite().nonnegative());
export const UsageWorkIntervalsProjectionSchema = lazyZodSchema(() => z.object({
    method: z.literal('witnessed_intervals_v1'), period: SpanSchema,
    timeZoneOffsetMinutes: z.number().int().min(-840).max(840),
    coverage: z.enum(['complete_for_supplied_facts', 'partial']),
    unknownEndCount: z.number().int().nonnegative(), invalidIntervalCount: z.number().int().nonnegative(),
    agentTimeMs: DurationSchema, elapsedBusyMs: DurationSchema, elapsedWaitMs: DurationSchema,
    parallelBusyMs: DurationSchema, maxParallel: z.number().int().nonnegative(),
    lanes: z.array(z.object({
        workId: z.string().min(1), agentId: z.string().nullable(), machineId: z.string().nullable(), parentWorkId: z.string().nullable(),
        busy: z.array(SpanSchema), waits: z.array(SpanSchema.extend({
            kind: z.enum(['permission_wait', 'user_wait', 'child_wait']), evidenceId: z.string().min(1),
        }).strict()),
    }).strict()),
    calendarDays: z.array(z.object({ date: z.string(), busyMs: DurationSchema, waitMs: DurationSchema }).strict()),
    weekdayHourBuckets: z.array(z.object({ weekday: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23),
        busyMs: DurationSchema, waitMs: DurationSchema }).strict()),
    night: UsageNightHoursV1Schema.safeExtend({
        busyMs: DurationSchema, activityCount: z.number().int().nonnegative().nullable() }).strict().nullable(),
}).strict());

function mergeSegments(values: readonly UsageWorkIntervalSegment[]): UsageWorkIntervalSegment[] {
    const sorted = [...values].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const result: UsageWorkIntervalSegment[] = [];
    for (const value of sorted) {
        const previous = result[result.length - 1];
        if (previous && value.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, value.endMs);
        else result.push({ ...value });
    }
    return result;
}

function subtractSegments(busy: readonly UsageWorkIntervalSegment[], waits: readonly UsageWorkIntervalSegment[]) {
    const result: UsageWorkIntervalSegment[] = [];
    const mergedWaits = mergeSegments(waits);
    for (const interval of mergeSegments(busy)) {
        let startMs = interval.startMs;
        for (const wait of mergedWaits) {
            if (wait.endMs <= startMs) continue;
            if (wait.startMs >= interval.endMs) break;
            if (wait.startMs > startMs) result.push({ startMs, endMs: wait.startMs });
            startMs = Math.max(startMs, wait.endMs);
            if (startMs >= interval.endMs) break;
        }
        if (startMs < interval.endMs) result.push({ startMs, endMs: interval.endMs });
    }
    return result;
}

const duration = (segments: readonly UsageWorkIntervalSegment[]) => segments.reduce((sum, row) => sum + row.endMs - row.startMs, 0);

export function isUsageNightHour(hour: number, night: NonNullable<UsageWorkIntervalsInput['nightHours']>) {
    return night.startHour < night.endHour
        ? hour >= night.startHour && hour < night.endHour
        : hour >= night.startHour || hour < night.endHour;
}

export function projectUsageWorkIntervals(input: UsageWorkIntervalsInput): UsageWorkIntervalsProjection {
    if (!Number.isSafeInteger(input.period.startMs) || !Number.isSafeInteger(input.period.endMs)
        || input.period.endMs < input.period.startMs || !Number.isInteger(input.timeZoneOffsetMinutes)
        || Math.abs(input.timeZoneOffsetMinutes) > 840) throw new RangeError('Invalid usage interval period or offset');
    if (input.nightHours && !UsageNightHoursV1Schema.safeParse(input.nightHours).success) throw new RangeError('Invalid usage night hours');
    const result: UsageWorkIntervalsProjection = {
        method: 'witnessed_intervals_v1', period: input.period, timeZoneOffsetMinutes: input.timeZoneOffsetMinutes,
        coverage: 'complete_for_supplied_facts', unknownEndCount: 0, invalidIntervalCount: 0, agentTimeMs: 0,
        elapsedBusyMs: 0, elapsedWaitMs: 0, parallelBusyMs: 0, maxParallel: 0,
        lanes: [], calendarDays: [], weekdayHourBuckets: [],
        night: input.nightHours ? { ...input.nightHours, busyMs: 0, activityCount: input.activityAtMs === undefined ? null : 0 } : null,
    };
    const lanes = new Map<string, UsageWorkIntervalLane>();
    const uncertainWaits = new Map<string, UsageWorkIntervalSegment[]>();
    const seen = new Set<string>();
    for (const fact of input.facts) {
        const identity = JSON.stringify([fact.workId, fact.evidenceId, fact.kind, fact.startMs, fact.endMs]);
        const duplicate = seen.has(identity);
        seen.add(identity);
        if (!Number.isSafeInteger(fact.startMs) || (fact.endMs !== null && (!Number.isSafeInteger(fact.endMs) || fact.endMs < fact.startMs))) {
            if (!duplicate) result.invalidIntervalCount += 1;
            continue;
        }
        if (fact.startMs >= input.period.endMs || (fact.endMs !== null && fact.endMs <= input.period.startMs)) continue;
        const lane = lanes.get(fact.workId) ?? {
            workId: fact.workId, agentId: fact.agentId, machineId: fact.machineId,
            parentWorkId: fact.parentWorkId ?? null, busy: [], waits: [],
        };
        // A second representation can add witnessed lineage without adding work.
        if (!lane.parentWorkId && fact.parentWorkId) lane.parentWorkId = fact.parentWorkId;
        lanes.set(fact.workId, lane);
        if (duplicate) continue;
        if (fact.endMs === null) {
            result.unknownEndCount += 1;
            // An unanswered wait does not prove waiting duration, but cannot become busy time.
            if (fact.kind !== 'busy') {
                const rows = uncertainWaits.get(fact.workId) ?? [];
                rows.push({ startMs: Math.max(fact.startMs, input.period.startMs), endMs: input.period.endMs });
                uncertainWaits.set(fact.workId, rows);
            }
            continue;
        }
        const span = { startMs: Math.max(fact.startMs, input.period.startMs), endMs: Math.min(fact.endMs, input.period.endMs) };
        if (span.startMs === span.endMs) continue;
        if (fact.kind === 'busy') lane.busy.push(span);
        else lane.waits.push({ ...span, kind: fact.kind, evidenceId: fact.evidenceId });
    }
    result.lanes = [...lanes.values()].sort((a, b) => a.workId.localeCompare(b.workId));
    const busy: UsageWorkIntervalSegment[] = [];
    const waits: UsageWorkIntervalSegment[] = [];
    const boundaries = new Map<number, number>();
    for (const lane of result.lanes) {
        lane.busy = subtractSegments(lane.busy, [...lane.waits, ...uncertainWaits.get(lane.workId) ?? []]);
        lane.waits.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.evidenceId.localeCompare(b.evidenceId));
        result.agentTimeMs += duration(lane.busy);
        busy.push(...lane.busy);
        waits.push(...lane.waits);
        for (const span of lane.busy) {
            boundaries.set(span.startMs, (boundaries.get(span.startMs) ?? 0) + 1);
            boundaries.set(span.endMs, (boundaries.get(span.endMs) ?? 0) - 1);
        }
    }
    let active = 0;
    let previous: number | null = null;
    for (const [instant, change] of [...boundaries.entries()].sort((a, b) => a[0] - b[0])) {
        if (previous !== null && active > 1) result.parallelBusyMs += instant - previous;
        active += change;
        result.maxParallel = Math.max(result.maxParallel, active);
        previous = instant;
    }
    const mergedBusy = mergeSegments(busy);
    const mergedWaits = mergeSegments(waits);
    result.elapsedBusyMs = duration(mergedBusy);
    result.elapsedWaitMs = duration(mergedWaits);
    if (result.unknownEndCount || result.invalidIntervalCount) result.coverage = 'partial';
    const days = new Map<string, { date: string; busyMs: number; waitMs: number }>();
    const cells = new Map<string, { weekday: number; hour: number; busyMs: number; waitMs: number }>();
    const projectCalendar = (segments: readonly UsageWorkIntervalSegment[], metric: 'busyMs' | 'waitMs') => {
        for (const segment of segments) {
            for (let start = segment.startMs; start < segment.endMs;) {
                const calendar = resolveUsageCalendarInstant(start, input.timeZoneOffsetMinutes);
                const end = Math.min(segment.endMs, resolveUsageBucketBounds('hour', start, input.timeZoneOffsetMinutes).bucketEndMs);
                const spanMs = end - start;
                const day = days.get(calendar.date) ?? { date: calendar.date, busyMs: 0, waitMs: 0 };
                day[metric] += spanMs;
                days.set(calendar.date, day);
                const key = `${calendar.weekday}:${calendar.hour}`;
                const cell = cells.get(key) ?? { weekday: calendar.weekday, hour: calendar.hour, busyMs: 0, waitMs: 0 };
                cell[metric] += spanMs;
                cells.set(key, cell);
                if (metric === 'busyMs' && result.night && isUsageNightHour(calendar.hour, result.night)) result.night.busyMs += spanMs;
                start = end;
            }
        }
    };
    projectCalendar(mergedBusy, 'busyMs');
    projectCalendar(mergedWaits, 'waitMs');
    result.calendarDays = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    result.weekdayHourBuckets = [...cells.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
    if (result.night && input.activityAtMs !== undefined) result.night.activityCount = input.activityAtMs.filter(instant =>
        Number.isFinite(instant) && instant >= input.period.startMs && instant < input.period.endMs
        && isUsageNightHour(resolveUsageCalendarInstant(instant, input.timeZoneOffsetMinutes).hour, result.night!)).length;
    return result;
}
