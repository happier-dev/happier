import { getPreferredLanguage } from '@/text';

import type { PluginUiProjectionModel } from './projection';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

export function resolvePluginUiText(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    pluginId: string;
    key: string | null | undefined;
    locale?: string | null;
    fallback?: string | null;
}>): string {
    const resolved = resolvePluginUiTranslationText(params);
    if (resolved) {
        return resolved;
    }
    const key = params.key?.trim();
    if (!key) {
        return params.fallback?.trim() || '';
    }

    return params.fallback?.trim() || key;
}

const EMPTY_TRANSLATION_BUNDLE: Readonly<Record<string, string>> = Object.freeze({});

function readStringBundle(value: unknown): Readonly<Record<string, string>> | null {
    const record = readRecord(value);
    if (!record) {
        return null;
    }
    const entries = Object.entries(record).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * The plugin's projected translation map for one locale, merged over its English
 * fallback — the same preferred-locale-then-English resolution
 * {@link resolvePluginUiTranslationText} applies per key, materialized once so an
 * executable surface can resolve keys synchronously (§3.2, UI-D13).
 *
 * This is the same projected bundle the host already reads; no second catalog,
 * loader or fallback owner is introduced.
 */
export function resolvePluginUiTranslationBundle(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    pluginId: string;
    locale?: string | null;
}>): Readonly<Record<string, string>> {
    const bundles = readRecord(params.projection?.translationsByPluginId[params.pluginId]?.bundles);
    if (!bundles) {
        return EMPTY_TRANSLATION_BUNDLE;
    }
    const preferredLocale = params.locale?.trim() || 'en';
    const english = readStringBundle(bundles.en);
    const preferred = preferredLocale === 'en' ? null : readStringBundle(bundles[preferredLocale]);
    if (!english && !preferred) {
        return EMPTY_TRANSLATION_BUNDLE;
    }
    return Object.freeze({ ...english, ...preferred });
}

export function resolvePluginUiTranslationText(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    pluginId: string;
    key: string | null | undefined;
    locale?: string | null;
}>): string | null {
    const key = params.key?.trim();
    if (!key) {
        return null;
    }

    const translations = params.projection?.translationsByPluginId[params.pluginId];
    const bundles = readRecord(translations?.bundles);
    const preferredLocale = params.locale?.trim() || 'en';
    const preferredBundle = readRecord(bundles?.[preferredLocale]);
    const englishBundle = preferredLocale === 'en' ? preferredBundle : readRecord(bundles?.en);
    const value = preferredBundle?.[key] ?? englishBundle?.[key];
    if (typeof value === 'string' && value.trim().length > 0) {
        return value;
    }

    return null;
}

/**
 * Resolves one declared `PluginLocalizedStringV2` for a plugin.
 *
 * Author-declared strings arrive as `string` or `{ key, fallback }`. Reading
 * `.fallback` directly is what every fallback-only consumer used to do, and it
 * silently pinned external plugins to their English declaration no matter which
 * locale the user picked. Protocol guarantees a non-empty `fallback` whenever a
 * `key` is present, so an unresolved key degrades to the author's own words
 * rather than exposing the key.
 */
export function resolvePluginLocalizedText(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    pluginId: string;
    value: unknown;
    locale?: string | null;
}>): string {
    const { value } = params;
    if (typeof value === 'string') return value;
    const candidate = readRecord(value);
    const key = typeof candidate?.key === 'string' ? candidate.key : null;
    const fallback = typeof candidate?.fallback === 'string' ? candidate.fallback : null;
    if (key === null && fallback === null) return '';
    return resolvePluginUiText({
        projection: params.projection,
        pluginId: params.pluginId,
        key,
        fallback,
        locale: params.locale,
    });
}

/** Resolves declared plugin strings for the current locale. */
export type PluginLocalizedTextResolver = (pluginId: string, value: unknown) => string;

/**
 * Binds {@link resolvePluginLocalizedText} to one projection and locale so a
 * presentation owner can hand a single narrow resolver to every consumer that
 * displays declared plugin strings. It is a binding over the existing owner, not
 * a second catalog: the host's bundled-translation catalog cannot answer an
 * admitted external plugin's bundle, and must not be treated as if it could.
 */
export function createPluginLocalizedTextResolver(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    /** Defaults to the app's current preferred language. */
    locale?: string | null;
}>): PluginLocalizedTextResolver {
    const locale = params.locale ?? getPreferredLanguage();
    return (pluginId, value) => resolvePluginLocalizedText({
        projection: params.projection,
        pluginId,
        value,
        locale,
    });
}
