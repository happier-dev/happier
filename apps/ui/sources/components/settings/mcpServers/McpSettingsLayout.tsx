import * as React from 'react';
import { useGlobalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';

import { resolveSettingsNestedRouteName } from '@/components/settings/navigation/settingsRouteRegistry';
import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

import { McpServerCollection } from './collection/McpServerCollection';
import { MCP_COLLECTION_ROUTE } from './collection/mcpServerCollectionModel';
import { useMcpServersSettings } from './useMcpServersSettings';

/** Rail width at normal text scale: a transport mark, a server name and where it applies. */
const MCP_RAIL_WIDTH_PX = 272;
/** The narrowest detail that still fits a command field beside its label. */
const MCP_DETAIL_MIN_WIDTH_PX = 480;

function resolveMcpChildRoute(pathname: string): string {
    return resolveSettingsNestedRouteName('mcp', pathname) ?? 'index';
}

/**
 * MCP servers as a collection beside the selected detail: a server's editor, a new server, or one of
 * the two machine tools. Narrow: the list page pushes each detail. Absent while `mcp.servers` is off.
 */
export const McpSettingsLayout = React.memo(function McpSettingsLayout() {
    const enabled = useFeatureEnabled('mcp.servers');
    const pathname = usePathname().replace(/\/+$/, '');
    const { settings } = useMcpServersSettings();
    if (!enabled) return null;
    return (
        <SettingsCollectionLayout
            navigator="mcp"
            rootPathname={MCP_COLLECTION_ROUTE}
            resolveChildRoute={resolveMcpChildRoute}
            rail={settings.servers.length === 0 && pathname === MCP_COLLECTION_ROUTE ? null : <McpServerRail />}
            railWidthPx={MCP_RAIL_WIDTH_PX}
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
