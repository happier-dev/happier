import { computeCanonicalDomainSeparatedDigest, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { createPluginEventAutomationSetupResultV1JsonSchema } from '@happier-dev/plugin-sdk/events';

const id = defineProtocolString({ minLength: 1 });
const number = defineProtocolNumber({ integer: true, minimum: 0 });
const target = { v: defineProtocolLiteral(1), serverId: id, machineId: id };
const setup = defineProtocolObject(target, { policy: 'closed' });
const source = defineProtocolObject({ ...target, afterRevision: number }, { policy: 'closed' });
const descriptors = [
    { id: 'machine-offline', transition: 'offline', key: 'machineOffline', title: 'Machine went offline', description: 'The Machine is no longer connected.' },
    { id: 'machine-online', transition: 'online', key: 'machineOnline', title: 'Machine came back online', description: 'An offline Machine became active again.' },
] as const;
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
    payloadSchema: payload(event.transition).jsonSchema, automation: { v: 1 as const, eligible: true as const,
        subjectKinds: ['machine' as const], source: {
        nativeActivity: { kind: 'machinePresence' as const, transition: event.transition },
        sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull' as const], sourceConfigSchema: source.jsonSchema,
        setupActionRef: { pluginId: 'happier.machine.services', localId: `${event.id}/setup` },
    } },
} } ]));
