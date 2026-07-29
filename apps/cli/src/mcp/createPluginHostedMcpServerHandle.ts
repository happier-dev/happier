import type { McpServerSpecV1 } from '@happier-dev/plugin-sdk/experimental/mcp';

import { assertMcpRuntimeServerRegistrationSafe } from './hosted/safety';
import type { HostedMcpRuntimeEndpoint } from './runtimeTypes';

/**
 * Per-runtime registry of active hosted MCP server specs.
 *
 * RN-MCP-001 fix: replaces a module-global `Map` with a per-runtime registry
 * passed in by the caller (typically `engineRegistry` per plugin/runtime
 * scope). This eliminates cross-runtime/cross-session collisions and ensures
 * plugin reactivation does not see stale state from a prior runtime.
 */
export type PluginHostedMcpServerRegistryV1 = Readonly<{
    has: (pluginId: string, specId: string) => boolean;
    add: (pluginId: string, spec: McpServerSpecV1) => void;
    remove: (pluginId: string, specId: string) => void;
    list: (pluginId: string) => readonly McpServerSpecV1[];
}>;

export function createPluginHostedMcpServerRegistry(): PluginHostedMcpServerRegistryV1 {
    const active = new Map<string, McpServerSpecV1>();
    function key(pluginId: string, specId: string): string {
        return `${pluginId}:${specId}`;
    }
    return Object.freeze({
        has: (pluginId, specId) => active.has(key(pluginId, specId)),
        add: (pluginId, spec) => {
            active.set(key(pluginId, spec.id), spec);
        },
        remove: (pluginId, specId) => {
            active.delete(key(pluginId, specId));
        },
        list: (pluginId) => {
            const prefix = `${pluginId}:`;
            return Object.freeze(
                [...active.entries()]
                    .filter(([entryKey]) => entryKey.startsWith(prefix))
                    .map(([, spec]) => spec),
            );
        },
    });
}

export type PluginHostedMcpRuntimeEndpointHandle = Readonly<{
    endpoint: HostedMcpRuntimeEndpoint;
    dispose: () => Promise<void> | void;
}>;

export type PluginHostedMcpServerHandle = Readonly<{
    id: string;
    spec: McpServerSpecV1;
    endpoint?: HostedMcpRuntimeEndpoint;
    dispose(): Promise<void>;
}>;

export type StartPluginHostedMcpRuntimeEndpoint = (params: Readonly<{
    pluginId: string;
    spec: McpServerSpecV1;
}>) => Promise<PluginHostedMcpRuntimeEndpointHandle> | PluginHostedMcpRuntimeEndpointHandle;

function requestsLoopbackHttpExposure(spec: McpServerSpecV1): boolean {
    return spec.transport.kind === 'hosted'
        && spec.transport.exposure?.kind === 'loopbackHttp'
        && spec.transport.exposure.requested === true;
}

function assertSanitizedHostedEndpoint(endpoint: HostedMcpRuntimeEndpoint): void {
    if (endpoint.kind !== 'loopbackHttp') {
        throw new Error('Hosted MCP runtime endpoint must be a sanitized loopback endpoint');
    }
    let parsed: URL;
    try {
        parsed = new URL(endpoint.url);
    } catch {
        throw new Error('Hosted MCP runtime endpoint must be a sanitized loopback endpoint URL');
    }
    if (
        endpoint.host !== '127.0.0.1'
        || parsed.protocol !== 'http:'
        || parsed.hostname !== '127.0.0.1'
        || parsed.username.length > 0
        || parsed.password.length > 0
        || parsed.pathname !== '/'
        || parsed.search.length > 0
        || parsed.hash.length > 0
        || Number(parsed.port) !== endpoint.port
        || !Number.isInteger(endpoint.port)
        || endpoint.port <= 0
        || endpoint.port > 65535
    ) {
        throw new Error('Hosted MCP runtime endpoint must be a sanitized loopback endpoint');
    }
}

export async function createPluginHostedMcpServerHandle(params: Readonly<{
    pluginId: string;
    spec: McpServerSpecV1;
    registry: PluginHostedMcpServerRegistryV1;
    startRuntimeEndpoint?: StartPluginHostedMcpRuntimeEndpoint;
}>): Promise<PluginHostedMcpServerHandle> {
    assertMcpRuntimeServerRegistrationSafe(params.spec, { pluginId: params.pluginId });
    if (params.registry.has(params.pluginId, params.spec.id)) {
        throw new Error(`Hosted MCP server '${params.spec.id}' is already active for plugin '${params.pluginId}'`);
    }
    params.registry.add(params.pluginId, params.spec);
    let endpointHandle: PluginHostedMcpRuntimeEndpointHandle | null = null;
    try {
        if (requestsLoopbackHttpExposure(params.spec)) {
            if (!params.startRuntimeEndpoint) {
                throw new Error(`Hosted MCP server '${params.spec.id}' requested loopback exposure but no host runtime endpoint adapter is available`);
            }
            endpointHandle = await params.startRuntimeEndpoint({
                pluginId: params.pluginId,
                spec: params.spec,
            });
            assertSanitizedHostedEndpoint(endpointHandle.endpoint);
        }
    } catch (error) {
        try {
            await endpointHandle?.dispose();
        } finally {
            params.registry.remove(params.pluginId, params.spec.id);
        }
        throw error;
    }
    let disposed = false;
    return Object.freeze({
        id: params.spec.id,
        spec: params.spec,
        endpoint: endpointHandle?.endpoint,
        async dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            try {
                await endpointHandle?.dispose();
            } finally {
                params.registry.remove(params.pluginId, params.spec.id);
            }
        },
    });
}
