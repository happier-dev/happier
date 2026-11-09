import * as React from 'react';
import { useGlobalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';

import { resolveSettingsNestedRouteName } from '@/components/settings/navigation/settingsRouteRegistry';
import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';

import { McpServerCollection } from './collection/McpServerCollection';
import { MCP_COLLECTION_ROUTE } from './collection/mcpServerCollectionModel';
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
    return (
        <SettingsCollectionLayout
            navigator="mcp"
            rootPathname={MCP_COLLECTION_ROUTE}
            resolveChildRoute={resolveMcpChildRoute}
            // The rail holds its column from first paint; only an answered, empty catalog on the root has none.
            rail={settings.servers.length === 0 && snapshot.status !== 'loading' && pathname === MCP_COLLECTION_ROUTE ? null : <McpServerRail />}
            railWidth="detailed"
            detailMinWidthPx={MCP_DETAIL_MIN_WIDTH_PX}
            testID="settings-mcp"
        />
    );
});

const McpServerRail = React.memo(function McpServerRail() {
    const params = useGlobalSearchParams<{ serverId?: string | string[] }>();
    const serverId = Array.isArray(params.serverId) ? params.serverId[0] : params.serverId;
    return <McpServerCollection variant="rail" selectedServerId={serverId ?? null} />;
});
