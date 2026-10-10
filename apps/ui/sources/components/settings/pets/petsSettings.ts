import { defineSettingsPage, settingsHosts } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of the `pets` page. Rows render their labels from these declarations. */
export const PETS_SETTINGS = defineSettingsPage({
    pageId: 'pets',
    sections: {
        account: {
            titleKey: 'settingsPets.accountTitle',
            settings: {
                enabled: {},
                deviceOverride: {},
                companionSize: {},
            },
        },
        codexPets: {
            titleKey: 'settingsPets.codexPetsTitle',
            settings: {
                detectCodexPets: {},
            },
        },
        desktopOverlay: {
            titleKey: 'settingsPets.desktopOverlayTitle',
            host: settingsHosts.desktop,
            settings: {
                desktopOverlayEnabled: {},
                desktopOverlayDeviceOverride: {},
                desktopOverlayVisibilityMode: {},
            },
        },
    },
});
