import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createUsageFixedBucketResolver, resolveUsageCalendarInstant } from './usageCalendar.js';
import { mergeUsageWorkIntervalSegments, type UsageClosedTurnFact, type UsageWorkIntervalFact,
    type UsageWorkIntervalsProjection, type UsageWorkPermissionFact } from './usageWorkIntervals.js';
import type { UsageAcceptedInputFact } from './resolveUsageHowYouWork.js';

const Count = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const Duration = lazyZodSchema(() => z.number().check(z.nonnegative()));
const Clients = lazyZodSchema(() => z.strictObject({ ios: Count, android: Count, web: Count, desktop: Count, unknown: Count }));
const Measures = lazyZodSchema(() => z.strictObject({
    steeringCount: z.nullable(Count), followUpCount: z.nullable(Count), newTurnCount: z.nullable(Count),
    permissionAnswerCount: z.nullable(Count), pairedDecisionCount: z.nullable(Count), decisionLatencyMs: z.nullable(Duration),
    busyMs: z.nullable(Duration), observedWaitMs: z.nullable(Duration), steersPerBusyHour: z.nullable(Duration),
    byAnsweringClient: Clients,
}));
export const UsageSteeringSummarySchema = lazyZodSchema(() => z.strictObject({
    coverage: z.enum(['complete_for_supplied_facts', 'partial']),
    inputsObserved: z.boolean(), permissionsObserved: z.boolean(), busyObserved: z.boolean(),
    byAgent: z.array(z.strictObject({ agentId: z.nullable(z.string()), ...Measures.shape })),
    hourly: z.array(z.strictObject({ agentId: z.nullable(z.string()), date: z.string(),
        weekday: z.number().check(z.int(), z.minimum(0), z.maximum(6)),
        hour: z.number().check(z.int(), z.minimum(0), z.maximum(23)), ...Measures.shape })),
}));
export type UsageSteeringSummary = z.infer<typeof UsageSteeringSummarySchema>;
type Measures = z.infer<typeof Measures>;

type SteeringInput = Readonly<{
    period: Readonly<{ startMs: number; endMs: number }>; timeZoneOffsetMinutes: number;
    coverage: UsageSteeringSummary['coverage']; acceptedInputs?: readonly UsageAcceptedInputFact[];
    permissions?: Readonly<{ requests: readonly UsageWorkPermissionFact[]; paired: readonly UsageWorkPermissionFact[] }>;
    facts?: readonly UsageWorkIntervalFact[]; closedTurns?: readonly UsageClosedTurnFact[];
    intervals: UsageWorkIntervalsProjection | null;
}>;
export type UsageSteeringHour = Pick<ReturnType<typeof resolveUsageCalendarInstant>, 'date' | 'weekday' | 'hour'> & { bucketStartMs: number };
export type PreparedUsageSteeringEvidence = Readonly<{
    identities: readonly Readonly<{ source: UsageWorkIntervalFact | UsageClosedTurnFact; workId: string; agentId: string | null }>[];
    hours: ReadonlyMap<number, UsageSteeringHour>;
}>;
export function createUsageSteeringHourResolver(period: SteeringInput['period'], timeZoneOffsetMinutes: number) {
    const boundsAt = createUsageFixedBucketResolver('hour', period.startMs, timeZoneOffsetMinutes);
    const hours = new Map<number, UsageSteeringHour>();
    return (instant: number): UsageSteeringHour => {
        const bucketStartMs = boundsAt(instant).bucketStartMs;
        let value = hours.get(bucketStartMs);
        if (!value) {
            const { date, weekday, hour } = resolveUsageCalendarInstant(bucketStartMs, timeZoneOffsetMinutes);
            value = { bucketStartMs, date, weekday, hour };
            hours.set(bucketStartMs, value);
        }
        return value;
    };
}
/** Calendar placement and work attribution inputs are prepared once per opened source. */
export function prepareUsageSteeringEvidence(input: Pick<SteeringInput, 'facts' | 'closedTurns' | 'acceptedInputs' | 'permissions'>,
    hourAt: (instant: number) => UsageSteeringHour): PreparedUsageSteeringEvidence {
    const identities = [...(input.facts ?? []).filter(row => row.kind === 'busy'), ...input.closedTurns ?? []]
        .map(source => ({ source, workId: source.workId, agentId: source.agentId }));
    const hours = new Map<number, UsageSteeringHour>();
    for (const fact of input.acceptedInputs ?? []) hours.set(fact.acceptedAtMs, hourAt(fact.acceptedAtMs));
    for (const fact of input.permissions?.requests ?? []) {
        if (fact.decidedAtMs !== null) hours.set(fact.decidedAtMs, hourAt(fact.decidedAtMs));
    }
    return { identities, hours };
}

/** Selected input/permission populations are supplied by the existing Human-loop reducer. */
export function projectUsageSteering(input: SteeringInput): UsageSteeringSummary {
    const hourAt = createUsageSteeringHourResolver(input.period, input.timeZoneOffsetMinutes);
    // Requests without an in-period answer never produce an intervention cell.
    const requests = input.permissions?.requests.filter(fact => fact.decidedAtMs !== null
        && Number.isSafeInteger(fact.decidedAtMs) && fact.decidedAtMs >= input.period.startMs && fact.decidedAtMs < input.period.endMs);
    return projectPreparedUsageSteering(input, prepareUsageSteeringEvidence({ ...input,
        permissions: input.permissions ? { ...input.permissions, requests: requests! } : undefined }, hourAt));
}
export function projectPreparedUsageSteering(input: SteeringInput, prepared: PreparedUsageSteeringEvidence): UsageSteeringSummary {
    const identities = new Map<string, string | null>();
    for (const fact of prepared.identities) {
        identities.set(fact.workId, identities.has(fact.workId) && identities.get(fact.workId) !== fact.agentId ? null : fact.agentId);
    }
    const empty = (): Measures => ({ steeringCount: input.acceptedInputs === undefined ? null : 0,
        followUpCount: input.acceptedInputs === undefined ? null : 0, newTurnCount: input.acceptedInputs === undefined ? null : 0,
        permissionAnswerCount: input.permissions === undefined ? null : 0, pairedDecisionCount: input.permissions === undefined ? null : 0,
        decisionLatencyMs: null, busyMs: null, observedWaitMs: null, steersPerBusyHour: null,
        byAnsweringClient: { ios: 0, android: 0, web: 0, desktop: 0, unknown: 0 } });
    const agents = new Map<string | null, UsageSteeringSummary['byAgent'][number]>();
    const hours = new Map<string, UsageSteeringSummary['hourly'][number]>();
    const hourBoundsAt = createUsageFixedBucketResolver('hour', input.period.startMs, input.timeZoneOffsetMinutes);
    const resolveHour = createUsageSteeringHourResolver(input.period, input.timeZoneOffsetMinutes);
    const agent = (agentId: string | null) => {
        let row = agents.get(agentId);
        if (!row) { row = { agentId, ...empty() }; agents.set(agentId, row); }
        return row;
    };
    const hour = (agentId: string | null, instant: number) => {
        const calendar = prepared.hours.get(instant) ?? resolveHour(instant);
        const { bucketStartMs } = calendar;
        const key = JSON.stringify([agentId, bucketStartMs]);
        let row = hours.get(key);
        if (!row) {
            const { date, weekday, hour } = calendar;
            row = { agentId, date, weekday, hour, ...empty() };
            hours.set(key, row);
        }
        return row;
    };
    const inPeriod = (time: number) => Number.isSafeInteger(time) && time >= input.period.startMs && time < input.period.endMs;
    for (const accepted of input.acceptedInputs ?? []) {
        const agentId = identities.get(accepted.workId) ?? null;
        const field = accepted.deliveryKind === 'steer' ? 'steeringCount' : accepted.deliveryKind === 'followUp' ? 'followUpCount' : 'newTurnCount';
        for (const row of [agent(agentId), hour(agentId, accepted.acceptedAtMs)]) row[field] = (row[field] ?? 0) + 1;
    }
    const paired = new Set(input.permissions?.paired);
    const pairedIds = new Set(input.permissions?.paired.map(row => JSON.stringify([row.workId, row.requestId])));
    for (const permission of input.permissions?.requests ?? []) {
        if (permission.decidedAtMs === null || !inPeriod(permission.decidedAtMs)) continue;
        const agentId = identities.get(permission.workId) ?? null;
        for (const row of [agent(agentId), hour(agentId, permission.decidedAtMs)]) {
            row.permissionAnswerCount = (row.permissionAnswerCount ?? 0) + 1;
            row.byAnsweringClient[permission.answeringClientCategory ?? 'unknown']++;
            if (paired.has(permission) && permission.requestedAtMs !== null) {
                row.pairedDecisionCount = (row.pairedDecisionCount ?? 0) + 1;
                row.decisionLatencyMs = (row.decisionLatencyMs ?? 0) + permission.decidedAtMs - permission.requestedAtMs;
            }
        }
    }
    for (const lane of input.intervals?.lanes ?? []) {
        const agentId = identities.get(lane.workId) ?? null;
        const durations = (spans: readonly { startMs: number; endMs: number }[], field: 'busyMs' | 'observedWaitMs') => {
            const row = agent(agentId);
            row[field] = (row[field] ?? 0) + spans.reduce((sum, span) => sum + span.endMs - span.startMs, 0);
            for (const span of spans) for (let cursor = span.startMs; cursor < span.endMs;) {
                const end = Math.min(span.endMs, hourBoundsAt(cursor).bucketEndMs);
                const cell = hour(agentId, cursor);
                cell[field] = (cell[field] ?? 0) + end - cursor;
                cursor = end;
            }
        };
        durations(lane.busy, 'busyMs');
        durations(mergeUsageWorkIntervalSegments(lane.waits.filter(wait => pairedIds.has(JSON.stringify([lane.workId, wait.evidenceId])))), 'observedWaitMs');
    }
    const compare = (a: { agentId: string | null }, b: { agentId: string | null }) => (a.agentId ?? '').localeCompare(b.agentId ?? '');
    const byAgent = [...agents.values()].sort(compare);
    const hourly = [...hours.values()].sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour || compare(a, b));
    for (const row of [...byAgent, ...hourly]) {
        row.steersPerBusyHour = row.steeringCount !== null && row.busyMs !== null && row.busyMs > 0
            ? row.steeringCount / (row.busyMs / 3_600_000) : null;
    }
    return { coverage: input.coverage, inputsObserved: input.acceptedInputs !== undefined,
        permissionsObserved: input.permissions !== undefined, busyObserved: input.intervals !== null, byAgent, hourly };
}
