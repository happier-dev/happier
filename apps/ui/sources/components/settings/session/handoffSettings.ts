import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of the `handoff` page. Rows render their labels from these declarations. */
export const HANDOFF_SETTINGS = defineSettingsPage({
    pageId: 'handoff',
    sections: {
        workspace: {
            titleKey: 'settingsSessionPages.handoff.workspaceSection',
            settings: {
                workspaceMode: {},
                mode: {},
                includeIgnoredMode: {},
                // Rendered while ignored files are "Include selected".
                ignoredIncludeGlobs: {},
            },
        },
        directSessions: {
            titleKey: 'settingsSession.handoff.directTargetMode.groupTitle',
            settings: {
                directTargetMode: {},
            },
        },
    },
});
