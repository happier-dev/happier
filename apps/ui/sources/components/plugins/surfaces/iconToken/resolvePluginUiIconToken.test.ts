import { describe, expect, it } from 'vitest';

import {
    PLUGIN_UI_ICON_FALLBACK_IONICON,
    PLUGIN_UI_ICON_FALLBACK_OCTICON,
    PLUGIN_UI_ICON_TOKENS,
    resolvePluginUiIoniconName,
    resolvePluginUiOcticonName,
} from './resolvePluginUiIconToken';

describe('resolvePluginUiIconToken', () => {
    it('maps every canonical PluginUiIconTokenV1 value to a stable Ionicon glyph', () => {
        const expected: Readonly<Record<(typeof PLUGIN_UI_ICON_TOKENS)[number], string>> = {
            action: 'flash-outline',
            browser: 'globe-outline',
            copy: 'copy-outline',
            file: 'document-outline',
            globe: 'globe-outline',
            info: 'information-circle-outline',
            preview: 'eye-outline',
            refresh: 'refresh-outline',
            settings: 'settings-outline',
            terminal: 'terminal-outline',
            warning: 'warning-outline',
        };
        for (const token of PLUGIN_UI_ICON_TOKENS) {
            expect(resolvePluginUiIoniconName(token)).toBe(expected[token]);
        }
    });

    it('maps every canonical PluginUiIconTokenV1 value to a stable Octicon glyph', () => {
        const expected: Readonly<Record<(typeof PLUGIN_UI_ICON_TOKENS)[number], string>> = {
            action: 'zap',
            browser: 'browser',
            copy: 'copy',
            file: 'file',
            globe: 'globe',
            info: 'info',
            preview: 'eye',
            refresh: 'sync',
            settings: 'gear',
            terminal: 'terminal',
            warning: 'alert',
        };
        for (const token of PLUGIN_UI_ICON_TOKENS) {
            expect(resolvePluginUiOcticonName(token)).toBe(expected[token]);
        }
    });

    it('falls back for unknown / null / whitespace tokens', () => {
        for (const token of [null, undefined, '', '  ', 'not-a-token', 'review']) {
            expect(resolvePluginUiIoniconName(token)).toBe(PLUGIN_UI_ICON_FALLBACK_IONICON);
            expect(resolvePluginUiOcticonName(token)).toBe(PLUGIN_UI_ICON_FALLBACK_OCTICON);
        }
    });

    it('trims surrounding whitespace before resolving', () => {
        expect(resolvePluginUiIoniconName('  browser  ')).toBe('globe-outline');
        expect(resolvePluginUiOcticonName('  browser  ')).toBe('browser');
    });
});
