import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

/**
 * The searchable settings of the MCP collection. Servers are collection items, not settings; the
 * settings live on the collection's two tool pages, each declared as a sub-page of `mcp`.
 */
export const MCP_ON_MACHINE_SETTINGS = defineSettingsPage({
    pageId: 'mcp',
    subpage: { id: 'onMachine', route: SETTINGS_ROUTES.mcpOnMachine, titleKey: 'mcpSettings.onMachineTitle' },
    sections: {
        mcpServersDetected: {
            titleKey: 'mcpSettings.onMachineSearchSection',
            settings: {
                mcpServersDetectedDirectory: {},
            },
        },
    },
});

export const MCP_PREVIEW_SETTINGS = defineSettingsPage({
    pageId: 'mcp',
    subpage: { id: 'preview', route: SETTINGS_ROUTES.mcpPreview, titleKey: 'mcpSettings.previewTitle' },
    sections: {
        mcpServersSegmentPreview: {
            titleKey: 'mcpSettings.previewContextSection',
            settings: {
                mcpServersPreviewAgent: {},
                mcpServersPreviewDirectory: {},
            },
        },
        mcpServersReliability: {
            titleKey: 'mcpSettings.failureSection',
            settings: {
                mcpServersStrictMode: {},
            },
        },
    },
});
