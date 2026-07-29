import { hasTranslation, tLoose } from '@/text';

/**
 * UX-1: plugin descriptor display strings carry `developerFallback` literals and
 * `titleKey`/`labelKey`/`descriptionKey` translation KEYS. Both the host-renderer
 * descriptor panel and the right-sidebar plugin tab resolver previously rendered the
 * raw `*Key` value, so an unresolved key (`myPlugin.tab.title`) leaked verbatim into
 * the UI. This is the single owner that resolves those candidates the way the built-in
 * right-sidebar tabs do (`RightSidebarIconTabBar` → `t(labelKey)`):
 *
 *   developerFallback (literal) → other literal candidates → t(key) IF the key is a real
 *   catalog entry → final fallback (e.g. the descriptorId).
 *
 * A translation key that is NOT in the catalog resolves to nothing and falls through, so
 * raw, unresolved keys never reach the screen.
 */

function readDisplayLiteral(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolve a descriptor-declared translation key. Only a key that exists in the active
 * translation catalog produces a value; anything else (including a literal string that is
 * not a real key) yields `null` so it never leaks raw.
 */
function resolvePluginDisplayKey(value: unknown): string | null {
    const key = readDisplayLiteral(value);
    if (!key) {
        return null;
    }
    return hasTranslation(key) ? readDisplayLiteral(tLoose(key)) : null;
}

export type PluginDisplayStringCandidates = Readonly<{
    /** Plugin-author literal override (highest precedence; never treated as a key). */
    developerFallback?: unknown;
    /** Additional already-human literal candidates (e.g. a `display.label`). */
    literals?: readonly unknown[];
    /** Translation-key candidates resolved via the catalog, in priority order. */
    keys?: readonly unknown[];
    /** Optional plugin-owned translation resolver. Must return null for unknown keys. */
    resolveKey?: (key: string) => string | null | undefined;
    /** Final fallback (e.g. the descriptorId) when nothing else resolves. */
    fallback?: unknown;
}>;

/**
 * Resolve a single plugin display string from declared candidates. Returns `null` only
 * when every candidate (including the fallback) is empty.
 */
export function resolvePluginDisplayString(
    candidates: PluginDisplayStringCandidates,
): string | null {
    const developerFallback = readDisplayLiteral(candidates.developerFallback);
    if (developerFallback) {
        return developerFallback;
    }
    for (const literal of candidates.literals ?? []) {
        const resolved = readDisplayLiteral(literal);
        if (resolved) {
            return resolved;
        }
    }
    for (const keyCandidate of candidates.keys ?? []) {
        const key = readDisplayLiteral(keyCandidate);
        if (!key) {
            continue;
        }
        const resolved = readDisplayLiteral(candidates.resolveKey?.(key)) ?? resolvePluginDisplayKey(key);
        if (resolved) {
            return resolved;
        }
    }
    return readDisplayLiteral(candidates.fallback);
}
