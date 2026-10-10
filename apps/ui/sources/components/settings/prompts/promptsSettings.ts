import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/**
 * The searchable destinations of the Prompts & Skills page. Templates, folders, system prompt
 * additions, registries and external assets are catalog pages of their own, so search finds them as
 * pages; the two collections without a catalog page are declared here.
 */
export const PROMPTS_SETTINGS = defineSettingsPage({
    pageId: 'prompts',
    sections: {
        library: {
            titleKey: 'promptLibrary.library',
            settings: {
                skills: {},
            },
        },
    },
});
