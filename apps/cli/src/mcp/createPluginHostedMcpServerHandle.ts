import type { McpServerHandleV1, McpServerSpecV1 } from '@happier-dev/plugin-sdk';

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

export function createPluginHostedMcpServerHandle(params: Readonly<{
    pluginId: string;
    spec: McpServerSpecV1;
    registry: PluginHostedMcpServerRegistryV1;
}>): McpServerHandleV1 {
    if (params.registry.has(params.pluginId, params.spec.id)) {
        throw new Error(`Hosted MCP server '${params.spec.id}' is already active for plugin '${params.pluginId}'`);
    }
    params.registry.add(params.pluginId, params.spec);
    let disposed = false;
    return Object.freeze({
        id: params.spec.id,
        spec: params.spec,
        async dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            params.registry.remove(params.pluginId, params.spec.id);
        },
    });
}
