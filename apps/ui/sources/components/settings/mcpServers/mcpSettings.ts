import { matchWorkspaceDestinationRoute } from '@/components/appShell/workspace/workspaceRoutes';
import { defineSettingsPage, type SettingsRouteContext } from '@/components/settings/catalog/settingDeclarations';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

/** Found is a collection destination, so search opens its canonical page directly. */
export const MCP_FOUND_DESTINATION_SETTINGS = defineSettingsPage({
    pageId: 'mcp',
    subpage: { id: 'found', route: SETTINGS_ROUTES.mcpFound, titleKey: 'capabilities.mcp.foundOnMachines', anchors: 'page' },
    sections: { destinations: { settings: { found: {} } } },
});

function selectedMcpServerRoute({ pathname }: SettingsRouteContext): string | null {
    return matchWorkspaceDestinationRoute(pathname)?.routeKey === 'settings/mcp/[serverId]' ? pathname : null;
}

/** Tool loading is a server entity setting. Its feature and Action binding come from Protocol. */
export const MCP_SERVER_DETAIL_SETTINGS = defineSettingsPage({
    pageId: 'mcp',
    subpage: { id: 'detail', route: selectedMcpServerRoute, titleKey: 'settings.mcpServersEditorTitle' },
    sections: { tools: { settings: { loading: {} } } },
});
