import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** Searchable collection actions; connection-specific controls belong to the selected detail. */
export const PROVIDERS_SETTINGS = defineSettingsPage({
    pageId: 'providers',
    sections: {
        connections: {
            titleKey: 'settingsProviders.configuredTitle',
            settings: {
                connections: {},
                add: {},
                custom: {},
            },
        },
        local: {
            titleKey: 'settingsProviders.local.title',
            featureId: 'providers.localDiscovery',
            settings: {
                local: {},
            },
        },
    },
});
