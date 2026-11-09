import type { McpServerRuleV1, McpServerCatalogEntryV1, McpServersSettingsV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { t } from '@/text';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { HostCatalogMark } from '@/components/ui/media/HappierBrandMark';

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

/** Servers by display name, retaining the projection of unchanged admitted server/rule facts. */
export function buildMcpServerCollection(settings: McpServersSettingsV1, query: string,
    previous: readonly McpServerCollectionRow[] = [], brandMarks?: Readonly<Record<string, HostCatalogMark>>): readonly McpServerCollectionRow[] {
    const previousById = new Map(previous.map(row => [row.server.id, row]));
    const bindingsByServerId = new Map<string, McpServerRuleV1[]>();
    for (const binding of settings.bindings) {
        const list = bindingsByServerId.get(binding.serverId);
        if (list) list.push(binding);
        else bindingsByServerId.set(binding.serverId, [binding]);
    }
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const rows = settings.servers
        .map((server): McpServerCollectionRow => {
            const old = previousById.get(server.id);
            const incomingBindings = bindingsByServerId.get(server.id) ?? [];
            const bindings = old && old.bindings.length === incomingBindings.length
                && incomingBindings.every((binding, index) => binding === old.bindings[index]) ? old.bindings : incomingBindings;
            const title = mcpServerDisplayName(server);
            const brandMark = brandMarks?.[server.id];
            if (old && old.server === server && old.bindings === bindings && old.title === title && old.brandMark === brandMark) return old;
            return { server, bindings, title, ...(brandMark ? { brandMark } : {}), unbound: !bindings.some((binding) => binding.enabled) };
        })
        .filter((row) => !normalizedQuery
            || row.title.toLocaleLowerCase().includes(normalizedQuery)
            || row.server.name.toLocaleLowerCase().includes(normalizedQuery))
        .sort((a, b) => a.title.localeCompare(b.title));
    return rows.length === previous.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
}
