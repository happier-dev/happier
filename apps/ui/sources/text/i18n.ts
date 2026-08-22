import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGE_CODES, SUPPORTED_LANGUAGES, getLanguageEnglishName, getLanguageNativeName, type SupportedLanguage } from './_all';
import type { Translations } from './_types';
import { getDeviceLocales } from './deviceLocales';
import { ca } from './translations/ca';
import { de } from './translations/de';
import { en } from './translations/en';
import { es } from './translations/es';
import { fr } from './translations/fr';
import { it } from './translations/it';
import { ja } from './translations/ja';
import { pl } from './translations/pl';
import { pt } from './translations/pt';
import { ru } from './translations/ru';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';
import {
    BUNDLED_PLUGIN_TRANSLATIONS,
    type BundledPluginTranslationKey,
} from './bundledPluginTranslations.generated';

export { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGE_CODES, SUPPORTED_LANGUAGES, getLanguageEnglishName, getLanguageNativeName, type SupportedLanguage };

type TranslationFunction = (...args: any[]) => string;
type TranslationLeaf = string | TranslationFunction;
type TranslationNode = Record<string, unknown>;

/**
 * Locale trees are held behind thunks, not as a module-scope object of the imported bindings.
 *
 * `metro.config.js` enables `inlineRequires`, which defers an imported binding's `require` to its
 * reference site — but a module-scope object literal *is* that reference, so the previous shape
 * evaluated every locale module (megabytes of source) as soon as anything imported `t()`, i.e.
 * before the app could paint. With thunks each locale's `require` is deferred to the first lookup
 * for that language: in practice the active language plus the English fallback.
 *
 * Where inline requires are not applied (vitest) the thunks are ordinary closures and behaviour is
 * identical, so this degrades gracefully if that Metro flag is ever turned off.
 */
const TRANSLATIONS_BY_LANGUAGE = {
    en: () => en,
    ru: () => ru,
    pl: () => pl,
    es: () => es,
    fr: () => fr,
    it: () => it,
    pt: () => pt,
    ca: () => ca,
    de: () => de,
    'zh-Hans': () => zhHans,
    'zh-Hant': () => zhHant,
    ja: () => ja,
} as const satisfies Record<SupportedLanguage, () => TranslationNode>;

type JoinPath<Prefix extends string, Key extends string> = Prefix extends '' ? Key : `${Prefix}.${Key}`;

type TranslationKeyFromStructure<T, Prefix extends string = ''> = {
    [K in keyof T & string]:
        NonNullable<T[K]> extends TranslationLeaf
            ? JoinPath<Prefix, K>
            : NonNullable<T[K]> extends TranslationNode
                ? TranslationKeyFromStructure<NonNullable<T[K]>, JoinPath<Prefix, K>>
                : never;
}[keyof T & string];

type TranslationValueAtPath<T, Key extends string> = Key extends `${infer Head}.${infer Tail}`
    ? Head extends keyof T
        ? TranslationValueAtPath<NonNullable<T[Head]>, Tail>
        : never
    : Key extends keyof T
        ? NonNullable<T[Key]>
        : never;

type HostTranslationKey = TranslationKeyFromStructure<Translations>;
export type TranslationKey = HostTranslationKey | BundledPluginTranslationKey;

type HostTranslationParams<K extends HostTranslationKey> =
    TranslationValueAtPath<Translations, K> extends (...args: infer Args) => string
        ? Args extends []
            ? never
            : Args[0]
        : never;

export type TranslationParams<K extends TranslationKey> =
    [Extract<K, HostTranslationKey>] extends [never]
        ? never
        : HostTranslationParams<Extract<K, HostTranslationKey>>;

export type TranslationKeyNoParams = {
    [K in TranslationKey]: TranslationParams<K> extends never ? K : never;
}[TranslationKey];

let preferredLanguageOverride: SupportedLanguage | null = null;
let cachedDeviceLanguage: SupportedLanguage | null = null;

function isTranslationFunction(value: unknown): value is TranslationFunction {
    return typeof value === 'function';
}

function isSupportedLanguage(value: string): value is SupportedLanguage {
    return (SUPPORTED_LANGUAGE_CODES as readonly string[]).includes(value);
}

function normalizeDeviceLanguageCode(languageCode: string | null | undefined, languageScriptCode: string | null | undefined): SupportedLanguage | null {
    if (typeof languageCode !== 'string') return null;

    const normalizedLanguageCode = languageCode.trim().toLowerCase();
    if (!normalizedLanguageCode) return null;

    if (normalizedLanguageCode === 'zh') {
        const normalizedScript = typeof languageScriptCode === 'string' ? languageScriptCode.trim().toLowerCase() : '';
        if (normalizedScript === 'hant') return 'zh-Hant';
        if (normalizedScript === 'hans') return 'zh-Hans';
        return 'zh-Hans';
    }

    return isSupportedLanguage(normalizedLanguageCode) ? normalizedLanguageCode : null;
}

function resolveLanguageFromDeviceLocales(): SupportedLanguage {
    if (cachedDeviceLanguage) return cachedDeviceLanguage;
    for (const locale of getDeviceLocales()) {
        const resolved = normalizeDeviceLanguageCode(locale.languageCode ?? null, locale.languageScriptCode ?? null);
        if (resolved) {
            cachedDeviceLanguage = resolved;
            return resolved;
        }
    }
    cachedDeviceLanguage = DEFAULT_LANGUAGE;
    return DEFAULT_LANGUAGE;
}

function resolveActiveLanguage(): SupportedLanguage {
    return preferredLanguageOverride ?? resolveLanguageFromDeviceLocales();
}

function getTranslationTree(language: SupportedLanguage): TranslationNode {
    const resolve = TRANSLATIONS_BY_LANGUAGE[language];
    return (resolve ? resolve() : en) as TranslationNode;
}

function getValueAtPath(root: TranslationNode, key: string): unknown {
    const parts = key.split('.').filter(Boolean);
    if (parts.length === 0) return undefined;

    let current: unknown = root;
    for (const part of parts) {
        if (!current || typeof current !== 'object') return undefined;
        current = (current as TranslationNode)[part];
    }
    return current;
}

function resolveRawTranslationValue(key: string): unknown {
    const activeLanguage = resolveActiveLanguage();
    const activeValue = getValueAtPath(getTranslationTree(activeLanguage) as TranslationNode, key);
    if (activeValue !== undefined) return activeValue;

    const englishValue = getValueAtPath(en as TranslationNode, key);
    if (englishValue !== undefined) return englishValue;

    const activePluginBundle = BUNDLED_PLUGIN_TRANSLATIONS[activeLanguage as keyof typeof BUNDLED_PLUGIN_TRANSLATIONS];
    const activePluginValue = (activePluginBundle as Readonly<Record<string, string>> | undefined)?.[key];
    if (activePluginValue !== undefined) return activePluginValue;

    return (BUNDLED_PLUGIN_TRANSLATIONS.en as Readonly<Record<string, string>> | undefined)?.[key];
}

function resolveStringValue(key: string): string {
    const value = resolveRawTranslationValue(key);
    if (typeof value === 'string') return value;
    return key;
}

function resolveCallableTranslation(key: TranslationKey): TranslationFunction | null {
    const value = resolveRawTranslationValue(key);
    return isTranslationFunction(value) ? value : null;
}

function collectTranslationKeys(node: TranslationNode, prefix = '', out: string[] = []): string[] {
    for (const [key, value] of Object.entries(node)) {
        const nextKey = prefix ? `${prefix}.${key}` : key;
        if (isTranslationFunction(value) || typeof value === 'string') {
            out.push(nextKey);
            continue;
        }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            collectTranslationKeys(value as TranslationNode, nextKey, out);
        }
    }
    return out;
}

/**
 * Computed on first use, not at module scope: this is a full recursive walk of the entire English
 * tree (and it forces that tree to be evaluated), and its only callers are development/diagnostic
 * surfaces — paying for it on the import that gates first paint bought nothing.
 */
let allTranslationKeysCache: TranslationKey[] | null = null;

function readAllTranslationKeys(): TranslationKey[] {
    if (!allTranslationKeysCache) {
        allTranslationKeysCache = [
            ...collectTranslationKeys(en as TranslationNode),
            ...Object.values(BUNDLED_PLUGIN_TRANSLATIONS).flatMap((bundle) => Object.keys(bundle)),
        ] as TranslationKey[];
    }
    return allTranslationKeysCache;
}

export function hasTranslation(key: string): boolean {
    return resolveRawTranslationValue(key) !== undefined;
}

export function getTranslationValue(key: string): unknown {
    return resolveRawTranslationValue(key);
}

export function getAllTranslationKeys(): TranslationKey[] {
    return [...readAllTranslationKeys()];
}

export function setPreferredLanguageFromSettings(value: unknown): void {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed && isSupportedLanguage(trimmed)) {
            preferredLanguageOverride = trimmed;
            return;
        }
    }
    preferredLanguageOverride = null;
}

export function getPreferredLanguage(): SupportedLanguage {
    return resolveActiveLanguage();
}

export function t<K extends TranslationKey>(
    key: K,
    ...params: TranslationParams<K> extends never ? [] : [params: TranslationParams<K>]
): string {
    const callable = resolveCallableTranslation(key);
    if (callable) {
        return callable(params[0] as never);
    }
    return resolveStringValue(key);
}

export function tLoose(key: string): string {
    return resolveStringValue(key);
}
