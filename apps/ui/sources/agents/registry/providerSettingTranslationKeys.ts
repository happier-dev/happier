export const providerSettingTranslationKeyPrefixes = {
    claude: 'settingsProviders.plugins.claude',
    codex: 'settingsProviders.plugins.codex',
    opencode: 'settingsProviders.plugins.opencode',
    gemini: 'settingsProviders.plugins.gemini',
    kiro: 'settingsProviders.plugins.kiro',
} as const;

export type ProviderSettingTranslationKeyPrefixMap = typeof providerSettingTranslationKeyPrefixes;
