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
