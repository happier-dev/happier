import { HealthCheckKindCatalogV1ProtocolSchema, HealthCheckSourceConfigV1ProtocolSchema,
    HealthCheckSourceSelectorV1ProtocolSchema, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';

export const HEALTH_KINDS_ACTION_ID = 'health/kinds';
export const HEALTH_SOURCE_ACTION_ID = 'health/source';

/** Read-only projections of the existing host owners, shared by UI and agents. */
export const healthCatalogActions = {
    [HEALTH_KINDS_ACTION_ID]: {
        title: 'List available health check kinds', scopes: ['global', 'machine'] as const,
        surfaces: ['ui', 'cli', 'agent', 'mcp', 'plugin'] as const, dangerLevel: 'safe' as const, readOnly: true,
        execution: { target: 'daemon' as const }, inputSchema: defineProtocolObject({}, { policy: 'closed' }),
        resultSchema: HealthCheckKindCatalogV1ProtocolSchema,
        async run(_input: unknown, context: PluginInvocationContext) {
            return context.services.healthChecks.listKinds({ signal: context.signal });
        },
    },
    [HEALTH_SOURCE_ACTION_ID]: {
        title: 'Read saved health checks', scopes: ['global', 'machine'] as const,
        surfaces: ['ui', 'cli', 'agent', 'mcp', 'plugin'] as const, dangerLevel: 'safe' as const, readOnly: true,
        execution: { target: 'daemon' as const }, inputSchema: HealthCheckSourceSelectorV1ProtocolSchema,
        resultSchema: HealthCheckSourceConfigV1ProtocolSchema,
        async run(input: unknown, context: PluginInvocationContext) {
            return context.services.healthChecks.readSource(HealthCheckSourceSelectorV1ProtocolSchema.parse(input), { signal: context.signal });
        },
    },
};
