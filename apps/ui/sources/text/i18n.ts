import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGE_CODES, SUPPORTED_LANGUAGES, getLanguageEnglishName, getLanguageNativeName, type SupportedLanguage } from './_all';
import type { Translations } from './_types';
import { commitPreferredLanguage, getPreferredLanguage, normalizePreferredLanguage, resolveLanguageFromDeviceLocales } from './preferredLanguage';
import { preloadLocaleBundle, readLocaleBundle } from './localeBundlesSync';
import { BUNDLED_PLUGIN_TRANSLATION_KEYS, type BundledPluginTranslationKey } from './bundledPluginTranslationKeys.generated';

export { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGE_CODES, SUPPORTED_LANGUAGES, getLanguageEnglishName, getLanguageNativeName, type SupportedLanguage };
export { getPreferredLanguage, resolveSupportedLanguageFromTag, subscribePreferredLanguage } from './preferredLanguage';

type TranslationFunction = (...args: any[]) => string;
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

let requestedLanguageOverride: SupportedLanguage | null = null;

function isTranslationFunction(value: unknown): value is TranslationFunction {
    return typeof value === 'function';
}

function getTranslationTree(language: SupportedLanguage): TranslationNode {
    return readLocaleBundle(language)?.host ?? {};
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
    const activeLanguage = getPreferredLanguage();
    const activeValue = getValueAtPath(getTranslationTree(activeLanguage) as TranslationNode, key);
    if (activeValue !== undefined) return activeValue;

    const englishValue = getValueAtPath(getTranslationTree(DEFAULT_LANGUAGE), key);
    if (englishValue !== undefined) return englishValue;

    const activePluginBundle = readLocaleBundle(activeLanguage)?.plugins;
    const activePluginValue = (activePluginBundle as Readonly<Record<string, string>> | undefined)?.[key];
    if (activePluginValue !== undefined) return activePluginValue;

    return readLocaleBundle(DEFAULT_LANGUAGE)?.plugins[key];
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
            ...collectTranslationKeys(getTranslationTree(DEFAULT_LANGUAGE)),
            ...BUNDLED_PLUGIN_TRANSLATION_KEYS,
        ] as TranslationKey[];
    }
    return allTranslationKeysCache;
}

export function hasTranslation(key: string): boolean {
    return resolveRawTranslationValue(key) !== undefined;
}

export function getTranslationValue(key: string, language?: SupportedLanguage): unknown {
    // Explicit language lookups must not silently substitute the active UI or English locale.
    if (language) return getValueAtPath(getTranslationTree(language), key);
    return resolveRawTranslationValue(key);
}

export function getAllTranslationKeys(): TranslationKey[] {
    return [...readAllTranslationKeys()];
}

export function setPreferredLanguageFromSettings(value: unknown): void {
    requestedLanguageOverride = normalizePreferredLanguage(value);
    const language = requestedLanguageOverride ?? resolveLanguageFromDeviceLocales();
    // An unloaded web chunk must never replace the current translated UI with fallback copy.
    if (readLocaleBundle(language)) commitPreferredLanguage(requestedLanguageOverride);
}

/** Explicit requests (such as a voice language) load copy without changing the UI locale. */
export async function preloadTranslations(language?: SupportedLanguage): Promise<void> {
    if (language) {
        await preloadLocaleBundle(language);
        return;
    }
    // Settings can change while a chunk is in flight. Boot exposes only the latest selected locale.
    for (;;) {
        const requested = requestedLanguageOverride;
        const selected = requested ?? resolveLanguageFromDeviceLocales();
        await preloadLocaleBundle(selected);
        if (requestedLanguageOverride !== requested) continue;
        commitPreferredLanguage(requested);
        return;
    }
}

export async function preloadTranslationsForSettings(value: unknown): Promise<void> {
    await preloadLocaleBundle(normalizePreferredLanguage(value) ?? resolveLanguageFromDeviceLocales());
}

export function areTranslationsReadyForSettings(value: unknown): boolean {
    return readLocaleBundle(normalizePreferredLanguage(value) ?? resolveLanguageFromDeviceLocales()) !== undefined;
}

/**
 * Common nouns that stand in for a name inside sentences ("this machine" while a machine's details are
 * locked). Mid-sentence they keep the locale's lowercase; a sentence that starts with one capitalizes it.
 */
const SENTENCE_COMMON_NOUN_KEYS = ['machine.thisMachineInSentence'] as const;

function capitalizeLeadingCommonNoun(text: string, params: unknown): string {
    if (!params || typeof params !== 'object') return text;
    for (const nounKey of SENTENCE_COMMON_NOUN_KEYS) {
        const noun = resolveStringValue(nounKey);
        if (noun && text.startsWith(noun) && Object.values(params).includes(noun)) {
            return noun.charAt(0).toLocaleUpperCase() + text.slice(1);
        }
    }
    return text;
}

export function t<K extends TranslationKey>(
    key: K,
    ...params: TranslationParams<K> extends never ? [] : [params: TranslationParams<K>]
): string {
    const callable = resolveCallableTranslation(key);
    if (callable) {
        return capitalizeLeadingCommonNoun(callable(params[0] as never), params[0]);
    }
    return resolveStringValue(key);
}

export function tLoose(key: string): string {
    return resolveStringValue(key);
}
