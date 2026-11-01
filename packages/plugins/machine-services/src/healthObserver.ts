import { HealthCheckResultV1ProtocolSchema, HealthCheckSourceConfigV1ProtocolSchema,
    HealthCheckSubjectV1ProtocolSchema, SavedHealthCheckSelectorV1ProtocolSchema, HEALTH_CHECK_KINDS_V1,
    computeCanonicalDomainSeparatedDigest, createCanonicalJsonSigningInput, arePluginMachineMaterializationRefsEqual,
    type HealthCheckSourceConfigV1, type HealthCheckResultV1, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
    defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { requireAccountStorage } from '@happier-dev/plugin-sdk/storage';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext,
    type PluginCheckpointedEventSourceAdapterV1 } from '@happier-dev/plugin-sdk/background-services';

export const HEALTH_STATUS_EVENT = 'health-status';
const status = defineProtocolUnion([defineProtocolLiteral('up'), defineProtocolLiteral('down'), defineProtocolLiteral('degraded')]);
const ordinal = defineProtocolNumber({ integer: true, minimum: 0 });
export const healthTransition = defineProtocolObject({ sourceInstanceId: defineProtocolString(),
    subject: HealthCheckSubjectV1ProtocolSchema, checkId: defineProtocolString(),
    phase: defineProtocolUnion([defineProtocolLiteral('open'), defineProtocolLiteral('resolved')]),
    result: HealthCheckResultV1ProtocolSchema }, { policy: 'closed' });
const cursorSchema = defineProtocolObject({ basis: defineProtocolString(),
    checks: defineProtocolArray(defineProtocolObject({ checkId: defineProtocolString(), status, ordinal }, { policy: 'closed' })),
    pending: defineProtocolArray(defineProtocolObject({ checkId: defineProtocolString(), ordinal,
        result: HealthCheckResultV1ProtocolSchema, receivedAt: defineProtocolNumber({ integer: true, minimum: 0 }),
    }, { policy: 'closed' })).optional(),
}, { policy: 'closed' });
type Cursor = ReturnType<typeof cursorSchema.parse>;
type Candidate = Readonly<{ key: string; expectedVersion: number | 'absent'; value: Cursor }>;

/** The shared SDK runner owns lifecycle/adoption/wakes/admission. This finite
 * adapter owns only due times, incomplete live streaks and transition custody. */
export function createHealthCheckSourceAdapter(now: () => number = Date.now,
    host?: BackgroundServiceContext['services']['events']['host']): PluginCheckpointedEventSourceAdapterV1<HealthCheckSourceConfigV1, Candidate> {
    const live = new Map<string, { basis: string; source: HealthCheckSourceConfigV1;
        due: Map<string, number | null>; failures: Map<string, number>; pendingChecks: Set<string> }>();
    return {
        decode(definition) {
            if (definition.eventRef.localId !== HEALTH_STATUS_EVENT) return null;
            const parsed = HealthCheckSourceConfigV1ProtocolSchema.safeParse(definition.sourceConfig);
            return parsed.success ? parsed.data : null;
        },
        async observe({ context, definition, source }) {
            const storage = requireAccountStorage(context, { code: 'health_check_storage_unavailable', message: 'Health status storage is unavailable' }).kv;
            const key = `health:${computeCanonicalDomainSeparatedDigest('happier.health.status.v1', [definition.sourceInstanceId])}`;
            const basis = createCanonicalJsonSigningInput({ sourceInstanceId: definition.sourceInstanceId,
                sourceConfig: source, materialization: context.materialization ?? null });
            let state = live.get(definition.sourceInstanceId);
            if (state?.basis !== basis) {
                state = { basis, source, due: new Map(), failures: new Map(), pendingChecks: new Set() };
                live.set(definition.sourceInstanceId, state);
            }
            const { due, failures, pendingChecks } = state;
            const retained = await storage.get(key, { signal: context.signal });
            const parsed = retained && !('deleted' in retained) ? cursorSchema.parse(retained.value) : undefined;
            const previous: Cursor = parsed?.basis === basis ? parsed : { basis, checks: [] };
            let version: number | 'absent' = retained?.version ?? 'absent';
            const time = now();
            const next = new Map(previous.checks.map(value => [value.checkId, value]));
            const pending = [...(previous.pending ?? [])];
            const replaying = pending.length > 0;
            let changed = false;
            // An unsettled admission reuses its first observed clock/result,
            // including after reload. It must not run the endpoint again first.
            if (!pending.length) {
                const selected = source.checks.filter(check => {
                    const deadline = due.get(check.checkId);
                    return pendingChecks.has(check.checkId) || deadline === undefined || deadline !== null && deadline <= time;
                });
                // Consume only hints admitted to this read. A receipt arriving
                // during it remains pending for the next finite observation.
                for (const check of selected) pendingChecks.delete(check.checkId);
                const results = selected.length ? await context.services.healthChecks.read({
                    sourceInstanceId: definition.sourceInstanceId, checkIds: selected.map(check => check.checkId),
                }, { signal: context.signal }) : [];
                for (const check of selected) {
                    const identity = check.checkId;
                    const observation = results.find(value => value.checkId === check.checkId);
                    // Named heartbeat liveness reuses this due loop: null before
                    // the first ping; one true age deadline; person-chosen period
                    // observations until D5 settles, then null until a receipt or
                    // adoption/reconnect hint. No heartbeat means no extra idle work.
                    due.set(identity, observation?.nextEligibleAt === undefined ? time + check.periodMs : observation.nextEligibleAt);
                    const result = observation?.result;
                    if (!result) throw new PluginError({ code: 'health_check_result_unavailable', message: 'The saved check did not return a result' });
                    if (result.status === 'unknown') { failures.delete(identity); continue; }
                    if (result.status !== 'up') {
                        const count = (failures.get(identity) ?? 0) + 1;
                        failures.set(identity, count);
                        if (count < check.consecutiveFailuresBeforeAlerting) continue;
                        if (check.kind.localId === 'heartbeat') due.set(identity, null);
                    } else failures.delete(identity);
                    const prior = next.get(check.checkId);
                    if (prior?.status === result.status) continue;
                    const nextOrdinal = (prior?.ordinal ?? 0) + 1;
                    next.set(check.checkId, { checkId: check.checkId, status: result.status, ordinal: nextOrdinal });
                    changed = true;
                    if (result.status === 'up' && !prior) continue;
                    pending.push({ checkId: check.checkId, ordinal: nextOrdinal, result, receivedAt: time });
                }
                if (pending.length) {
                    const written = await storage.set(key, { basis, checks: [...next.values()], pending },
                        { expectedVersion: version, signal: context.signal });
                    version = written.version;
                }
            }
            const observations = pending.map(value => ({ eventRef: definition.eventRef,
                sourceInstanceId: definition.sourceInstanceId, sourceContractVersion: definition.sourceContractVersion,
                occurrenceId: computeCanonicalDomainSeparatedDigest('happier.health.transition.v1',
                    [definition.sourceInstanceId, basis, value.checkId, String(value.ordinal), value.result.status]),
                occurredAt: value.result.observedAt, observationReceivedAt: value.receivedAt, observedDelta: replaying ? 0 as const : 1 as const,
                payload: healthTransition.parse({ sourceInstanceId: definition.sourceInstanceId,
                    subject: source.subject, checkId: value.checkId, phase: value.result.status === 'up' ? 'resolved' : 'open', result: value.result }),
            }));
            const deadlines = source.checks.map(check => due.has(check.checkId) ? due.get(check.checkId) : time + check.periodMs)
                .filter((value): value is number => typeof value === 'number');
            return { observations, complete: true,
                nextEligibleAt: pendingChecks.size ? time : deadlines.length ? Math.min(...deadlines) : null,
                ...(changed || pending.length ? { checkpoint: { key, expectedVersion: version,
                    value: { basis, checks: [...next.values()] } } } : {}),
            };
        },
        async save({ context, checkpoint }) {
            await requireAccountStorage(context, { code: 'health_check_storage_unavailable', message: 'Health status storage is unavailable' }).kv.set(checkpoint.key, checkpoint.value,
                { expectedVersion: checkpoint.expectedVersion, signal: context.signal });
        },
        async retire({ context, definitions }) {
            const own = context.materialization;
            const current = new Set(definitions.filter(definition => own !== undefined
                && definition.eventRef.pluginId === context.plugin.id
                && definition.observationTransport.kind === 'checkpointedPull'
                && arePluginMachineMaterializationRefsEqual(own, definition.observationTransport.watcherMaterializationRef))
                .map(definition => definition.sourceInstanceId));
            for (const sourceInstanceId of live.keys()) if (!current.has(sourceInstanceId)) live.delete(sourceInstanceId);
            return { complete: true };
        },
        subscribeWake(wake) {
            if (!host) return { dispose() {} };
            const receiptSubscription = host.subscribe({ eventId: '@happier/health-check/heartbeat-received', scope: { kind: 'account' } }, async event => {
                const receipt = event.payload;
                const state = live.get(receipt.sourceInstanceId);
                const check = state?.source.checks.find(value => value.checkId === receipt.checkId && value.kind.localId === 'heartbeat');
                const config = check?.config;
                if (!state || !config || typeof config !== 'object' || Array.isArray(config)
                    || config.webhookEndpointId !== receipt.webhookEndpointId) return;
                state.pendingChecks.add(receipt.checkId);
                await wake(receipt.sourceInstanceId);
            });
            const reconnectSubscription = host.subscribe({ eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' } }, async event => {
                if (!('reason' in event.payload) || event.payload.reason !== 'reconnect') return;
                let pending = false;
                for (const state of live.values()) {
                    for (const check of state.source.checks) {
                        if (check.kind.localId !== 'heartbeat') continue;
                        state.pendingChecks.add(check.checkId);
                        pending = true;
                    }
                }
                if (pending) await wake();
            });
            return { dispose() { receiptSubscription.dispose(); reconnectSubscription.dispose(); } };
        },
        retryAt({ definition, error, now: time }) {
            if (isPluginError(error) && !error.retryable) return null;
            const parsed = HealthCheckSourceConfigV1ProtocolSchema.safeParse(definition?.sourceConfig);
            return parsed.success ? time + Math.min(...parsed.data.checks.map(check => check.periodMs)) : null;
        },
    };
}

export async function runHealthCheckObserver(context: BackgroundServiceContext): Promise<void> {
    await runCheckpointedPluginEventObserverV1({ context, source: createHealthCheckSourceAdapter(Date.now, context.services.events.host) });
}

export const savedHealthActions = Object.fromEntries(HEALTH_CHECK_KINDS_V1.map(kind => [`health/${kind}`, {
    title: `Check saved ${kind === 'http' ? 'HTTP' : kind === 'dns' ? 'DNS' : kind === 'tcp' ? 'TCP' : kind}`,
    scopes: ['machine', 'global'] as const, surfaces: ['ui', 'cli', 'agent', 'mcp', 'plugin'] as const,
    dangerLevel: 'safe' as const, readOnly: true, execution: { target: 'daemon' as const },
    inputSchema: SavedHealthCheckSelectorV1ProtocolSchema, resultSchema: HealthCheckResultV1ProtocolSchema,
    async run(value: unknown, context: PluginInvocationContext): Promise<HealthCheckResultV1> {
        const selector = SavedHealthCheckSelectorV1ProtocolSchema.parse(value);
        const results = await context.services.healthChecks.read({ sourceInstanceId: selector.sourceInstanceId,
            checkIds: [selector.checkId] }, { signal: context.signal });
        const selected = results.find(check => check.checkId === selector.checkId);
        if (!selected) throw new PluginError({ code: 'health_check_result_unavailable', message: 'The saved check did not return a result' });
        return selected.result;
    },
}]));
