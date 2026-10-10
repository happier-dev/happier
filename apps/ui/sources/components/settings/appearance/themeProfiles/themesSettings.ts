import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

/** The searchable settings of Appearance › Themes. Theme names find the mode sections. */
export const THEMES_SETTINGS = defineSettingsPage({
    pageId: 'appearance',
    subpage: { id: 'themes', route: SETTINGS_ROUTES.appearanceThemes, titleKey: 'settingsAppearance.themeProfiles.title' },
    sections: {
        lightMode: {
            titleKey: 'settingsAppearance.themeProfiles.lightModeSection',
            settings: {
                lightTheme: {},
            },
        },
        darkMode: {
            titleKey: 'settingsAppearance.themeProfiles.darkModeSection',
            settings: {
                darkTheme: {},
            },
        },
        yourThemes: {
            titleKey: 'settingsAppearance.themeProfiles.yourThemes',
            settings: {
                yourThemes: {},
            },
        },
    },
});
