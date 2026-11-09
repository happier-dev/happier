import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

/** Found is a collection destination, so search opens its canonical page directly. */
export const MCP_FOUND_DESTINATION_SETTINGS = defineSettingsPage({
    pageId: 'mcp',
    subpage: { id: 'found', route: SETTINGS_ROUTES.mcpFound, titleKey: 'capabilities.mcp.foundOnMachines', anchors: 'page' },
    sections: { destinations: { settings: { found: {} } } },
});
