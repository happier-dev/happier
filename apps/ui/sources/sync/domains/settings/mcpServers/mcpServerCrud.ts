import { applyMcpServerCatalogMutationV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { McpServerCatalogMutationV1} from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { McpServerRuleV1, McpServerCatalogEntryV1, McpServersSettingsV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

/** Compatibility projection only; all entity decisions belong to the row owner. */
function apply(settings: McpServersSettingsV1, change: McpServerCatalogMutationV1): McpServersSettingsV1 {
    const catalog: McpServerCatalogV1 = { v: 1, servers: settings.servers, bindings: settings.bindings };
    const next = applyMcpServerCatalogMutationV1(catalog, change);
    return next === catalog ? settings : { ...settings, ...next };
}

export function addMcpServerCatalogEntryV1(settings: McpServersSettingsV1, entry: McpServerCatalogEntryV1,
    rules: readonly McpServerRuleV1[]): McpServersSettingsV1 {
    return apply(settings, { kind: 'server-create', entry, rules: [...rules] });
}

export function deleteMcpServerCatalogEntryV1(settings: McpServersSettingsV1, serverId: string, removeBindings = false): McpServersSettingsV1 {
    return apply(settings, { kind: 'server-remove', serverId, removeBindings });
}

export function updateMcpServerCatalogEntryV1(
    settings: McpServersSettingsV1,
    entry: McpServerCatalogEntryV1,
): McpServersSettingsV1 {
    return apply(settings, { kind: 'server-update', entry });
}
