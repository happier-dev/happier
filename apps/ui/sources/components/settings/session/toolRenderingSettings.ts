import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/**
 * The searchable settings of the `toolRendering` page. Its rows are one per tool (named by the tool
 * catalog), so each section is declared once and its anchor marks the whole section.
 */
export const TOOL_RENDERING_SETTINGS = defineSettingsPage({
    pageId: 'toolRendering',
    sections: {
        collapsed: {
            titleKey: 'settingsSession.toolDetailOverrides.title',
            settings: {
                collapsedOverrides: {},
            },
        },
        expanded: {
            titleKey: 'settingsSession.toolDetailOverrides.expandedTitle',
            settings: {
                expandedOverrides: {},
            },
        },
    },
});
