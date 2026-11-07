import { computeCanonicalDomainSeparatedDigest, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { createPluginEventAutomationSetupResultV1JsonSchema } from '@happier-dev/plugin-sdk/events';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { createRetainedFactEventSource } from './retainedFactSource.js';

const id = defineProtocolString({ minLength: 1 });
const number = defineProtocolNumber({ integer: true, minimum: 0 });
const target = { v: defineProtocolLiteral(1), serverId: id, machineId: id };
const setup = defineProtocolObject(target, { policy: 'closed' });
const source = defineProtocolObject({ ...target, afterRevision: number }, { policy: 'closed' });
const descriptors = [
    { id: 'machine-offline', transition: 'offline', key: 'machineOffline', title: 'Machine went offline', description: 'The Machine is no longer connected.' },
    { id: 'machine-online', transition: 'online', key: 'machineOnline', title: 'Machine came back online', description: 'An offline Machine became active again.' },
] as const;
type PresenceEventId = typeof descriptors[number]['id'];
function payload(transition: 'offline' | 'online') {
    return defineProtocolObject({ serverId: id, machineId: id, transition: defineProtocolLiteral(transition),
        revision: number, observedAt: number }, { policy: 'closed' });
}
async function read(context: PluginInvocationContext, config: { serverId: string; machineId: string }) {
    const result = await context.services.actions.execute('machines.presence.read', {
        serverId: config.serverId, machineId: config.machineId,
    }, { signal: context.signal });
    if (result.kind !== 'present' || result.machineId !== config.machineId) {
        throw new PluginError({ code: 'target_unavailable', message: 'The Machine presence is unavailable.' });
    }
    return result.transitions;
}
export const machinePresenceEventActions = Object.fromEntries(descriptors.map(event => [`${event.id}/setup`, {
    title: 'Choose Machine', execution: { target: 'daemon' as const }, scopes: ['global', 'machine'] as const,
    surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'] as const, dangerLevel: 'safe' as const, readOnly: true,
    inputSchema: setup, resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, source.jsonSchema),
    async run(input: unknown, context: PluginInvocationContext) {
        const selected = setup.parse(input);
        const retained = await read(context, selected);
        const config = source.parse({ ...selected, afterRevision: retained?.revision ?? 0 });
        return { v: 1 as const, sourceInstanceId: `presence:${computeCanonicalDomainSeparatedDigest('happier.machine.presence.source.v1',
            [selected.serverId, selected.machineId, event.id, String(context.invokedAtMs)])}`,
            sourceContractVersion: 1, sourceConfig: config, displayLabel: selected.machineId };
    },
}]));
export const machinePresenceEvents = Object.fromEntries(descriptors.map(event => [event.id, { declaration: {
    kind: 'event' as const, title: { key: `machineServices.events.${event.key}.title`, fallback: event.title },
    description: { key: `machineServices.events.${event.key}.description`, fallback: event.description },
    payloadSchema: payload(event.transition).jsonSchema, automation: { v: 1 as const, eligible: true as const, source: {
        sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull' as const], sourceConfigSchema: source.jsonSchema,
        setupActionRef: { pluginId: 'happier.machine.services', localId: `${event.id}/setup` },
    } },
} } ]));
export function createMachinePresenceEventSourceAdapter(host: BackgroundServiceContext['services']['events']['host'],
    eventId: PresenceEventId, now: () => number = Date.now) {
    const event = descriptors.find(candidate => candidate.id === eventId)!;
    return createRetainedFactEventSource({ host, eventId, schema: source, now, entityId: config => config.machineId,
        async read(context, config) {
            const retained = await read(context, config);
            const fact = retained?.[event.transition];
            if (!fact || fact.revision <= config.afterRevision) return null;
            return { occurredAt: fact.occurredAt,
                occurrenceId: computeCanonicalDomainSeparatedDigest('happier.machine.presence.occurrence.v1',
                    [config.serverId, config.machineId, event.transition, String(fact.revision)]),
                payload: payload(event.transition).parse({ serverId: config.serverId, machineId: config.machineId,
                    transition: event.transition, revision: fact.revision, observedAt: fact.occurredAt }) };
        },
    });
}
export const machinePresenceEventBackgroundServices = descriptors.map(event => ({
    declaration: { id: `${event.id}-observer`, title: event.title, placement: 'daemon' as const },
    async runner(context: BackgroundServiceContext) {
        await runCheckpointedPluginEventObserverV1({ context,
            source: createMachinePresenceEventSourceAdapter(context.services.events.host, event.id) });
    },
}));
