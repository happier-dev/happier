import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGE_CODES, SUPPORTED_LANGUAGES, getLanguageEnglishName, getLanguageNativeName, type SupportedLanguage } from './_all';
import type { TranslationStructure, Translations } from './_types';
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

export { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGE_CODES, SUPPORTED_LANGUAGES, getLanguageEnglishName, getLanguageNativeName, type SupportedLanguage };

/**
 * Locale trees are ~0.5 MB of source each and only one of them is ever the active language, yet
 * every one of them used to be materialized before the app could paint.
 *
 * Metro runs with `inlineRequires` enabled (`apps/ui/metro.config.js`), which moves an imported
 * binding's `require` to the place the binding is referenced — but a module-scope `{ en, ru, ... }`
 * map is itself such a reference, so importing `t()` evaluated all ten locale modules at import
 * time. Referencing each tree from inside a thunk defers its `require` to the first lookup for that
 * language, which in practice means the active language and the English fallback. Where inline
 * requires are not applied (vitest), the thunks are ordinary closures and behaviour is unchanged.
 */
const TRANSLATION_TREE_BY_LANGUAGE = {
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
} satisfies Record<SupportedLanguage, () => TranslationStructure>;

type TranslationFunction = (params: never) => string;
type TranslationLeaf = string | TranslationFunction;
type TranslationNode = Record<string, unknown>;

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

export type TranslationKey = TranslationKeyFromStructure<Translations>;

export type TranslationParams<K extends TranslationKey> =
    TranslationValueAtPath<Translations, K> extends (...args: infer Args) => string
        ? Args extends []
            ? never
            : Args[0]
        : never;

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

function getTranslationTree(language: SupportedLanguage): Translations {
    const loadTranslationTree = TRANSLATION_TREE_BY_LANGUAGE[language];
    return loadTranslationTree ? loadTranslationTree() : en;
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

    return getValueAtPath(en as TranslationNode, key);
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

export function hasTranslation(key: string): boolean {
    return resolveRawTranslationValue(key) !== undefined;
}

export function getTranslationValue(key: string): unknown {
    return resolveRawTranslationValue(key);
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
