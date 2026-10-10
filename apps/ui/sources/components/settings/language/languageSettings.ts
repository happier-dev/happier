import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of the `language` page. The language list renders under this declaration. */
export const LANGUAGE_SETTINGS = defineSettingsPage({
    pageId: 'language',
    sections: {
        appLanguage: {
            titleKey: 'settingsLanguage.appLanguageTitle',
            settings: {
                // Changing language also owns confirmation and app reload; generic Actions only read it.
                appLanguage: {},
            },
        },
    },
});
