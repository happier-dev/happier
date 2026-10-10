import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of the `systemStatus` page. Rows render their labels from these declarations. */
export const SYSTEM_STATUS_SETTINGS = defineSettingsPage({
    pageId: 'systemStatus',
    sections: {
        currentServer: {
            titleKey: 'systemStatus.sections.currentServer',
            settings: {
                activeHomeHealth: {},
            },
        },
        page: {
            settings: {
                copyJson: {},
            },
        },
    },
});
