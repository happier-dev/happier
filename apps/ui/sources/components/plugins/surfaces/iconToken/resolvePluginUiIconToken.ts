import type { Ionicons, Octicons } from '@expo/vector-icons';

/**
 * Single canonical resolver for the plugin-UI icon-token vocabulary
 * (`PluginUiIconTokenV1`, declared in
 * `packages/protocol/src/plugins/contributions/ui/tokens.ts`).
 *
 * Plugin display descriptors only carry a semantic `iconToken`; each host
 * surface renders with a different icon font (right-sidebar tabs + session
 * header actions use Ionicons; session-surface detail tabs use Octicons). This
 * module owns the token → glyph mapping for BOTH fonts so the projection has one
 * source of truth instead of the three drifting re-implementations that used to
 * live in `rightSidebarPluginTabs.ts`, `pluginHeaderActions.tsx`, and the
 * session-surface render path.
 */

export type PluginUiIoniconName = keyof typeof Ionicons.glyphMap;
export type PluginUiOcticonName = keyof typeof Octicons.glyphMap;

/** Canonical `PluginUiIconTokenV1` enum values (kept in lockstep with the protocol schema). */
export const PLUGIN_UI_ICON_TOKENS = [
    'action',
    'browser',
    'copy',
    'file',
    'globe',
    'info',
    'preview',
    'refresh',
    'settings',
    'terminal',
    'warning',
] as const;

export type PluginUiIconTokenName = (typeof PLUGIN_UI_ICON_TOKENS)[number];

type PluginUiIconGlyphs = Readonly<{
    ionicon: PluginUiIoniconName;
    octicon: PluginUiOcticonName;
}>;

const PLUGIN_UI_ICON_TOKEN_GLYPHS: Readonly<Record<PluginUiIconTokenName, PluginUiIconGlyphs>> = Object.freeze({
    action: { ionicon: 'flash-outline', octicon: 'zap' },
    browser: { ionicon: 'globe-outline', octicon: 'browser' },
    copy: { ionicon: 'copy-outline', octicon: 'copy' },
    file: { ionicon: 'document-outline', octicon: 'file' },
    globe: { ionicon: 'globe-outline', octicon: 'globe' },
    info: { ionicon: 'information-circle-outline', octicon: 'info' },
    preview: { ionicon: 'eye-outline', octicon: 'eye' },
    refresh: { ionicon: 'refresh-outline', octicon: 'sync' },
    settings: { ionicon: 'settings-outline', octicon: 'gear' },
    terminal: { ionicon: 'terminal-outline', octicon: 'terminal' },
    warning: { ionicon: 'warning-outline', octicon: 'alert' },
});

/** Glyphs rendered for a missing or non-canonical icon token (generic "plugin" affordance). */
export const PLUGIN_UI_ICON_FALLBACK_IONICON: PluginUiIoniconName = 'extension-puzzle-outline';
export const PLUGIN_UI_ICON_FALLBACK_OCTICON: PluginUiOcticonName = 'apps';

const PLUGIN_UI_ICON_TOKEN_SET: ReadonlySet<string> = new Set(PLUGIN_UI_ICON_TOKENS);

function normalizeIconToken(token: string | null | undefined): PluginUiIconTokenName | null {
    if (typeof token !== 'string') {
        return null;
    }
    const trimmed = token.trim();
    return PLUGIN_UI_ICON_TOKEN_SET.has(trimmed) ? (trimmed as PluginUiIconTokenName) : null;
}

/** Resolve a plugin icon token to an Ionicons glyph name (fail-soft to the generic plugin glyph). */
export function resolvePluginUiIoniconName(token: string | null | undefined): PluginUiIoniconName {
    const normalized = normalizeIconToken(token);
    return normalized ? PLUGIN_UI_ICON_TOKEN_GLYPHS[normalized].ionicon : PLUGIN_UI_ICON_FALLBACK_IONICON;
}

/** Resolve a plugin icon token to an Octicons glyph name (fail-soft to the generic plugin glyph). */
export function resolvePluginUiOcticonName(token: string | null | undefined): PluginUiOcticonName {
    const normalized = normalizeIconToken(token);
    return normalized ? PLUGIN_UI_ICON_TOKEN_GLYPHS[normalized].octicon : PLUGIN_UI_ICON_FALLBACK_OCTICON;
}
