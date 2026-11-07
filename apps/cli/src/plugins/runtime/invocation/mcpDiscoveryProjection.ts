import { McpDetectedProviderV1Schema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import type { DaemonMcpServersDetectWarningV1 } from '@happier-dev/protocol';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { type McpDiscoveredEndpoint as PluginMcpDiscoveredEndpoint, type McpDiscoveryResult as PluginMcpDiscoveryResult } from '@happier-dev/plugin-sdk/mcp';

export function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function cloneLegacyMcpHandlerInput(value: unknown): JsonValue {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
        throw new PluginError({
            code: 'plugin_mcp_input_invalid',
            message: 'MCP tool input must be strict JSON',
        });
    }
    return JSON.parse(encoded) as JsonValue;
}

export function projectPluginMcpDiscoveredEndpoints(
    endpoints: PluginMcpDiscoveryResult['endpoints'],
): readonly PluginMcpDiscoveredEndpoint[] {
    return Object.freeze((endpoints ?? []).map((endpoint) => Object.freeze({
        id: endpoint.id,
        name: endpoint.name,
        kind: endpoint.kind,
        url: endpoint.url,
    })));
}

export function projectPluginMcpDiscoveryWarnings(
    warnings: PluginMcpDiscoveryResult['warnings'],
): NonNullable<PluginMcpDiscoveryResult['warnings']> {
    return Object.freeze((warnings ?? []).map((warning) => Object.freeze({
        code: warning.code,
        ...(warning.path === undefined ? {} : { path: warning.path }),
        ...(warning.detail === undefined ? {} : { detail: warning.detail }),
    })));
}

export function projectPluginMcpDiscoveryWarningsToLegacyDetection(
    provider: unknown,
    warnings: PluginMcpDiscoveryResult['warnings'],
): readonly DaemonMcpServersDetectWarningV1[] {
    const parsedProvider = McpDetectedProviderV1Schema.safeParse(provider);
    if (!parsedProvider.success) return Object.freeze([]);
    return Object.freeze(projectPluginMcpDiscoveryWarnings(warnings).map((warning) => Object.freeze({
        provider: parsedProvider.data,
        ...warning,
    })));
}
