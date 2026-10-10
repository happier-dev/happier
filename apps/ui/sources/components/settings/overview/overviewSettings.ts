import { defineSettingsPage, settingsHosts } from '@/components/settings/catalog/settingDeclarations';

/**
 * The searchable rows of the Settings home. Its quick settings are shortcuts whose declarations
 * stay with their pages (Appearance, Notifications), so search opens the owning page.
 */
export const OVERVIEW_SETTINGS = defineSettingsPage({
    pageId: 'settings',
    sections: {
        about: {
            titleKey: 'settings.about',
            settings: {
                // What's new (build policy), Rate us (store review available) and Support us
                // (developer mode) are page state: search offers them and the About section answers.
                whatsNew: {},
                rateUs: {},
                supportUs: {},
                github: {},
                privacyPolicy: {},
                termsOfService: {},
                eula: { host: settingsHosts.ios },
                version: {},
            },
        },
    },
});
