import {
    PLUGIN_UI_ICON_TOKENS_V1,
    type PluginUiIconTokenV1,
} from '@happier-dev/protocol/plugins/ui';

import type { IconName } from '@/components/ui/icons/Icon';

/**
 * Single canonical resolver for the plugin-UI icon-token vocabulary
 * (`PluginUiIconTokenV1`, declared in
 * `packages/protocol/src/plugins/contributions/ui/tokens.ts`).
 *
 * Plugin display descriptors carry a semantic `iconToken`; this app-private
 * adapter owns the one exhaustive projection into the generated renderer
 * catalog. Icon fonts and their historical glyph spellings never leave this
 * owner.
 */

const PLUGIN_UI_ICON_TOKEN_TO_ICON_NAME: Readonly<Record<PluginUiIconTokenV1, IconName>> = Object.freeze({
    action: 'lightning',
    browser: 'globe',
    copy: 'copy',
    file: 'file',
    globe: 'globe',
    info: 'info',
    preview: 'eye',
    refresh: 'arrow-clockwise',
    settings: 'gear',
    terminal: 'terminal',
    warning: 'warning',
    add: 'plus',
    back: 'arrow-left',
    check: 'check',
    close: 'x',
    error: 'x-circle',
    external: 'arrow-square-out',
    forward: 'arrow-right',
    more: 'dots-three',
    search: 'magnifying-glass',
});

/** Glyph rendered for a missing or non-canonical semantic icon token. */
export const PLUGIN_UI_ICON_FALLBACK: IconName = 'puzzle-piece';

const PLUGIN_UI_ICON_TOKEN_SET: ReadonlySet<string> = new Set(PLUGIN_UI_ICON_TOKENS_V1);

function normalizeIconToken(token: string | null | undefined): PluginUiIconTokenV1 | null {
    if (typeof token !== 'string') {
        return null;
    }
    const trimmed = token.trim();
    return PLUGIN_UI_ICON_TOKEN_SET.has(trimmed) ? (trimmed as PluginUiIconTokenV1) : null;
}

/** Resolve a semantic plugin icon to the app's generated private renderer catalog. */
export function resolvePluginUiIconName(token: string | null | undefined): IconName {
    const normalized = normalizeIconToken(token);
    return normalized ? PLUGIN_UI_ICON_TOKEN_TO_ICON_NAME[normalized] : PLUGIN_UI_ICON_FALLBACK;
}
