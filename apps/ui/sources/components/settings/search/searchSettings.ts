import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of the `search` page. Rows render their labels from these declarations. */
export const SEARCH_SETTINGS = defineSettingsPage({
    pageId: 'search',
    sections: {
        modes: {
            titleKey: 'conversationSearch.modesTitle',
            settings: {
                standardSearch: {},
                memorySearch: {},
            },
        },
        // The rows below the switch exist only while it is on, and the Agents are a sheet of their own
        // right under it; search reveals this section for them.
        external: {
            titleKey: 'conversationSearch.externalTitle',
            settings: {
                indexExternal: {},
                agents: {},
                history: {},
                toolOutput: {},
            },
        },
        index: {
            titleKey: 'conversationSearch.indexTitle',
            settings: {
                clearIndex: {},
            },
        },
    },
});
