export type DeviceLocale = {
    languageCode?: string | null;
    languageScriptCode?: string | null;
};

function parseLocaleTag(tag: string): DeviceLocale | null {
    const cleaned = tag.trim();
    if (!cleaned) return null;

    const parts = cleaned.split(/[-_]/g).filter(Boolean);
    const languageCode = parts[0]?.toLowerCase() ?? null;
    if (!languageCode) return null;

    // BCP-47: language[-script][-region]...
    const maybeScript = parts.find((p) => p.length === 4);
    const languageScriptCode = maybeScript
        ? `${maybeScript[0].toUpperCase()}${maybeScript.slice(1).toLowerCase()}`
        : null;

    return { languageCode, languageScriptCode };
}

/**
 * Cross-platform fallback locale detection.
 *
 * Expo-native builds should use `deviceLocales.native.ts` (Metro will prefer `.native`).
 * In unit tests (Vitest/node), this file avoids importing Expo/React Native packages.
 */
export function* getDeviceLocales(): Generator<DeviceLocale> {
    if (typeof navigator !== 'undefined') {
        const nav = navigator as unknown as { languages?: string[]; language?: string };
        for (const tag of Array.isArray(nav.languages) ? nav.languages : []) {
            const parsed = parseLocaleTag(tag);
            if (parsed) yield parsed;
        }
        if (typeof nav.language === 'string') {
            const parsed = parseLocaleTag(nav.language);
            if (parsed) yield parsed;
        }
    }

    // The browser's locale preferences usually settle this before Intl is needed.
    const intlTag = Intl?.DateTimeFormat?.()?.resolvedOptions?.()?.locale;
    if (typeof intlTag === 'string') {
        const parsed = parseLocaleTag(intlTag);
        if (parsed) yield parsed;
    }
}
