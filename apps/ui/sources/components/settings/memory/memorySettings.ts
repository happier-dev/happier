import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of the `memory` page. Rows render their labels from these declarations. */
export const MEMORY_SETTINGS = defineSettingsPage({
    pageId: 'memory',
    sections: {
        localIndex: {
            titleKey: 'memorySearchSettings.enabled.sectionTitle',
            settings: {
                enabled: {},
            },
        },
        indexing: {
            titleKey: 'memorySearchSettings.indexing.title',
            settings: {
                indexMode: {},
                backfill: {},
                coverage: {},
                include: {},
            },
        },
        contentPolicy: {
            titleKey: 'memorySearchSettings.contentPolicy.title',
            settings: {
                userMessages: {},
                assistantMessages: {},
                reasoning: {},
                toolSummaries: {},
            },
        },
        // Deep mode only; the custom rows also depend on the chosen provider. When a row is not shown,
        // search reveals this section (or the Index mode row that leads to it).
        embeddings: {
            titleKey: 'memorySearchSettings.embeddings.groupTitle',
            settings: {
                embeddingsMode: {},
                embeddingsProvider: {},
                localModel: {},
                queryPrefix: {},
                documentPrefix: {},
                baseUrl: {},
                remoteModel: {},
                apiKey: {},
                dimensions: {},
                textWeight: {},
                embeddingWeight: {},
            },
        },
        hints: {
            titleKey: 'memorySearchSettings.hints.title',
            settings: {
                summarizerBackend: {},
                summarizerModel: {},
                permissions: {},
            },
        },
        budgets: {
            titleKey: 'memorySearchSettings.budgets.groupTitle',
            settings: {
                lightBudget: {},
                deepBudget: {},
            },
        },
        privacy: {
            titleKey: 'memorySearchSettings.privacy.groupTitle',
            settings: {
                deleteOnDisable: {},
            },
        },
    },
});
