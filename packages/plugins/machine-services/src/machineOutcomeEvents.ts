import { computeCanonicalDomainSeparatedDigest, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, BackupOutcomeEventV1ProtocolSchema, MachinePressureEventV1ProtocolSchema,
    createPluginEventAutomationSetupResultV1JsonSchema, type MachineServiceObservationV1,
    type PluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext,
    type PluginCheckpointedEventSourceAdapterV1 } from '@happier-dev/plugin-sdk/background-services';

const pluginId = 'happier.machine.services';
const id = defineProtocolString({ minLength: 1 });
const target = { v: defineProtocolLiteral(1), serverId: id, machineId: id };
const machineSetup = defineProtocolObject(target, { policy: 'closed' });
const backupSetup = defineProtocolObject({ ...target, environmentId: id }, { policy: 'closed' });
const sourceSchema = defineProtocolObject({ ...target, environmentId: id.optional() }, { policy: 'closed' });
type Source = ReturnType<typeof sourceSchema.parse>;
const descriptors = {
    'backup-failed': { key: 'backupFailed', title: 'Backup failed', description: 'A backup run settled as failed.', schema: BackupOutcomeEventV1ProtocolSchema },
    'backup-succeeded': { key: 'backupSucceeded', title: 'Backup succeeded', description: 'A backup run settled successfully.', schema: BackupOutcomeEventV1ProtocolSchema },
    'machine-pressure-changed': { key: 'machinePressureChanged', title: 'Machine pressure changed',
        description: 'An enabled memory, CPU or disk alert fired or recovered.', schema: MachinePressureEventV1ProtocolSchema },
} as const;
type EventId = keyof typeof descriptors;
const isEventId = (value: string): value is EventId => Object.hasOwn(descriptors, value);
const eventIds = Object.keys(descriptors) as EventId[];
const matches = (event: EventId, source: Source, fact: MachineServiceObservationV1) =>
    fact.serverId === source.serverId && fact.machineId === source.machineId
    && (fact.kind === 'pressure' ? event === 'machine-pressure-changed'
        : fact.environmentId === source.environmentId
            && event === (fact.state === 'failed' ? 'backup-failed' : 'backup-succeeded'));
export const machineOutcomeEventActions = Object.fromEntries(eventIds.map(event => [event + '/setup', {
    title: event === 'machine-pressure-changed' ? 'Choose Machine' : 'Choose backup Environment',
    execution: { target: 'daemon' as const }, scopes: ['global', 'machine'] as const,
    surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'] as const, dangerLevel: 'safe' as const, readOnly: true,
    inputSchema: event === 'machine-pressure-changed' ? machineSetup : backupSetup,
    resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, sourceSchema.jsonSchema),
    async run(value: unknown, context: PluginInvocationContext) {
        const selected = (event === 'machine-pressure-changed' ? machineSetup : backupSetup).parse(value);
        const read = await context.services.actions.execute('machines.resources.policy.get', {
            serverId: selected.serverId, machineId: selected.machineId,
        }, { signal: context.signal });
        if (!('status' in read) || read.status !== 'ready') throw new PluginError({ code: 'target_unavailable', message: 'The Machine resource policy is unavailable.' });
        const sourceConfig = sourceSchema.parse(selected);
        return { v: 1 as const, sourceInstanceId: 'machine-event:' + computeCanonicalDomainSeparatedDigest('happier.machine.event-source.v1',
            [sourceConfig.serverId, sourceConfig.machineId, sourceConfig.environmentId ?? '', event]),
            sourceContractVersion: 1, sourceConfig, displayLabel: sourceConfig.environmentId ?? sourceConfig.machineId };
    },
}]));
export const machineOutcomeEvents = Object.fromEntries(eventIds.map(event => {
    const descriptor = descriptors[event];
    return [event, { declaration: { kind: 'event' as const,
        title: { key: 'machineServices.events.' + descriptor.key + '.title', fallback: descriptor.title },
        description: { key: 'machineServices.events.' + descriptor.key + '.description', fallback: descriptor.description },
        payloadSchema: descriptor.schema.jsonSchema, automation: { v: 1 as const, eligible: true as const, source: {
            sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull' as const], sourceConfigSchema: sourceSchema.jsonSchema,
            setupActionRef: { pluginId, localId: event + '/setup' },
        } },
    } }];
}));

type State = { source: Source; event: EventId; pending: PluginEventObservationV1[] };
/** Observe already-decided live facts. The SDK runner owns admission and dedupe.
 * A checkpoint removes only the admitted prefix, preserving arrivals during admission. */
export function createMachineOutcomeEventSourceAdapter(host: BackgroundServiceContext['services']['events']['host'],
    now: () => number = Date.now): PluginCheckpointedEventSourceAdapterV1<Source, { state: State; count: number }> {
    const states = new Map<string, State>();
    return {
        decode(definition) {
            if (definition.eventRef.pluginId !== pluginId || definition.sourceContractVersion !== 1 || !isEventId(definition.eventRef.localId)) return null;
            const parsed = sourceSchema.safeParse(definition.sourceConfig);
            if (!parsed.success || definition.eventRef.localId !== 'machine-pressure-changed' && !parsed.data.environmentId) return null;
            return parsed.data;
        },
        async observe({ definition, source }) {
            let state = states.get(definition.sourceInstanceId);
            if (!state) {
                state = { source, event: definition.eventRef.localId as EventId, pending: [] };
                states.set(definition.sourceInstanceId, state);
            }
            state.source = source;
            return { observations: [...state.pending], checkpoint: { state, count: state.pending.length }, complete: true, nextEligibleAt: null };
        },
        async save({ checkpoint }) { checkpoint.state.pending.splice(0, checkpoint.count); },
        retryAt() { return null; },
        async retire({ definitions }) {
            const current = new Set(definitions.map(definition => definition.sourceInstanceId));
            for (const id of states.keys()) if (!current.has(id)) states.delete(id);
            return { complete: true };
        },
        subscribeWake(wake) {
            return host.subscribe({ eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' } }, async ({ payload }) => {
                const occurredAt = payload.kind === 'backup' ? payload.occurredAt : payload.episode.at;
                const identity = payload.kind === 'backup' ? [payload.operationId]
                    : [payload.episode.rule, payload.episode.volumeId ?? '', payload.episode.state, String(payload.episode.at)];
                for (const [sourceInstanceId, state] of states) {
                    if (!matches(state.event, state.source, payload)) continue;
                    state.pending.push({ eventRef: { pluginId, localId: state.event }, sourceInstanceId, sourceContractVersion: 1,
                        occurrenceId: computeCanonicalDomainSeparatedDigest('happier.machine.event-occurrence.v1',
                            [payload.serverId, payload.machineId, state.event, ...identity]),
                        occurredAt, observationReceivedAt: now(), observedDelta: 1, payload });
                    await wake(sourceInstanceId);
                }
            });
        },
    };
}
export const machineOutcomeEventBackgroundServices = [{ declaration: {
    id: 'machine-outcome-observer', title: 'Backup and Machine pressure events', placement: 'daemon' as const,
}, async runner(context: BackgroundServiceContext) {
    await runCheckpointedPluginEventObserverV1({ context, source: createMachineOutcomeEventSourceAdapter(context.services.events.host) });
} }];
