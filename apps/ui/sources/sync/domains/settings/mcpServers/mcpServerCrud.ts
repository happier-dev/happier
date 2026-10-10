import { applyMcpServerCatalogMutationV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { McpServerCatalogMutationV1, McpServerCatalogV1 } from '@happier-dev/protocol';
import type { McpServerBindingV1, McpServerCatalogEntryV1, McpServersSettingsV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

/** Compatibility projection only; all entity decisions belong to the row owner. */
function apply(settings: McpServersSettingsV1, change: McpServerCatalogMutationV1): McpServersSettingsV1 {
    const catalog: McpServerCatalogV1 = { v: 1, servers: settings.servers, bindings: settings.bindings };
    const next = applyMcpServerCatalogMutationV1(catalog, change);
    return next === catalog ? settings : { ...settings, ...next };
}

export function addMcpServerCatalogEntryV1(settings: McpServersSettingsV1, entry: McpServerCatalogEntryV1): McpServersSettingsV1 {
    return apply(settings, { kind: 'server-create', entry, bindings: [] });
}

export function deleteMcpServerCatalogEntryV1(settings: McpServersSettingsV1, serverId: string, removeBindings = false): McpServersSettingsV1 {
    return apply(settings, { kind: 'server-remove', serverId, removeBindings });
}

export function addMcpServerBindingV1(settings: McpServersSettingsV1, binding: McpServerBindingV1): McpServersSettingsV1 {
    return apply(settings, { kind: 'binding-create', binding });
}

export function upsertMcpServerWithBindingsV1(
    settings: McpServersSettingsV1,
    entry: McpServerCatalogEntryV1,
    bindings: ReadonlyArray<McpServerBindingV1>,
): McpServersSettingsV1 {
    return apply(settings, { kind: 'server-upsert', entry, bindings: [...bindings] });
}
