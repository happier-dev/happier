import { resolveUsageCalendarInstant } from './usageCalendar.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { SessionTurnV1 } from '../sessions/turns/sessionTurnV1.js';

/** Exact turn lifecycle observations; neither Session age nor clipped busy spans are run lengths. */
export interface UsageClosedTurnFact {
    workId: string;
    agentId: string | null;
    status: SessionTurnV1['status'];
    startMs: number;
    endMs: number | null;
}

const RunCountSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const RunDurationSchema = lazyZodSchema(() => z.number().check(z.nonnegative()));
export const UsageRunLengthSummarySchema = lazyZodSchema(() => z.strictObject({
    method: z.literal('closed_turn_wall_v1'),
    coverage: z.enum(['complete_for_supplied_facts', 'partial']),
    sampleCount: RunCountSchema, openCount: RunCountSchema, croppedCount: RunCountSchema, invalidCount: RunCountSchema,
    byAgent: z.array(z.strictObject({ agentId: z.nullable(z.string()), sampleCount: RunCountSchema,
        medianMs: RunDurationSchema, p90Ms: RunDurationSchema, durationsMs: z.array(RunDurationSchema) })),
}));
export type UsageRunLengthSummary = z.infer<typeof UsageRunLengthSummarySchema>;

export interface UsageRunLengthObservation {
    agentId: string | null;
    durationMs: number;
}
export type UsageRunLengthObservationSummary = Pick<UsageRunLengthSummary, 'sampleCount' | 'byAgent'>;

/** Aggregate admitted duration samples without lifecycle identities or private chronology.
 * Equal values remain distinct observations; no sample deduplication is possible here.
 */
export function summarizeUsageRunLengthObservations(
    observations: readonly UsageRunLengthObservation[],
): UsageRunLengthObservationSummary {
    const agents = new Map<string | null, number[]>();
    for (const observation of observations) {
        if (!Number.isFinite(observation.durationMs) || observation.durationMs < 0) {
            throw new RangeError('Invalid usage run-length duration');
        }
        const durations = agents.get(observation.agentId) ?? [];
        durations.push(observation.durationMs);
        agents.set(observation.agentId, durations);
    }
    const byAgent = [...agents].sort(([left], [right]) => left === right ? 0 : left === null ? -1 : right === null ? 1
        : left < right ? -1 : 1).map(([agentId, durationsMs]) => {
        durationsMs.sort((a, b) => a - b);
        const sampleCount = durationsMs.length;
        const middle = Math.floor(sampleCount / 2);
        return { agentId, sampleCount, durationsMs,
            medianMs: sampleCount % 2 ? durationsMs[middle]!
                : durationsMs[middle - 1]! + (durationsMs[middle]! - durationsMs[middle - 1]!) / 2,
            // Empirical nearest rank: no interpolation manufactures a duration observation.
            p90Ms: durationsMs[Math.ceil(sampleCount * 0.9) - 1]!,
        };
    });
    return { sampleCount: observations.length, byAgent };
}

/** Actual observations in deterministic Agent/duration order, independent of private chronology. */
export function projectUsageClosedTurns(input: Readonly<{
    period: Readonly<{ startMs: number; endMs: number }>;
    facts: readonly UsageClosedTurnFact[];
    coverage: UsageRunLengthSummary['coverage'];
}>): UsageRunLengthSummary {
    const result: UsageRunLengthSummary = { method: 'closed_turn_wall_v1', coverage: input.coverage,
        sampleCount: 0, openCount: 0, croppedCount: 0, invalidCount: 0, byAgent: [] };
    const unique = new Map<string, UsageClosedTurnFact>();
    const conflicts = new Set<string>();
    for (const fact of input.facts) {
        const previous = unique.get(fact.workId);
        if (previous && (previous.startMs !== fact.startMs || previous.endMs !== fact.endMs
            || previous.agentId !== fact.agentId || previous.status !== fact.status)) conflicts.add(fact.workId);
        unique.set(fact.workId, fact);
    }
    const observations: UsageRunLengthObservation[] = [];
    for (const fact of unique.values()) {
        if (conflicts.has(fact.workId) || !Number.isSafeInteger(fact.startMs) || fact.startMs < 0
            || fact.endMs !== null && (!Number.isSafeInteger(fact.endMs) || fact.endMs < fact.startMs)) {
            result.invalidCount++;
            continue;
        }
        if (fact.startMs >= input.period.endMs || fact.endMs !== null && fact.endMs <= input.period.startMs
            && fact.startMs < input.period.startMs) continue;
        if (fact.endMs === null || fact.status === 'in_progress' || fact.status === 'waiting') {
            result.openCount++;
            continue;
        }
        if (fact.startMs < input.period.startMs || fact.endMs > input.period.endMs) {
            result.croppedCount++;
            continue;
        }
        observations.push({ agentId: fact.agentId, durationMs: fact.endMs - fact.startMs });
    }
    const summary = summarizeUsageRunLengthObservations(observations);
    result.sampleCount = summary.sampleCount;
    result.byAgent = summary.byAgent;
    if (result.openCount || result.croppedCount || result.invalidCount) result.coverage = 'partial';
    return result;
}

export const UsageNightHoursV1Schema = lazyZodSchema(() => z.strictObject({ startHour: z.number().check(z.int(), z.minimum(0), z.maximum(23)), endHour: z.number().check(z.int(), z.minimum(0), z.maximum(23)) }).check(z.refine(value => value.startHour !== value.endHour)));

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

/** One population for Human loop and Coach: decisions belong to their answer period, including zero waits. */
export function selectUsageWorkPermissions<T extends UsageWorkPermissionFact>(
    facts: readonly T[], period: Readonly<{ startMs: number; endMs: number }>, asOfMs?: number | null,
): Readonly<{ requests: readonly T[]; paired: readonly T[] }> {
    const inPeriod = (time: number) => Number.isSafeInteger(time) && time >= period.startMs && time < period.endMs
        && (asOfMs == null || time <= asOfMs);
    const seen = new Set<string>();
    const requests = facts.filter(fact => {
        const key = JSON.stringify([fact.workId, fact.requestId]);
        if (seen.has(key)) return false;
        seen.add(key);
        return fact.requestedAtMs !== null && inPeriod(fact.requestedAtMs)
            || fact.decidedAtMs !== null && inPeriod(fact.decidedAtMs);
    });
    const paired = requests.filter(fact => fact.requestedAtMs !== null && Number.isSafeInteger(fact.requestedAtMs)
        && fact.decidedAtMs !== null && inPeriod(fact.decidedAtMs) && fact.decidedAtMs >= fact.requestedAtMs);
    return { requests, paired };
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

type IntervalProjectionCache = {
    withoutActivity: Map<string, UsageWorkIntervalsProjection>;
    withActivity: WeakMap<readonly number[], Map<string, UsageWorkIntervalsProjection>>;
};

// Facts and activity arrays are immutable snapshots. Their identity owns the lifetime of these projections.
const intervalProjections = new WeakMap<readonly UsageWorkIntervalFact[], IntervalProjectionCache>();

const SpanSchema = lazyZodSchema(() => z.strictObject({ startMs: z.number().check(z.int()), endMs: z.number().check(z.int()) }));
const DurationSchema = lazyZodSchema(() => z.number().check(z.nonnegative()));
export const UsageWorkIntervalsProjectionSchema = lazyZodSchema(() => z.strictObject({
    method: z.literal('witnessed_intervals_v1'), period: SpanSchema,
    timeZoneOffsetMinutes: z.number().check(z.int(), z.minimum(-840), z.maximum(840)),
    coverage: z.enum(['complete_for_supplied_facts', 'partial']),
    unknownEndCount: z.number().check(z.int(), z.nonnegative()), invalidIntervalCount: z.number().check(z.int(), z.nonnegative()),
    agentTimeMs: DurationSchema, elapsedBusyMs: DurationSchema, elapsedWaitMs: DurationSchema,
    parallelBusyMs: DurationSchema, maxParallel: z.number().check(z.int(), z.nonnegative()),
    lanes: z.array(z.strictObject({
        workId: z.string().check(z.minLength(1)), agentId: z.nullable(z.string()), machineId: z.nullable(z.string()), parentWorkId: z.nullable(z.string()),
        busy: z.array(SpanSchema), waits: z.array((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SpanSchema, {
            kind: z.enum(['permission_wait', 'user_wait', 'child_wait']), evidenceId: z.string().check(z.minLength(1)),
        }))),
    })),
    calendarDays: z.array(z.strictObject({ date: z.string(), busyMs: DurationSchema, waitMs: DurationSchema })),
    weekdayHourBuckets: z.array(z.strictObject({ weekday: z.number().check(z.int(), z.minimum(0), z.maximum(6)), hour: z.number().check(z.int(), z.minimum(0), z.maximum(23)),
        busyMs: DurationSchema, waitMs: DurationSchema })),
    night: z.nullable((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(UsageNightHoursV1Schema, {
        busyMs: DurationSchema, activityCount: z.nullable(z.number().check(z.int(), z.nonnegative())) }))),
}));

export function mergeUsageWorkIntervalSegments(values: readonly UsageWorkIntervalSegment[]): UsageWorkIntervalSegment[] {
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
    const mergedWaits = mergeUsageWorkIntervalSegments(waits);
    for (const interval of mergeUsageWorkIntervalSegments(busy)) {
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

/** Half-open lane spans share one boundary sweep for period and calendar peaks. */
export function summarizeUsageConcurrency(segments: readonly UsageWorkIntervalSegment[]): { maxParallel: number; parallelBusyMs: number; peakAtMs: number | null } {
    const boundaries = new Map<number, number>();
    for (const span of segments) {
        boundaries.set(span.startMs, (boundaries.get(span.startMs) ?? 0) + 1);
        boundaries.set(span.endMs, (boundaries.get(span.endMs) ?? 0) - 1);
    }
    let active = 0;
    let previous: number | null = null;
    let maxParallel = 0;
    let parallelBusyMs = 0;
    let peakAtMs: number | null = null;
    for (const [instant, change] of [...boundaries.entries()].sort((a, b) => a[0] - b[0])) {
        if (previous !== null && active > 1) parallelBusyMs += instant - previous;
        active += change;
        if (active > maxParallel) { maxParallel = active; peakAtMs = instant; }
        previous = instant;
    }
    return { maxParallel, parallelBusyMs, peakAtMs };
}

export function projectUsageWorkIntervals(input: UsageWorkIntervalsInput): UsageWorkIntervalsProjection {
    if (!Number.isSafeInteger(input.period.startMs) || !Number.isSafeInteger(input.period.endMs)
        || input.period.endMs < input.period.startMs || !Number.isInteger(input.timeZoneOffsetMinutes)
        || Math.abs(input.timeZoneOffsetMinutes) > 840) throw new RangeError('Invalid usage interval period or offset');
    if (input.nightHours && !UsageNightHoursV1Schema.safeParse(input.nightHours).success) throw new RangeError('Invalid usage night hours');
    let byFacts = intervalProjections.get(input.facts);
    if (!byFacts) {
        byFacts = { withoutActivity: new Map(), withActivity: new WeakMap() };
        intervalProjections.set(input.facts, byFacts);
    }
    let byOptions = input.activityAtMs === undefined ? byFacts.withoutActivity : byFacts.withActivity.get(input.activityAtMs);
    if (!byOptions) {
        byOptions = new Map();
        if (input.activityAtMs !== undefined) byFacts.withActivity.set(input.activityAtMs, byOptions);
    }
    const optionsKey = JSON.stringify([input.period.startMs, input.period.endMs, input.timeZoneOffsetMinutes,
        input.nightHours?.startHour ?? null, input.nightHours?.endHour ?? null]);
    const cached = byOptions.get(optionsKey);
    if (cached) return cached;
    const result = computeUsageWorkIntervals(input);
    byOptions.set(optionsKey, result);
    return result;
}

function computeUsageWorkIntervals(input: UsageWorkIntervalsInput): UsageWorkIntervalsProjection {
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
    for (const lane of result.lanes) {
        lane.busy = subtractSegments(lane.busy, [...lane.waits, ...uncertainWaits.get(lane.workId) ?? []]);
        lane.waits.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.evidenceId.localeCompare(b.evidenceId));
        result.agentTimeMs += duration(lane.busy);
        busy.push(...lane.busy);
        waits.push(...lane.waits);
    }
    const concurrency = summarizeUsageConcurrency(busy);
    result.maxParallel = concurrency.maxParallel;
    result.parallelBusyMs = concurrency.parallelBusyMs;
    const mergedBusy = mergeUsageWorkIntervalSegments(busy);
    const mergedWaits = mergeUsageWorkIntervalSegments(waits);
    result.elapsedBusyMs = duration(mergedBusy);
    result.elapsedWaitMs = duration(mergedWaits);
    if (result.unknownEndCount || result.invalidIntervalCount) result.coverage = 'partial';
    const days = new Map<string, { date: string; busyMs: number; waitMs: number }>();
    const cells = new Map<string, { weekday: number; hour: number; busyMs: number; waitMs: number }>();
    const calendarByInstant = new Map<number, ReturnType<typeof resolveUsageCalendarInstant>>();
    const calendarAt = (instant: number) => {
        let calendar = calendarByInstant.get(instant);
        if (!calendar) {
            calendar = resolveUsageCalendarInstant(instant, input.timeZoneOffsetMinutes);
            calendarByInstant.set(instant, calendar);
        }
        return calendar;
    };
    const projectCalendar = (segments: readonly UsageWorkIntervalSegment[], metric: 'busyMs' | 'waitMs') => {
        for (const segment of segments) {
            for (let start = segment.startMs; start < segment.endMs;) {
                const calendar = calendarAt(start);
                const end = Math.min(segment.endMs, calendar.bucketStartMs + (calendar.hour + 1) * 3_600_000);
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
        && isUsageNightHour(calendarAt(instant).hour, result.night!)).length;
    return result;
}
