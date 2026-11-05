import { computeCanonicalDomainSeparatedDigest, createCanonicalJsonSigningInput, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { createPluginEventAutomationSetupResultV1JsonSchema } from '@happier-dev/plugin-sdk/events';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { createRetainedFactEventSource } from './retainedFactSource.js';

const id = defineProtocolString({ minLength: 1 });
const timestamp = defineProtocolNumber({ integer: true, minimum: 0 });
const setupFields = { v: defineProtocolLiteral(1), mcpServerId: id };
const setup = defineProtocolObject(setupFields, { policy: 'closed' });
const source = defineProtocolObject({ ...setupFields, observingSince: timestamp }, { policy: 'closed' });
const payload = defineProtocolObject({ mcpServerId: id, observedAt: timestamp,
    installedRefDigest: id, upstreamRefDigest: id }, { policy: 'closed' });
const eventId = 'mcp-update-available';

async function readServer(context: PluginInvocationContext, serverId: string) {
    const result = await context.services.actions.execute('mcp.servers.read', { serverId }, { signal: context.signal });
    if ('status' in result && result.status === 'not-found') return null;
    if (!('status' in result) || result.status !== 'present' || result.authority !== 'active' || !result.complete) {
        throw new PluginError({ code: 'catalog_unavailable', message: 'The MCP server catalog is unavailable.' });
    }
    return result.server;
}

export const mcpUpdateEventActions = { [`${eventId}/setup`]: {
    title: 'Choose MCP server', execution: { target: 'daemon' as const }, scopes: ['global', 'machine'] as const,
    surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'] as const, dangerLevel: 'safe' as const, readOnly: true,
    inputSchema: setup, resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, source.jsonSchema),
    async run(input: unknown, context: PluginInvocationContext) {
        const config = source.parse({ ...setup.parse(input), observingSince: context.invokedAtMs });
        const server = await readServer(context, config.mcpServerId);
        if (!server || server.origin?.kind !== 'registry') throw new PluginError({ code: 'target_unavailable', message: 'The registry MCP server is unavailable.' });
        return { v: 1 as const, sourceInstanceId: `mcp-update:${computeCanonicalDomainSeparatedDigest('happier.mcp.update.source.v1',
            [config.mcpServerId, String(config.observingSince)])}`, sourceContractVersion: 1, sourceConfig: config, displayLabel: config.mcpServerId };
    },
} };
export const mcpUpdateEvents = { [eventId]: { declaration: {
    kind: 'event' as const, title: { key: 'machineServices.events.mcpUpdateAvailable.title', fallback: 'MCP server update available' },
    description: { key: 'machineServices.events.mcpUpdateAvailable.description', fallback: 'A registry MCP server has a newly observed upstream update.' },
    payloadSchema: payload.jsonSchema, automation: { v: 1 as const, eligible: true as const, source: {
        sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull' as const], sourceConfigSchema: source.jsonSchema,
        setupActionRef: { pluginId: 'happier.machine.services', localId: `${eventId}/setup` },
    } },
} } };

export function createMcpUpdateEventSourceAdapter(host: BackgroundServiceContext['services']['events']['host'], now: () => number = Date.now) {
    return createRetainedFactEventSource({ host, eventId, schema: source, now, entityId: config => config.mcpServerId,
        async read(context, config) {
            const server = await readServer(context, config.mcpServerId);
            const origin = server?.origin;
            if (!server || origin?.kind !== 'registry' || origin.upstream?.state !== 'update_available'
                || origin.upstreamObservedAt === undefined || origin.upstreamObservedAt < config.observingSince) return null;
            const installedRefDigest = computeCanonicalDomainSeparatedDigest('happier.mcp.installed.ref.v1', [createCanonicalJsonSigningInput(origin.provenance.ref)]);
            const upstreamRefDigest = computeCanonicalDomainSeparatedDigest('happier.mcp.upstream.ref.v1', [createCanonicalJsonSigningInput(origin.upstream.latest ?? null)]);
            return { occurredAt: origin.upstreamObservedAt, occurrenceId: computeCanonicalDomainSeparatedDigest('happier.mcp.update.available.v1',
                [server.id, installedRefDigest, upstreamRefDigest, String(origin.upstreamObservedAt)]),
                payload: payload.parse({ mcpServerId: server.id, observedAt: origin.upstreamObservedAt, installedRefDigest, upstreamRefDigest }) };
        },
    });
}
export const mcpUpdateEventBackgroundServices = [{ declaration: { id: 'mcp-update-observer', title: 'MCP update Events', placement: 'daemon' as const },
    async runner(context: BackgroundServiceContext) { await runCheckpointedPluginEventObserverV1({ context, source: createMcpUpdateEventSourceAdapter(context.services.events.host) }); } }];
