import { HealthCheckResultV1ProtocolSchema, createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString,
    ProtocolAutomationTriggerRevisionV1Schema } from '@happier-dev/plugin-sdk/protocol';

/** A presentation of the observer's retained checkpoint, inside the existing encrypted Account KV row. */
export const HEALTH_RESULT_CHECKPOINT_PREFIX = 'health:';
const count = defineProtocolNumber({ integer: true, minimum: 0 });
const percent = defineProtocolNumber({ minimum: 0, maximum: 100 }).nullable();
const daySchema = defineProtocolObject({ dayStartAt: count, up: count, down: count,
    degraded: count, unknown: count, uptimePercent: percent }, { policy: 'closed' });
const historySchema = defineProtocolObject({ lastObservedAt: count,
    days: defineProtocolArray(daySchema), uptimePercent: percent }, { policy: 'closed' });
// Product window: today and the preceding 29 UTC calendar days. No raw probes.
const HISTORY_DAYS = 30;
const DAY_MS = 86_400_000;
export const healthResultProjectionSchema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    members: defineProtocolArray(defineProtocolObject({ automationId: defineProtocolString(), triggerId: defineProtocolString(),
        triggerRevision: ProtocolAutomationTriggerRevisionV1Schema, sourceSelectorId: defineProtocolString(),
    }, { policy: 'closed' })),
    checks: defineProtocolArray(defineProtocolObject({ checkId: defineProtocolString(), result: HealthCheckResultV1ProtocolSchema,
        history: historySchema.optional() }, { policy: 'closed' })),
}, { policy: 'closed' });
export type HealthResultProjection = ReturnType<typeof healthResultProjectionSchema.parse>;

/** Observation clocks and latency are request freshness, not a changed health condition. */
export function healthResultProjectionIdentity(value: HealthResultProjection): string {
    return createCanonicalJsonSigningInput({ ...value, checks: value.checks.map(({ checkId, result, ...retained }) => {
        const { observedAt: _clock, latencyMs: _latency, ...condition } = result;
        return { ...retained, checkId, result: condition };
    }) });
}

/** Sample availability, not inferred wall-clock duration. Unknown samples and
 * missing days never count as up or down. The existing probe is the only writer. */
export function retainHealthResult(previous: HealthResultProjection['checks'][number] | undefined,
    checkId: string, result: HealthResultProjection['checks'][number]['result']): HealthResultProjection['checks'][number] {
    const history = previous?.history;
    // Re-adoption and monitor wakes may return the same retained observation.
    if (history && result.observedAt <= history.lastObservedAt) return { checkId, result, history };
    const dayStartAt = Math.floor(result.observedAt / DAY_MS) * DAY_MS;
    const days = history ? windowHistory(history, result.observedAt).days : [];
    const last = days.at(-1);
    const day = last?.dayStartAt === dayStartAt ? { ...last }
        : { dayStartAt, up: 0, down: 0, degraded: 0, unknown: 0, uptimePercent: null };
    day[result.status] += 1;
    day.uptimePercent = uptime(day.up, day.down, day.degraded);
    if (last?.dayStartAt === dayStartAt) days[days.length - 1] = day;
    else days.push(day);
    return { checkId, result, history: windowHistory({ lastObservedAt: result.observedAt, days, uptimePercent: null }, result.observedAt) };
}

function uptime(up: number, down: number, degraded: number) {
    return up + down + degraded > 0 ? 100 * up / (up + down + degraded) : null;
}

function windowHistory(history: NonNullable<HealthResultProjection['checks'][number]['history']>, at: number) {
    const dayStartAt = Math.floor(at / DAY_MS) * DAY_MS;
    const days = history.days.filter(day => day.dayStartAt >= dayStartAt - (HISTORY_DAYS - 1) * DAY_MS && day.dayStartAt <= dayStartAt);
    const totals = days.reduce((sum, value) => ({ up: sum.up + value.up, down: sum.down + value.down,
        degraded: sum.degraded + value.degraded }), { up: 0, down: 0, degraded: 0 });
    return { ...history, days, uptimePercent: uptime(totals.up, totals.down, totals.degraded) };
}

/** Reads expire old buckets too, even when the observer is disconnected. No
 * clock extrapolation fills the unobserved portion of the window. */
export function healthResultProjectionAt(value: HealthResultProjection, at: number): HealthResultProjection {
    return { ...value, checks: value.checks.map(check => check.history
        ? { ...check, history: windowHistory(check.history, at) } : check) };
}
