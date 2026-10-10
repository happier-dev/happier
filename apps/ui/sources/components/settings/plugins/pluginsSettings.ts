import { defineSettingsPage, settingsHosts } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of the `plugins` page. Rows render their labels from these declarations. */
export const PLUGINS_SETTINGS = defineSettingsPage({
    pageId: 'plugins',
    sections: {
        updates: {
            titleKey: 'settingsPlugins.surfaces.updatesTitle',
            settings: {
                updateReview: {},
            },
        },
        // Native apps only, and only while a plugin offers an app panel (page state).
        appPanels: {
            host: settingsHosts.native,
            settings: {
                appPanels: {},
            },
        },
        more: {
            titleKey: 'settingsPlugins.surfaces.forDevelopers',
            settings: {
                sourceAdministration: {},
                development: {},
                diagnostics: {},
            },
        },
        moreWebhooks: {
            titleKey: 'settingsPlugins.surfaces.forDevelopers',
            featureId: 'plugins.webhooks',
            settings: {
                webhookAdministration: {},
            },
        },
    },
});
