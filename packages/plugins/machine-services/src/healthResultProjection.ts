import { HealthCheckResultV1ProtocolSchema, HealthCheckSubjectV1ProtocolSchema, computeCanonicalDomainSeparatedDigest,
    createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import type { AccountKvListItem, AccountKvService } from '@happier-dev/plugin-sdk/storage';
export { HEALTH_REMOVE_ACTION_REF, HEALTH_RESULTS_ACTION_ID, HEALTH_RESULTS_ACTION_REF } from './actionIds.js';
export { savedHealthRemovalResultSchema } from './healthRemoval.js';
export { runSavedHealthCheck, type SavedHealthCheckRunInput } from './savedHealthCheckRun.js';
import { createProtocolStoredReadSchema, defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion,
    ProtocolAutomationTriggerRevisionV1Schema } from '@happier-dev/plugin-sdk/protocol';

/** A presentation of the observer's retained checkpoint, inside the existing encrypted Account KV row. */
export const HEALTH_RESULT_CHECKPOINT_PREFIX = 'health:';
export function healthResultCheckpointKey(sourceInstanceId: string): string {
    return `${HEALTH_RESULT_CHECKPOINT_PREFIX}${computeCanonicalDomainSeparatedDigest('happier.health.status.v1', [sourceInstanceId])}`;
}
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
        history: historySchema.optional(), recentResults: defineProtocolArray(HealthCheckResultV1ProtocolSchema).optional(),
        recentResultsCoverage: defineProtocolUnion([defineProtocolLiteral('complete'), defineProtocolLiteral('partial')]).optional(),
        recentResultsOmittedThrough: count.optional(), failingSince: count.nullable().optional(), failureStreak: count.optional(),
    }, { policy: 'closed' })),
}, { policy: 'closed' });
export type HealthResultProjection = ReturnType<typeof healthResultProjectionSchema.parse>;
export const healthResultProjectionStoredSchema = createProtocolStoredReadSchema(healthResultProjectionSchema);

export const healthResultSourceSchema = defineProtocolObject({ sourceInstanceId: defineProtocolString({ minLength: 1 }),
    subject: HealthCheckSubjectV1ProtocolSchema }, { policy: 'closed' });
const healthResultSourceStoredSchema = createProtocolStoredReadSchema(healthResultSourceSchema);

export const healthResultProjectionPageSchema = defineProtocolObject({
    items: defineProtocolArray(defineProtocolObject({ key: defineProtocolString(), source: healthResultSourceSchema.optional(), projection: healthResultProjectionSchema }, { policy: 'closed' })),
    nextCursor: defineProtocolString().optional(),
}, { policy: 'closed' });
export type HealthResultProjectionPage = ReturnType<typeof healthResultProjectionPageSchema.parse>;
type HealthResultProjectionItem = HealthResultProjectionPage['items'][number];

function projectHealthResultCheckpoint(row: AccountKvListItem, at: number): HealthResultProjectionItem | null {
    if ('deleted' in row || row.value === null || typeof row.value !== 'object' || !('current' in row.value)) return null;
    const parsed = healthResultProjectionStoredSchema.safeParse(row.value.current);
    if (!parsed.success) return null;
    const source = 'source' in row.value ? healthResultSourceStoredSchema.safeParse(row.value.source) : undefined;
    return { key: row.key, ...(source?.success ? { source: source.data } : {}), projection: healthResultProjectionAt(parsed.data, at) };
}

/** An Environment reader opens only its exact checkpoints from one Account storage snapshot. */
export async function readHealthResultProjectionsForSources(kv: Pick<AccountKvService, 'transaction'>,
    sourceIds: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, HealthResultProjectionItem>> {
    return kv.transaction(async snapshot => {
        const at = Date.now();
        const entries = await Promise.all(sourceIds.map(async id => {
            const key = healthResultCheckpointKey(id);
            const row = await snapshot.get(key, { signal });
            const result = row && projectHealthResultCheckpoint({ key, ...row }, at);
            return result ? [[id, result] as const] : [];
        }));
        return new Map(entries.flat());
    }, { signal });
}

/** One native Account KV page, shared by retained UI reads and the public Action. No probe or write. */
export async function readHealthResultProjections(kv: Pick<AccountKvService, 'list'>,
    options: Readonly<{ signal: AbortSignal; cursor?: string }>): Promise<HealthResultProjectionPage> {
    const page = await kv.list({ prefix: HEALTH_RESULT_CHECKPOINT_PREFIX,
        ...(options.cursor ? { cursor: options.cursor } : {}), signal: options.signal });
    options.signal.throwIfAborted();
    const items: HealthResultProjectionItem[] = [];
    const at = Date.now();
    for (const row of page.items) {
        const item = projectHealthResultCheckpoint(row, at);
        if (item) items.push(item);
    }
    return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

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
    if (previous && result.observedAt <= (history?.lastObservedAt ?? previous.result.observedAt)) return { ...previous, checkId, result };
    const dayStartAt = Math.floor(result.observedAt / DAY_MS) * DAY_MS;
    const days = history ? windowHistory(history, result.observedAt).days : [];
    const last = days.at(-1);
    const day = last?.dayStartAt === dayStartAt ? { ...last }
        : { dayStartAt, up: 0, down: 0, degraded: 0, unknown: 0, uptimePercent: null };
    day[result.status] += 1;
    day.uptimePercent = uptime(day.up, day.down, day.degraded);
    if (last?.dayStartAt === dayStartAt) days[days.length - 1] = day;
    else days.push(day);
    const failed = result.status === 'down' || result.status === 'degraded';
    const failedBefore = previous?.result.status === 'down' || previous?.result.status === 'degraded';
    const retained = windowRecentResults({ recentResults: [...(previous?.recentResults ?? (previous ? [previous.result] : [])), result],
        recentResultsOmittedThrough: previous?.recentResults === undefined ? previous?.result.observedAt
            : previous.recentResultsOmittedThrough }, result.observedAt);
    return { checkId, result, history: windowHistory({ lastObservedAt: result.observedAt, days, uptimePercent: null }, result.observedAt),
        ...retained, failingSince: failed ? failedBefore ? previous?.failingSince ?? previous!.result.observedAt : result.observedAt : null,
        failureStreak: failed ? failedBefore ? (previous?.failureStreak ?? 1) + 1 : 1 : 0 };
}

function windowRecentResults(check: Pick<HealthResultProjection['checks'][number], 'recentResults' | 'recentResultsOmittedThrough'>, at: number) {
    const start = Math.floor(at / DAY_MS) * DAY_MS - (HISTORY_DAYS - 1) * DAY_MS;
    const omitted = check.recentResultsOmittedThrough;
    return { ...(check.recentResults === undefined ? {} : {
        recentResults: check.recentResults.filter(result => result.observedAt >= start && result.observedAt <= at),
        recentResultsCoverage: omitted !== undefined && omitted >= start ? 'partial' as const : 'complete' as const }),
        ...(omitted !== undefined && omitted >= start ? { recentResultsOmittedThrough: omitted } : {}) };
}

function uptime(up: number, down: number, degraded: number) {
    return up + down + degraded > 0 ? 100 * up / (up + down + degraded) : null;
}

function windowHistory(history: NonNullable<HealthResultProjection['checks'][number]['history']>, at: number) {
    const dayStartAt = Math.floor(at / DAY_MS) * DAY_MS;
    const days = history.days.filter(day => day.dayStartAt >= dayStartAt - (HISTORY_DAYS - 1) * DAY_MS && day.dayStartAt <= dayStartAt)
        .map(day => {
            const uptimePercent = uptime(day.up, day.down, day.degraded);
            return uptimePercent === day.uptimePercent ? day : { ...day, uptimePercent };
        });
    const totals = days.reduce((sum, value) => ({ up: sum.up + value.up, down: sum.down + value.down,
        degraded: sum.degraded + value.degraded }), { up: 0, down: 0, degraded: 0 });
    return { ...history, days, uptimePercent: uptime(totals.up, totals.down, totals.degraded) };
}

type RetainedResult = HealthResultProjection['checks'][number]['result'];

function projectRetainedResponseTime(result: RetainedResult): RetainedResult {
    const cause = result.cause;
    if (result.latencyMs === undefined || cause?.httpStatus !== undefined || cause?.kind !== 'http') return result;
    // Older observers recorded elapsed probe time even when HTTP never answered.
    const { latencyMs: _elapsed, ...observation } = result;
    return observation;
}

/** Reads expire old buckets too, even when the observer is disconnected. No
 * clock extrapolation fills the unobserved portion of the window. */
export function healthResultProjectionAt(value: HealthResultProjection, at: number): HealthResultProjection {
    return { ...value, checks: value.checks.map(check => {
        const recent = windowRecentResults(check, at);
        return { ...check, ...recent, result: projectRetainedResponseTime(check.result),
            ...(recent.recentResults ? { recentResults: recent.recentResults.map(projectRetainedResponseTime) } : {}),
            ...(check.history ? { history: windowHistory(check.history, at) } : {}) };
    }) };
}
