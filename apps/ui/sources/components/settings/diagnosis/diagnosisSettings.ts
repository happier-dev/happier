import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of the `diagnosis` page. Rows render their labels from these declarations. */
export const DIAGNOSIS_SETTINGS = defineSettingsPage({
    pageId: 'diagnosis',
    sections: {
        overview: {
            titleKey: 'diagnosis.sections.overview',
            settings: {
                activeServer: {},
            },
        },
        page: {
            settings: {
                copyReport: {},
            },
        },
    },
});
