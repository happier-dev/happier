import { hasTranslation, tLoose } from '@/text';
import { resolvePluginLocalizedText } from '@/sync/domains/plugins/ui/i18n';

/**
 * UX-1: plugin descriptor display strings carry `developerFallback` literals and
 * `titleKey`/`labelKey`/`descriptionKey` translation KEYS. Both the host-renderer
 * descriptor panel and the right-sidebar plugin tab resolver previously rendered the
 * raw `*Key` value, so an unresolved key (`myPlugin.tab.title`) leaked verbatim into
 * the UI. This is the single owner that resolves those candidates the way the built-in
 * right-sidebar tabs do (`RightSidebarIconTabBar` → `t(labelKey)`):
 *
 *   other literal candidates → plugin-owned translation lookup (or host `@/text` for
 *   static host keys) → developer fallback → final fallback (e.g. the descriptorId).
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
    /** Plugin-author fallback used only when keyed lookup misses. */
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
        // An external plugin's resolver is authoritative for its own key space. Do not
        // reinterpret a miss as a host `@/text` key: that would turn an accidental
        // collision with a host key into a misleading translated label.
        const resolved = candidates.resolveKey === undefined
            ? resolvePluginDisplayKey(key)
            : readDisplayLiteral(candidates.resolveKey(key));
        if (resolved) {
            return resolved;
        }
    }
    return readDisplayLiteral(candidates.developerFallback)
        ?? readDisplayLiteral(candidates.fallback);
}

/**
 * The wire shape every plugin-declared display string arrives in: either an
 * already-human literal, or a `{ key, fallback }` pair where `key` names a
 * translation the plugin ships and `fallback` is the developer literal.
 */
export type PluginProjectedLocalizedText =
    | string
    | Readonly<{ key?: unknown; fallback?: unknown }>;

/**
 * Resolve a projected `{ key, fallback }` display string. Callers used to read
 * `.fallback` directly, which threw away the translations bundled plugins ship
 * for that key and showed every non-English reader the developer literal.
 * Delegates to the single owner above so the key/fallback precedence and the
 * "an unresolved key never renders raw" rule stay in one place.
 */
export function resolveProjectedLocalizedText(
    value: PluginProjectedLocalizedText | null | undefined,
    localize?: (value: PluginProjectedLocalizedText) => string,
): string {
    if (value === null || value === undefined) return '';
    return (localize?.(value) ?? resolvePluginLocalizedText({
        projection: null,
        pluginId: '',
        value,
    })).trim();
}
