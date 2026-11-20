import * as React from 'react';
import { useGlobalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';

import { resolveSettingsNestedRouteName } from '@/components/settings/navigation/settingsRouteRegistry';
import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';

import { McpServerCollection } from './collection/McpServerCollection';
import { MCP_COLLECTION_ROUTE } from './collection/mcpServerCollectionModel';
import { PluginMcpServerItemsContext, usePluginMcpServerItems } from './collection/usePluginMcpServerItems';
import { useMcpServersSettings } from './useMcpServersSettings';

/** The narrowest detail that still fits a command field beside its label. */
const MCP_DETAIL_MIN_WIDTH_PX = 480;

function resolveMcpChildRoute(pathname: string): string {
    return resolveSettingsNestedRouteName('mcp', pathname) ?? 'index';
}

/**
 * MCP servers as a collection beside the selected detail: a server's editor, a new server, or one of
 * the two machine tools. Narrow: the list page pushes each detail.
 */
export const McpSettingsLayout = React.memo(function McpSettingsLayout() {
    const pathname = usePathname().replace(/\/+$/, '');
    const { settings, snapshot } = useMcpServersSettings();
    const pluginItems = usePluginMcpServerItems();
    const emptyRoot = settings.servers.length === 0 && pluginItems.length === 0
        && snapshot.status !== 'loading' && pathname === MCP_COLLECTION_ROUTE;
    return (
        <PluginMcpServerItemsContext.Provider value={pluginItems}>
            <SettingsCollectionLayout
                navigator="mcp"
                rootPathname={MCP_COLLECTION_ROUTE}
                resolveChildRoute={resolveMcpChildRoute}
                rail={emptyRoot ? null : <McpServerRail />}
                railWidth="detailed"
                detailMinWidthPx={MCP_DETAIL_MIN_WIDTH_PX}
                testID="settings-mcp"
            />
        </PluginMcpServerItemsContext.Provider>
    );
});

const McpServerRail = React.memo(function McpServerRail() {
    const params = useGlobalSearchParams<{ serverId?: string | string[] }>();
    const serverId = Array.isArray(params.serverId) ? params.serverId[0] : params.serverId;
    return <McpServerCollection variant="rail" selectedServerId={serverId ?? null} />;
});
