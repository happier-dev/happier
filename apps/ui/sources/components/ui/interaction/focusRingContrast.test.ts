import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from '@/theme';
import { parseThemeColor, themeContrastRatioOverLayers } from '@/theme/themeContrastMath';
import {
    getEditableThemeColorTokenDefinition,
    resolveThemeColorTokenBaseValue,
} from '@/theme/tokens/themeColorTokenDefinitions';

/**
 * WCAG 2.2 SC 1.4.11 / 2.4.11: a focus indicator must clear 3:1 against everything adjacent to it.
 * The ring is drawn over whatever the control is sitting on, so "everything adjacent" is the whole
 * set of surfaces either theme can paint behind it — including `border.strong`, which is the
 * binding case in both themes and is translucent in dark.
 *
 * `focus.ring` is a DEDICATED token, not an alias of `state.active` (PLAN ruling C8): the promise
 * it carries is this ratio table, and an accent re-tuned for brand reasons cannot carry it.
 */
const FOCUS_INDICATOR_MIN_RATIO = 3;

/** Each entry is a back-to-front layer stack the ring can be painted over. */
const LIGHT_BACKDROPS: Readonly<Record<string, readonly string[]>> = {
    'white': ['#ffffff'],
    'surface.base': ['surface.base'],
    'background.canvas': ['background.canvas'],
    'surface.inset': ['surface.inset'],
    'surface.elevated': ['surface.elevated'],
    'surface.pressed': ['surface.pressed'],
    'surface.selected': ['surface.selected'],
    'border.strong': ['surface.base', 'border.strong'],
    'border.strong over elevated': ['surface.elevated', 'border.strong'],
    'state.active tint': ['surface.base', 'state.active.background'],
};

const DARK_BACKDROPS: Readonly<Record<string, readonly string[]>> = {
    'surface.base': ['surface.base'],
    'background.canvas': ['background.canvas'],
    'surface.inset': ['surface.inset'],
    'surface.elevated': ['surface.elevated'],
    'surface.pressed': ['surface.pressed'],
    'surface.selected': ['surface.selected'],
    'border.strong': ['surface.base', 'border.strong'],
    'border.strong over elevated': ['surface.elevated', 'border.strong'],
    'border.strong over pressed': ['surface.pressed', 'border.strong'],
    'state.active tint': ['surface.base', 'state.active.background'],
};

const THEMES = [
    ['light', lightTheme, LIGHT_BACKDROPS],
    ['dark', darkTheme, DARK_BACKDROPS],
] as const;

function readLayer(theme: typeof lightTheme, layer: string): string {
    if (layer.startsWith('#') || layer.startsWith('rgb')) return layer;
    const value = resolveThemeColorTokenBaseValue(theme, layer);
    if (value === undefined) {
        throw new Error(`Theme color token "${layer}" is not registered or does not resolve to a color`);
    }
    return value;
}

describe('focus ring contrast (ruling C8)', () => {
    for (const [themeName, theme, backdrops] of THEMES) {
        it(`${themeName}: focus.ring clears the focus-indicator floor on every surface behind it`, () => {
            const ring = parseThemeColor(readLayer(theme, 'focus.ring'));

            for (const [label, layers] of Object.entries(backdrops)) {
                const ratio = themeContrastRatioOverLayers(
                    ring,
                    layers.map((layer) => readLayer(theme, layer)),
                );

                expect(Number(ratio.toFixed(2)), `focus.ring on ${label}`)
                    .toBeGreaterThanOrEqual(FOCUS_INDICATOR_MIN_RATIO);
            }
        });

        it(`${themeName}: focus.ring is its own hue, not an accent alias`, () => {
            const ring = readLayer(theme, 'focus.ring');

            expect(ring).not.toBe(theme.colors.state.active.foreground);
            expect(ring).not.toBe(theme.colors.state.active.onTint);
            expect(ring).not.toBe(theme.colors.state.info.foreground);
            expect(ring).not.toBe(theme.colors.accent.blue);
        });
    }

    it('declares the focus-indicator contract on the token itself', () => {
        expect(getEditableThemeColorTokenDefinition('focus.ring')?.contrastPairs).toEqual([
            { tokenId: 'surface.base', minRatio: FOCUS_INDICATOR_MIN_RATIO },
            { tokenId: 'border.strong', minRatio: FOCUS_INDICATOR_MIN_RATIO },
        ]);
    });
});
