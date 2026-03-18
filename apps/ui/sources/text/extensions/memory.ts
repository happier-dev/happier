import type { SupportedLanguage } from '../_all';

const baseMemorySearchSettingsTranslationExtension = {
    status: {
        embeddingsTitle: 'Embeddings runtime',
        embeddingsProviderTitle: 'Embeddings provider',
        embeddingsModelTitle: 'Embeddings model',
        embeddingsDisabled: 'Embeddings are disabled',
        embeddingsReady: 'Embeddings are ready',
        embeddingsDownloading: 'Embedding model is downloading',
        embeddingsFallback: 'Embeddings unavailable, using text-only fallback',
        embeddingsUnavailable: 'Embeddings unavailable',
        embeddingsError: 'Embeddings failed to initialize',
        embeddingsProviderLocal: 'Local model',
        embeddingsProviderOpenAiCompatible: 'OpenAI-compatible endpoint',
    },
    embeddings: {
        groupTitle: 'Embeddings',
        groupFooter:
            'Optional: improve deep-search ranking with either a local model or your own OpenAI-compatible endpoint.',
        mode: {
            title: 'Embeddings mode',
            options: {
                disabledTitle: 'Off',
                disabledSubtitle: 'Use text-only ranking for deep search',
                balancedTitle: 'Balanced',
                balancedSubtitle: 'Fast validated local preset',
                longContextTitle: 'Long context',
                longContextSubtitle: 'Better for larger conversation chunks',
                qualityTitle: 'Quality',
                qualitySubtitle: 'Higher-cost local preset for evaluation',
                customTitle: 'Custom',
                customSubtitle: 'Choose your own provider and model',
            },
        },
        provider: {
            title: 'Provider',
            options: {
                localTitle: 'Local model',
                localSubtitle: 'Managed by Happier and downloaded on first use',
                openAiCompatibleTitle: 'OpenAI-compatible endpoint',
                openAiCompatibleSubtitle: 'Use your own embeddings server and API key',
            },
        },
        notSet: 'Not set',
        secretSet: 'Set',
        secretNotSet: 'Not set',
        queryPrefixTitle: 'Query prefix',
        queryPrefixPromptBody: 'Optional prefix prepended to user search queries before embedding.',
        documentPrefixTitle: 'Document prefix',
        documentPrefixPromptBody: 'Optional prefix prepended to indexed memory chunks before embedding.',
        openAi: {
            baseUrlTitle: 'Base URL',
            baseUrlPromptBody: 'Enter the base URL for your OpenAI-compatible embeddings endpoint.',
            modelTitle: 'Remote model',
            modelPromptBody: 'Enter the embeddings model id to request from the remote endpoint.',
            apiKeyTitle: 'API key',
            apiKeyPromptBody: 'Enter the API key used for the remote embeddings endpoint.',
            dimensionsTitle: 'Dimensions',
            dimensionsPromptBody: 'Optional output dimension override for endpoints that support it.',
        },
        advanced: {
            ftsWeightTitle: 'Text ranking weight',
            ftsWeightPromptBody: 'Relative weight for SQLite full-text ranking when blending results.',
            embeddingWeightTitle: 'Embeddings ranking weight',
            embeddingWeightPromptBody: 'Relative weight for embeddings similarity when blending results.',
        },
    },
} as const;

export const memorySearchSettingsTranslationExtensions: Record<
    SupportedLanguage,
    {
        readonly memorySearchSettings: typeof baseMemorySearchSettingsTranslationExtension;
    }
> = {
    en: { memorySearchSettings: baseMemorySearchSettingsTranslationExtension },
    ca: { memorySearchSettings: baseMemorySearchSettingsTranslationExtension },
    es: { memorySearchSettings: baseMemorySearchSettingsTranslationExtension },
    it: { memorySearchSettings: baseMemorySearchSettingsTranslationExtension },
    ja: { memorySearchSettings: baseMemorySearchSettingsTranslationExtension },
    pl: { memorySearchSettings: baseMemorySearchSettingsTranslationExtension },
    pt: { memorySearchSettings: baseMemorySearchSettingsTranslationExtension },
    ru: { memorySearchSettings: baseMemorySearchSettingsTranslationExtension },
    'zh-Hans': { memorySearchSettings: baseMemorySearchSettingsTranslationExtension },
    'zh-Hant': { memorySearchSettings: baseMemorySearchSettingsTranslationExtension },
};

export type MemorySearchSettingsTranslationExtension = (typeof memorySearchSettingsTranslationExtensions)['en'];
