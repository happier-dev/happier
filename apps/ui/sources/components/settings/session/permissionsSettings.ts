import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of the `permissions` page. Rows render their labels from these declarations. */
export const PERMISSIONS_SETTINGS = defineSettingsPage({
    pageId: 'permissions',
    sections: {
        defaults: {
            titleKey: 'settingsSession.defaultPermissions.title',
            settings: {
                /** One row per enabled agent; the anchor marks the whole section. */
                defaultPermissions: {},
            },
        },
        duringSession: {
            titleKey: 'settingsSessionPages.permissions.duringSessionSection',
            settings: {
                promptSurface: {},
                applyPermissionChanges: {},
            },
        },
        defaultStorage: {
            titleKey: 'settingsSession.defaultStorage.title',
            featureId: 'sessions.direct',
            settings: {
                global: {},
            },
        },
    },
});
