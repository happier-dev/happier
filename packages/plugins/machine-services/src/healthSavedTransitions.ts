import { HealthCheckResultV1ProtocolSchema, SavedHealthTransitionSourceV1ProtocolSchema, createSavedHealthTransitionSourceInstanceIdV1,
    type SavedHealthTransitionSourceV1,
    computeCanonicalDomainSeparatedDigest, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createProtocolStoredReadSchema, defineProtocolArray, defineProtocolLiteral, defineProtocolNumber,
    defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { createPluginEventAutomationSetupResultV1JsonSchema, type HostEventEnvelope, type PluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';
import { requireAccountStorage } from '@happier-dev/plugin-sdk/storage';
import type { BackgroundServiceContext, PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import { HEALTH_RESULT_CHECKPOINT_PREFIX, healthResultProjectionSchema, healthResultSourceSchema } from './healthResultProjection.js';
import { HEALTH_CHECK_FAILED_EVENT, HEALTH_CHECK_RECOVERED_EVENT, MACHINE_SERVICES_PLUGIN_ID } from './healthSetup.js';

const ordinal = defineProtocolNumber({ integer: true, minimum: 0 });
const status = defineProtocolUnion([defineProtocolLiteral('up'), defineProtocolLiteral('down'), defineProtocolLiteral('degraded')]);
const transition = defineProtocolObject({ checkId: defineProtocolString(), ordinal,
    result: HealthCheckResultV1ProtocolSchema, receivedAt: ordinal }, { policy: 'closed' });
export const healthTransitionCursorSchema = defineProtocolObject({ basis: defineProtocolString(),
    checks: defineProtocolArray(defineProtocolObject({ checkId: defineProtocolString(), status, ordinal }, { policy: 'closed' })),
    current: healthResultProjectionSchema.optional(), pending: defineProtocolArray(transition).optional(),
    source: healthResultSourceSchema.optional(),
    transitions: defineProtocolArray(transition).optional(),
}, { policy: 'closed' });
export type HealthTransitionCursor = ReturnType<typeof healthTransitionCursorSchema.parse>;
export const healthTransitionCursorStoredSchema = createProtocolStoredReadSchema(healthTransitionCursorSchema);
const setup = defineProtocolObject({ v: defineProtocolLiteral(1), serverId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
export const savedHealthTransitionSourceSchema = SavedHealthTransitionSourceV1ProtocolSchema;
export type SavedHealthTransitionSource = SavedHealthTransitionSourceV1;
export const savedHealthTransitionActions = Object.fromEntries([HEALTH_CHECK_FAILED_EVENT, HEALTH_CHECK_RECOVERED_EVENT].map(event => [`${event}/setup`, {
    title: 'Choose saved health transitions', execution: { target: 'daemon' as const }, scopes: ['global', 'machine'] as const,
    surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'] as const, dangerLevel: 'safe' as const, readOnly: true,
    inputSchema: setup, resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, savedHealthTransitionSourceSchema.jsonSchema),
    async run(input: unknown, context: PluginInvocationContext) {
        const selected = setup.parse(input);
        const sourceConfig = savedHealthTransitionSourceSchema.parse({ ...selected, observingSince: context.invokedAtMs });
        return { v: 1 as const, sourceContractVersion: 1,
            sourceInstanceId: createSavedHealthTransitionSourceInstanceIdV1(event, sourceConfig),
            sourceConfig, displayLabel: 'Saved health checks' };
    },
}]));

export type SavedHealthTransitionCheckpoint = Readonly<{ savedSource: string; seen: ReadonlyMap<string, string>;
    processed: ReadonlyMap<string, HealthTransitionCursor | undefined> }>;
type Listener = { seen: ReadonlyMap<string, string>; pendingKeys: Set<string> };

/** One demanded Account health reader shared by selector groups. The saved
 * probe checkpoint remains the transition authority; this reader never probes. */
export function createSavedHealthTransitionReader(host?: BackgroundServiceContext['services']['events']['host']) {
    const rows = new Map<string, HealthTransitionCursor>();
    const changedKeys = new Set<string>();
    const listeners = new Map<string, Listener>();
    let fullRead = true;
    let syncSubscriptions: (() => void) | undefined;
    const save = (checkpoint: SavedHealthTransitionCheckpoint) => {
        const state = listeners.get(checkpoint.savedSource);
        if (state) {
            state.seen = checkpoint.seen;
            for (const [key, row] of checkpoint.processed) if (rows.get(key) === row) state.pendingKeys.delete(key);
        }
    };
    return {
        async observe(context: BackgroundServiceContext, definition: PluginCheckpointedEventSourceDefinitionV1, source: SavedHealthTransitionSource) {
            const kv = requireAccountStorage(context, { code: 'health_check_storage_unavailable', message: 'Health status storage is unavailable' }).kv;
            const state = listeners.get(definition.sourceInstanceId) ?? { seen: new Map<string, string>(), pendingKeys: new Set(rows.keys()) };
            listeners.set(definition.sourceInstanceId, state);
            syncSubscriptions?.();
            const apply = (key: string, value: unknown) => {
                const parsed = healthTransitionCursorStoredSchema.safeParse(value);
                if (parsed.success && parsed.data.source) rows.set(key, parsed.data);
                else rows.delete(key);
                for (const listener of listeners.values()) listener.pendingKeys.add(key);
            };
            if (fullRead) {
                fullRead = false;
                rows.clear();
                const keysAtStart = [...changedKeys];
                for (const key of keysAtStart) changedKeys.delete(key);
                try {
                    let cursor: string | undefined;
                    do {
                        const page = await kv.list({ prefix: HEALTH_RESULT_CHECKPOINT_PREFIX, ...(cursor ? { cursor } : {}), signal: context.signal });
                        context.signal.throwIfAborted();
                        for (const row of page.items) if (!('deleted' in row)) apply(row.key, row.value);
                        cursor = page.nextCursor;
                    } while (cursor);
                } catch (error) { fullRead = true; throw error; }
            } else {
                const keys = [...changedKeys];
                for (const key of keys) changedKeys.delete(key);
                try {
                    for (const key of keys) {
                        const row = await kv.get(key, { signal: context.signal });
                        context.signal.throwIfAborted();
                        apply(key, row && !('deleted' in row) ? row.value : undefined);
                    }
                } catch (error) { for (const key of keys) changedKeys.add(key); throw error; }
            }
            const seen = new Map(state.seen);
            const observations: PluginEventObservationV1[] = [];
            const processed = new Map([...state.pendingKeys].map(key => [key, rows.get(key)]));
            for (const [key, row] of processed) {
                if (!row) continue;
                const origin = row.source!;
                if (source.nativeSourceInstanceId && origin.sourceInstanceId !== source.nativeSourceInstanceId) continue;
                for (const value of row.transitions ?? []) {
                    if (value.receivedAt < source.observingSince) continue;
                    const eventId = value.result.status === 'up' ? HEALTH_CHECK_RECOVERED_EVENT : HEALTH_CHECK_FAILED_EVENT;
                    if (definition.eventRef.localId !== eventId) continue;
                    const occurrenceId = computeCanonicalDomainSeparatedDigest('happier.health.transition.v1',
                        [origin.sourceInstanceId, row.basis, value.checkId, String(value.ordinal), value.result.status]);
                    const checkKey = `${key}:${value.checkId}`;
                    if (state.seen.get(checkKey) === occurrenceId) continue;
                    seen.set(checkKey, occurrenceId);
                    observations.push({ eventRef: definition.eventRef, sourceInstanceId: definition.sourceInstanceId,
                        sourceContractVersion: definition.sourceContractVersion, occurrenceId,
                        occurredAt: value.result.observedAt, observationReceivedAt: value.receivedAt, observedDelta: 1,
                        payload: { sourceInstanceId: origin.sourceInstanceId, subject: origin.subject,
                            checkId: value.checkId, transition: value.result.status === 'up' ? 'recovered' : 'failed', observedAt: value.result.observedAt },
                        subjectContexts: [{ role: 'operand', subject: { kind: 'healthCheck', serverId: source.serverId,
                            sourceInstanceId: origin.sourceInstanceId, checkId: value.checkId } },
                            { role: 'context', subject: origin.subject.kind === 'environment' ? { kind: 'environment', serverId: source.serverId, environmentId: origin.subject.environmentId }
                                : { kind: 'machine', serverId: source.serverId, machineId: origin.subject.machineId } }],
                    });
                }
            }
            const checkpoint = { savedSource: definition.sourceInstanceId, seen, processed } satisfies SavedHealthTransitionCheckpoint;
            if (!observations.length) save(checkpoint);
            return { observations, complete: true, nextEligibleAt: null,
                ...(observations.length ? { checkpoint } : {}) };
        },
        save,
        retire(definitions: readonly PluginCheckpointedEventSourceDefinitionV1[]) {
            const active = new Set(definitions.filter(definition => savedHealthTransitionSourceSchema.safeParse(definition.sourceConfig).success).map(definition => definition.sourceInstanceId));
            for (const id of listeners.keys()) if (!active.has(id)) listeners.delete(id);
            if (!active.size) { rows.clear(); changedKeys.clear(); fullRead = true; }
            syncSubscriptions?.();
        },
        subscribeWake(wake: (sourceInstanceId?: string) => Promise<void>) {
            let account: { dispose(): void } | undefined;
            let reconnect: { dispose(): void } | undefined;
            const onAccount = async (event: HostEventEnvelope<'@happier/account/entities-invalidated'>) => {
                if (!listeners.size) return;
                let relevant = false;
                for (const hint of event.payload.dataKvChanges ?? []) {
                    if (hint.pluginId !== MACHINE_SERVICES_PLUGIN_ID) continue;
                    if ('full' in hint) { fullRead = true; relevant = true; }
                    else for (const key of hint.keys) if (key.startsWith(HEALTH_RESULT_CHECKPOINT_PREFIX)) { changedKeys.add(key); relevant = true; }
                }
                if (relevant) for (const id of listeners.keys()) await wake(id);
            };
            const onSourceInvalidation = async (event: HostEventEnvelope<'@happier/automation/event-sources-invalidated'>) => {
                if (!listeners.size || event.payload.pluginIds && !event.payload.pluginIds.includes(MACHINE_SERVICES_PLUGIN_ID)) return;
                fullRead = true;
                for (const id of listeners.keys()) await wake(id);
            };
            syncSubscriptions = () => {
                if (!listeners.size) { account?.dispose(); reconnect?.dispose(); account = undefined; reconnect = undefined; }
                else if (host && !account) {
                    account = host.subscribe({ eventId: '@happier/account/entities-invalidated', scope: { kind: 'account' } }, onAccount);
                    reconnect = host.subscribe({ eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' } }, onSourceInvalidation);
                }
            };
            syncSubscriptions();
            return { dispose() { account?.dispose(); reconnect?.dispose(); syncSubscriptions = undefined; } };
        },
    };
}
