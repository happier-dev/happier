import { describe, expect, it } from 'vitest';

import { PluginUiIconTokenV1Schema } from '@happier-dev/protocol';
import { HAPPIER_ICON_NAMES } from '@happier-dev/plugin-ui/presentation';

import * as iconTokenResolver from './resolvePluginUiIconToken';
import type { IconName } from '@/components/ui/icons/Icon';

const EXPECTED_PRIVATE_ICON_NAMES: Readonly<Record<string, IconName>> = Object.freeze({
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
    'change-open': 'git-pull-request',
    'change-complete': 'git-merge',
});

describe('resolvePluginUiIconToken', () => {
    it('exposes the Protocol-owned semantic icon contract through the plugin-UI seam', () => {
        expect([...HAPPIER_ICON_NAMES]).toEqual([...PluginUiIconTokenV1Schema.options]);
    });

    it('maps every admitted semantic token to one private renderer glyph', () => {
        const resolvePluginUiIconName = Reflect.get(iconTokenResolver, 'resolvePluginUiIconName');
        expect(resolvePluginUiIconName).toBeTypeOf('function');
        if (typeof resolvePluginUiIconName !== 'function') return;

        expect(Object.keys(EXPECTED_PRIVATE_ICON_NAMES)).toEqual([...PluginUiIconTokenV1Schema.options]);
        for (const token of PluginUiIconTokenV1Schema.options) {
            expect(resolvePluginUiIconName(token)).toBe(EXPECTED_PRIVATE_ICON_NAMES[token]);
        }
    });

    it('falls back for unknown / null / whitespace tokens', () => {
        for (const token of [null, undefined, '', '  ', 'not-a-token', 'review']) {
            const resolvePluginUiIconName = Reflect.get(iconTokenResolver, 'resolvePluginUiIconName');
            expect(resolvePluginUiIconName).toBeTypeOf('function');
            if (typeof resolvePluginUiIconName !== 'function') return;
            expect(resolvePluginUiIconName(token)).toBe('puzzle-piece');
        }
    });

    it('trims surrounding whitespace before resolving', () => {
        const resolvePluginUiIconName = Reflect.get(iconTokenResolver, 'resolvePluginUiIconName');
        expect(resolvePluginUiIconName).toBeTypeOf('function');
        if (typeof resolvePluginUiIconName !== 'function') return;
        expect(resolvePluginUiIconName('  browser  ')).toBe('globe');
        expect(resolvePluginUiIconName('settings')).toBe('gear');
        expect(resolvePluginUiIconName('refresh')).toBe('arrow-clockwise');
    });

    it('mirrors logical back and forward tokens in right-to-left presentation', () => {
        const resolvePluginUiIconName = Reflect.get(iconTokenResolver, 'resolvePluginUiIconName');
        expect(resolvePluginUiIconName).toBeTypeOf('function');
        if (typeof resolvePluginUiIconName !== 'function') return;

        expect(resolvePluginUiIconName('back', 'rtl')).toBe('arrow-right');
        expect(resolvePluginUiIconName('forward', 'rtl')).toBe('arrow-left');
        expect(resolvePluginUiIconName('back', 'ltr')).toBe('arrow-left');
        expect(resolvePluginUiIconName('forward', 'ltr')).toBe('arrow-right');
    });
});
