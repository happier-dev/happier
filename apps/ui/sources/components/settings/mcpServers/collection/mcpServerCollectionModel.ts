import type { McpServerRuleV1, McpServerCatalogEntryV1, McpServersSettingsV1 } from '@happier-dev/protocol';

import { t } from '@/text';
import type { HostCatalogMark } from '@/components/ui/media/HappierBrandMark';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

/** The collection's own route; its detail routes resolve beneath it. */
export const MCP_COLLECTION_ROUTE = SETTINGS_ROUTES.mcp;
export const MCP_NEW_SERVER_ROUTE = `${MCP_COLLECTION_ROUTE}/new`;
export const MCP_FOUND_ROUTE = SETTINGS_ROUTES.mcpFound;

export function mcpServerRoute(serverId: string): string {
    return `${MCP_COLLECTION_ROUTE}/${encodeURIComponent(serverId)}`;
}

export type McpServerCollectionRow = Readonly<{
    server: McpServerCatalogEntryV1;
    bindings: readonly McpServerRuleV1[];
    title: string;
    brandMark?: HostCatalogMark;
    /** Applies nowhere: no enabled rule. Only this gets the rail's trouble dot. */
    unbound: boolean;
}>;

export function mcpServerDisplayName(server: Pick<McpServerCatalogEntryV1, 'title' | 'name'>): string {
    return server.title || server.name || t('settings.mcpServersUnnamed');
}

/** Servers by display name, each with the rules that apply it. */
export function buildMcpServerCollection(settings: McpServersSettingsV1, query: string): readonly McpServerCollectionRow[] {
    const bindingsByServerId = new Map<string, McpServerRuleV1[]>();
    for (const binding of settings.bindings) {
        const list = bindingsByServerId.get(binding.serverId);
        if (list) list.push(binding);
        else bindingsByServerId.set(binding.serverId, [binding]);
    }
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return settings.servers
        .map((server): McpServerCollectionRow => {
            const bindings = bindingsByServerId.get(server.id) ?? [];
            return {
                server,
                bindings,
                title: mcpServerDisplayName(server),
                unbound: !bindings.some((binding) => binding.enabled),
            };
        })
        .filter((row) => !normalizedQuery
            || row.title.toLocaleLowerCase().includes(normalizedQuery)
            || row.server.name.toLocaleLowerCase().includes(normalizedQuery))
        .sort((a, b) => a.title.localeCompare(b.title));
}
