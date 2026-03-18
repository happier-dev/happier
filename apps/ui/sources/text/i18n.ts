import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGE_CODES, getLanguageEnglishName, getLanguageNativeName, type SupportedLanguage } from './_all';
import type { Translations, TranslationStructure } from './_types';
import { ca } from './translations/ca';
import { en } from './translations/en';
import { es } from './translations/es';
import { it } from './translations/it';
import { ja } from './translations/ja';
import { pl } from './translations/pl';
import { pt } from './translations/pt';
import { ru } from './translations/ru';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';

type NestedKeys<T, Path extends string = ''> = T extends object
    ? {
          [K in keyof T]: K extends string
              ? T[K] extends string | ((...args: never[]) => string)
                  ? Path extends ''
                      ? K
                      : `${Path}.${K}`
                  : NestedKeys<T[K], Path extends '' ? K : `${Path}.${K}`>
              : never;
      }[keyof T]
    : never;

type GetValue<T, Path> = Path extends `${infer Key}.${infer Rest}`
    ? Key extends keyof T
        ? GetValue<T[Key], Rest>
        : never
    : Path extends keyof T
        ? T[Path]
        : never;

type GetParams<V> = V extends (params: infer P) => string ? P : V extends string ? void : never;

export interface TranslationExtensionMap {}

type RuntimeTranslations = Translations & TranslationExtensionMap;

export type TranslationKey = NestedKeys<RuntimeTranslations>;
export type TranslationParams<K extends TranslationKey> = GetParams<GetValue<RuntimeTranslations, K>>;
export type TranslationKeyNoParams = {
    [K in TranslationKey]: TranslationParams<K> extends void ? K : never;
}[TranslationKey];

export type { SupportedLanguage } from './_all';
export { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGE_CODES, getLanguageEnglishName, getLanguageNativeName } from './_all';

type TranslationExtensionBundle = Partial<Record<SupportedLanguage, Partial<RuntimeTranslations>>>;

const baseTranslations: Record<SupportedLanguage, TranslationStructure> = {
    en,
    ru,
    pl,
    es,
    it,
    pt,
    ca,
    'zh-Hans': zhHans,
    'zh-Hant': zhHant,
    ja,
};

const supportedLanguageLookup = new Map(
    SUPPORTED_LANGUAGE_CODES.map((language) => [language.toLowerCase(), language] as const),
);

let currentLanguage: SupportedLanguage | null = null;
let translations: Record<SupportedLanguage, RuntimeTranslations> | null = null;

function getTranslations(): Record<SupportedLanguage, RuntimeTranslations> {
    if (translations) return translations;
    const extensionBundle = loadTranslationExtensions();
    translations = Object.fromEntries(
        SUPPORTED_LANGUAGE_CODES.map((language) => [
            language,
            {
                ...baseTranslations[language],
                ...(extensionBundle[language] ?? {}),
            },
        ]),
    ) as Record<SupportedLanguage, RuntimeTranslations>;
    return translations;
}

function loadTranslationExtensions(): TranslationExtensionBundle {
    try {
        const loaded = require('./translationExtensions') as {
            translationExtensions?: TranslationExtensionBundle;
        };
        return loaded.translationExtensions ?? {};
    } catch {
        return {};
    }
}

function normalizeLanguageCode(languageCode: string | null | undefined): string | null {
    const normalized = String(languageCode ?? '').trim();
    if (!normalized) return null;
    return normalized.replace('_', '-').toLowerCase();
}

function resolveSupportedLanguage(languageCode: string | null | undefined): SupportedLanguage | null {
    const normalized = normalizeLanguageCode(languageCode);
    if (!normalized) return null;
    return supportedLanguageLookup.get(normalized) ?? null;
}

function resolveLocaleLanguage(languageCode: string | null | undefined, languageScriptCode: string | null | undefined): SupportedLanguage | null {
    const normalizedLanguageCode = normalizeLanguageCode(languageCode);
    if (!normalizedLanguageCode) return null;

    if (normalizedLanguageCode === 'zh') {
        return languageScriptCode === 'Hant' ? 'zh-Hant' : 'zh-Hans';
    }

    return resolveSupportedLanguage(normalizedLanguageCode);
}

function readPreferredLanguageFromSettings(): SupportedLanguage | null {
    try {
        const { loadSettings } = require('@/sync/domains/state/persistence') as typeof import('@/sync/domains/state/persistence');
        return resolveSupportedLanguage(loadSettings().settings.preferredLanguage);
    } catch {
        return null;
    }
}

function resolveInitialLanguage(): SupportedLanguage {
    const preferredLanguage = readPreferredLanguageFromSettings();
    if (preferredLanguage) return preferredLanguage;

    try {
        const { getDeviceLocales } = require('./deviceLocales') as typeof import('./deviceLocales');
        for (const locale of getDeviceLocales()) {
            const resolved = resolveLocaleLanguage(locale.languageCode, locale.languageScriptCode);
            if (resolved) return resolved;
        }
    } catch {
        // Fall back to the default language.
    }

    return DEFAULT_LANGUAGE;
}

function getResolvedCurrentLanguage(): SupportedLanguage {
    if (currentLanguage) return currentLanguage;
    currentLanguage = resolveInitialLanguage();
    return currentLanguage;
}

function resolveTranslationValue(key: string): unknown | undefined {
    const currentTranslations = getTranslations()[getResolvedCurrentLanguage()];
    const segments = key.split('.');
    let value: unknown = currentTranslations;

    for (const segment of segments) {
        if (value === null || typeof value !== 'object') return undefined;
        value = (value as Record<string, unknown>)[segment];
        if (value === undefined) return undefined;
    }

    return value;
}

export function t<K extends TranslationKey>(
    key: K,
    ...args: GetParams<GetValue<RuntimeTranslations, K>> extends void ? [] : [GetParams<GetValue<RuntimeTranslations, K>>]
): string {
    try {
        const value = resolveTranslationValue(key);
        if (value === undefined) {
            console.warn(`Translation missing: ${key}`);
            return key;
        }

        if (typeof value === 'function') {
            return value(args[0]);
        }

        if (typeof value === 'string') {
            return value;
        }

        console.warn(`Invalid translation value type for key: ${key}`);
        return key;
    } catch (error) {
        console.error(`Translation error for key: ${key}`, error);
        return key;
    }
}

export function tLoose(key: TranslationKey, params?: unknown): string {
    try {
        const value = resolveTranslationValue(key);
        if (value === undefined) {
            console.warn(`Translation missing: ${key}`);
            return key;
        }

        if (typeof value === 'function') {
            return value(params);
        }

        if (typeof value === 'string') {
            return value;
        }

        console.warn(`Invalid translation value type for key: ${key}`);
        return key;
    } catch (error) {
        console.error(`Translation error for key: ${key}`, error);
        return key;
    }
}

export function getCurrentLanguage(): SupportedLanguage {
    return getResolvedCurrentLanguage();
}
