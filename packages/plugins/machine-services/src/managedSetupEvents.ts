import { computeCanonicalDomainSeparatedDigest, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { createPluginEventAutomationSetupResultV1JsonSchema } from '@happier-dev/plugin-sdk/events';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { createRetainedFactEventSource } from './retainedFactSource.js';

const id = defineProtocolString({ minLength: 1 });
const timestamp = defineProtocolNumber({ integer: true, minimum: 0 });
const setupFields = { v: defineProtocolLiteral(1), homeId: id, managedId: id };
const setup = defineProtocolObject(setupFields, { policy: 'closed' });
const source = defineProtocolObject({ ...setupFields, observingSince: timestamp }, { policy: 'closed' });
const payload = defineProtocolObject({ homeId: id, managedId: id, machineId: id, operationId: id,
    state: defineProtocolLiteral('failed'), errorCode: id.nullable(), observedAt: timestamp }, { policy: 'closed' });
const eventId = 'managed-machine-setup-failed';
async function readMachine(context: PluginInvocationContext, config: { homeId: string; managedId: string }) {
    const result = await context.services.actions.execute('machines.managed.get', { homeId: config.homeId, managedId: config.managedId }, { signal: context.signal });
    if (!('id' in result)) throw new PluginError({ code: 'target_unavailable', message: 'The managed Machine is unavailable.' });
    return result;
}
export const managedSetupEventActions = { [`${eventId}/setup`]: {
    title: 'Choose managed Machine', execution: { target: 'daemon' as const }, scopes: ['global', 'machine'] as const,
    surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'] as const, dangerLevel: 'safe' as const, readOnly: true,
    inputSchema: setup, resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, source.jsonSchema),
    async run(input: unknown, context: PluginInvocationContext) {
        const config = source.parse({ ...setup.parse(input), observingSince: context.invokedAtMs });
        const machine = await readMachine(context, config);
        if (machine.id !== config.managedId || machine.homeId !== config.homeId) throw new PluginError({ code: 'target_unavailable', message: 'The managed Machine is unavailable.' });
        return { v: 1 as const, sourceInstanceId: `managed-setup:${computeCanonicalDomainSeparatedDigest('happier.managed.setup.source.v1',
            [config.homeId, config.managedId, String(config.observingSince)])}`, sourceContractVersion: 1, sourceConfig: config, displayLabel: config.managedId };
    },
} };
export const managedSetupEvents = { [eventId]: { declaration: {
    kind: 'event' as const, title: { key: 'machineServices.events.managedSetupFailed.title', fallback: 'Managed Machine setup failed' },
    description: { key: 'machineServices.events.managedSetupFailed.description', fallback: 'A managed Machine setup operation settled as failed.' },
    payloadSchema: payload.jsonSchema, automation: { v: 1 as const, eligible: true as const, source: {
        sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull' as const], sourceConfigSchema: source.jsonSchema,
        setupActionRef: { pluginId: 'happier.machine.services', localId: `${eventId}/setup` },
    } },
} } };
export function createManagedSetupEventSourceAdapter(host: BackgroundServiceContext['services']['events']['host'], now: () => number = Date.now) {
    return createRetainedFactEventSource({ host, eventId, schema: source, now, entityId: config => config.managedId,
        async read(context, config) {
            const machine = await readMachine(context, config);
            const result = machine.machineSetup;
            if (machine.id !== config.managedId || machine.homeId !== config.homeId || !machine.enrolledMachineId
                || result?.state !== 'failed' || !result.operation || result.settledAtMs === undefined || result.settledAtMs < config.observingSince) return null;
            return { occurredAt: result.settledAtMs, occurrenceId: computeCanonicalDomainSeparatedDigest('happier.managed.setup.failed.v1',
                [machine.homeId, machine.id, result.operation.operationId]), payload: payload.parse({ homeId: machine.homeId,
                    managedId: machine.id, machineId: machine.enrolledMachineId, operationId: result.operation.operationId,
                    state: 'failed', errorCode: result.errorCode ?? null, observedAt: result.settledAtMs }) };
        },
    });
}
export const managedSetupEventBackgroundServices = [{ declaration: { id: 'managed-setup-observer', title: 'Managed setup Events', placement: 'daemon' as const },
    async runner(context: BackgroundServiceContext) { await runCheckpointedPluginEventObserverV1({ context, source: createManagedSetupEventSourceAdapter(context.services.events.host) }); } }];
