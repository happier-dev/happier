import type { SupportedLanguage } from './_all';

import { mcpServersUxTranslationExtension } from './translations/mcpServersUxExtension';
import { newSessionMcpTranslationExtensions } from './translations/newSessionMcpExtension';
import { promptLibraryUxRefinementTranslationExtension } from './translations/promptLibraryUxRefinementExtension';

import { acpCatalogTranslationExtensions, type AcpCatalogTranslationExtension } from './extensions/acpCatalog';
import { providerAuthenticationTranslationExtensions, type ProviderAuthenticationTranslationExtension } from './extensions/providerAuth';
import { settingsAppearanceTranslationExtensions, type SettingsAppearanceTranslationExtension } from './extensions/appearance';
import { sessionHandoffTranslationExtensions, type SessionHandoffTranslationExtension, type SettingsSessionHandoffTranslationExtension } from './extensions/sessionHandoff';
import { memorySearchSettingsTranslationExtensions, type MemorySearchSettingsTranslationExtension } from './extensions/memory';

type NewSessionTranslationExtension = {
    readonly newSession: (typeof newSessionMcpTranslationExtensions)['en'];
};

type McpServersTranslationExtension = {
    readonly mcpServers: typeof mcpServersUxTranslationExtension;
};

type PromptLibraryTranslationExtension = {
    readonly promptLibrary: (typeof promptLibraryUxRefinementTranslationExtension)['es'];
};

type TranslationExtensionShape = NewSessionTranslationExtension &
    McpServersTranslationExtension &
    PromptLibraryTranslationExtension &
    AcpCatalogTranslationExtension &
    ProviderAuthenticationTranslationExtension &
    SettingsAppearanceTranslationExtension &
    SessionHandoffTranslationExtension &
    SettingsSessionHandoffTranslationExtension &
    MemorySearchSettingsTranslationExtension;

declare module './i18n' {
    interface TranslationExtensionMap extends TranslationExtensionShape {}
}

function mergeLanguageExtensions(language: SupportedLanguage): Partial<TranslationExtensionShape> {
    return {
        newSession: { ...newSessionMcpTranslationExtensions[language] },
        mcpServers: { ...mcpServersUxTranslationExtension },
        promptLibrary: { ...(promptLibraryUxRefinementTranslationExtension[language] ?? {}) },
        ...acpCatalogTranslationExtensions[language],
        ...providerAuthenticationTranslationExtensions[language],
        ...settingsAppearanceTranslationExtensions[language],
        ...sessionHandoffTranslationExtensions[language],
        ...memorySearchSettingsTranslationExtensions[language],
    };
}

export const translationExtensions = Object.fromEntries(
    (Object.keys(acpCatalogTranslationExtensions) as SupportedLanguage[]).map((language) => [language, mergeLanguageExtensions(language)]),
) as Record<SupportedLanguage, Partial<TranslationExtensionShape>>;

export type { TranslationExtensionShape as TranslationExtensionsShape };
