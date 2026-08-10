import { describe, expect, it } from 'vitest';

import {
    PRESS_FEEDBACK_SURFACE_TOKEN_IDS,
    resolvePressFeedbackSurfaceTokenId,
} from '@/components/ui/interaction/usePressFeedback';
import { darkTheme, lightTheme } from '@/theme';
import {
    parseThemeColor,
    themeContrastRatioForFadedInk,
    themeContrastRatioOverLayers,
} from '@/theme/themeContrastMath';
import { resolveThemeColorTokenBaseValue } from '@/theme/tokens/themeColorTokenDefinitions';

/**
 * The press idiom this mechanism replaces is `opacity: pressed ? 0.7 : 1`, which dims the CONTENT.
 * Measured here rather than quoted: it drops `text.secondary` to well under AA in both themes.
 *
 * The replacement rule is "tint the surface, never dim the content", so every assertion below is
 * about the ink staying at full strength while only the fill behind it moves.
 */
const WCAG_AA_MIN_RATIO = 4.5;

/** WCAG 2.2 SC 1.4.11 floor. Nothing this mechanism paints may put content below it. */
const NON_TEXT_MIN_RATIO = 3;

const LEGACY_PRESS_OPACITY = 0.7;

const CONTENT_INK_TOKEN_IDS = ['text.primary', 'text.secondary'] as const;

/** The surfaces a pressable row or control can sit on. */
const CONTENT_SURFACE_TOKEN_IDS = [
    'surface.base',
    'background.canvas',
    'surface.inset',
    'surface.elevated',
] as const;

const THEMES = [
    ['light', lightTheme],
    ['dark', darkTheme],
] as const;

/**
 * `text.secondary` in dark is a pre-existing weakness the contract reports rather than fixes
 * (PLAN §4.5: it measures 4.41 on `surface.elevated` AT REST, before any press feedback). Any
 * lightening fill therefore cannot reach AA with it, and darkening on press instead would change
 * the app's press appearance everywhere. These pairings are held to the non-text floor and to the
 * non-regression rule below; they are NOT evidence that the mechanism dims anything.
 */
const AA_EXEMPT_INK_BY_THEME: Readonly<Record<string, readonly string[]>> = {
    dark: ['text.secondary'],
    light: [],
};

function readToken(theme: typeof lightTheme, tokenId: string): string {
    const value = resolveThemeColorTokenBaseValue(theme, tokenId);
    if (value === undefined) {
        throw new Error(`Theme color token "${tokenId}" is not registered or does not resolve to a color`);
    }
    return value;
}

describe('press feedback replaces dimming with a surface tint', () => {
    for (const [themeName, theme] of THEMES) {
        it(`${themeName}: the opacity idiom it replaces puts secondary text under AA`, () => {
            const ink = parseThemeColor(readToken(theme, 'text.secondary'));

            for (const surfaceTokenId of CONTENT_SURFACE_TOKEN_IDS) {
                const surface = parseThemeColor(readToken(theme, surfaceTokenId));
                const dimmed = themeContrastRatioForFadedInk({
                    ink,
                    opacity: LEGACY_PRESS_OPACITY,
                    backdrop: surface,
                });

                expect(
                    Number(dimmed.toFixed(2)),
                    `text.secondary at opacity ${LEGACY_PRESS_OPACITY} on ${surfaceTokenId}`,
                ).toBeLessThan(WCAG_AA_MIN_RATIO);
            }
        });

        for (const inkTokenId of CONTENT_INK_TOKEN_IDS) {
            it(`${themeName}: ${inkTokenId} stays legible on every fill the mechanism can paint`, () => {
                const ink = parseThemeColor(readToken(theme, inkTokenId));
                const exempt = (AA_EXEMPT_INK_BY_THEME[themeName] ?? []).includes(inkTokenId);

                for (const surfaceTokenId of CONTENT_SURFACE_TOKEN_IDS) {
                    const surfaceValue = readToken(theme, surfaceTokenId);
                    const dimmed = themeContrastRatioForFadedInk({
                        ink,
                        opacity: LEGACY_PRESS_OPACITY,
                        backdrop: parseThemeColor(surfaceValue),
                    });

                    for (const fillTokenId of PRESS_FEEDBACK_SURFACE_TOKEN_IDS) {
                        const tinted = themeContrastRatioOverLayers(ink, [
                            surfaceValue,
                            readToken(theme, fillTokenId),
                        ]);
                        const where = `${inkTokenId} on ${fillTokenId} over ${surfaceTokenId}`;

                        // The property that decides this lane: tinting beats dimming, always.
                        expect(Number(tinted.toFixed(2)), `${where} vs the opacity idiom`)
                            .toBeGreaterThan(Number(dimmed.toFixed(2)));
                        expect(Number(tinted.toFixed(2)), where)
                            .toBeGreaterThanOrEqual(NON_TEXT_MIN_RATIO);

                        if (!exempt) {
                            expect(Number(tinted.toFixed(2)), where)
                                .toBeGreaterThanOrEqual(WCAG_AA_MIN_RATIO);
                        }
                    }
                }
            });
        }
    }

    it('only ever names surface fills — an opacity is not a press treatment', () => {
        for (const tokenId of PRESS_FEEDBACK_SURFACE_TOKEN_IDS) {
            expect(tokenId.startsWith('surface.'), tokenId).toBe(true);
            expect(resolveThemeColorTokenBaseValue(lightTheme, tokenId)).toEqual(expect.any(String));
        }
    });
});

describe('resolvePressFeedbackSurfaceTokenId', () => {
    const base = { pressed: false, hovered: false, selected: false, disabled: false } as const;

    it('leaves a resting control untinted so the caller keeps its own fill', () => {
        expect(resolvePressFeedbackSurfaceTokenId({ ...base, tone: 'control', platform: 'web' })).toBeNull();
        expect(resolvePressFeedbackSurfaceTokenId({ ...base, tone: 'row', platform: 'ios' })).toBeNull();
    });

    it('paints a pressed control on every platform', () => {
        for (const platform of ['ios', 'android', 'web'] as const) {
            expect(resolvePressFeedbackSurfaceTokenId({ ...base, tone: 'control', platform, pressed: true }))
                .toBe('surface.selected');
        }
    });

    it('leaves the pressed row fill to the platform ripple on Android and web', () => {
        expect(resolvePressFeedbackSurfaceTokenId({ ...base, tone: 'row', platform: 'ios', pressed: true }))
            .toBe('surface.pressedOverlay');
        expect(resolvePressFeedbackSurfaceTokenId({ ...base, tone: 'row', platform: 'android', pressed: true }))
            .toBeNull();
        expect(resolvePressFeedbackSurfaceTokenId({ ...base, tone: 'row', platform: 'web', pressed: true }))
            .toBeNull();
    });

    it('keeps a selected row selected while it is pressed on Android and web', () => {
        expect(resolvePressFeedbackSurfaceTokenId({
            ...base, tone: 'row', platform: 'android', pressed: true, selected: true,
        })).toBe('surface.selected');
    });

    it('ranks press over hover, and hover over selection, for a control', () => {
        expect(resolvePressFeedbackSurfaceTokenId({
            ...base, tone: 'control', platform: 'web', pressed: true, hovered: true, selected: true,
        })).toBe('surface.selected');
        expect(resolvePressFeedbackSurfaceTokenId({
            ...base, tone: 'control', platform: 'web', hovered: true, selected: true,
        })).toBe('surface.pressed');
        expect(resolvePressFeedbackSurfaceTokenId({
            ...base, tone: 'control', platform: 'web', selected: true,
        })).toBe('surface.pressed');
    });

    it('ranks selection over hover for a row, so a selected row does not flicker under the pointer', () => {
        expect(resolvePressFeedbackSurfaceTokenId({
            ...base, tone: 'row', platform: 'web', hovered: true, selected: true,
        })).toBe('surface.selected');
        expect(resolvePressFeedbackSurfaceTokenId({
            ...base, tone: 'row', platform: 'web', hovered: true,
        })).toBe('surface.pressed');
    });

    it('gives a disabled surface no feedback at all', () => {
        expect(resolvePressFeedbackSurfaceTokenId({
            ...base, tone: 'control', platform: 'web', hovered: true, pressed: true, disabled: true,
        })).toBeNull();
        expect(resolvePressFeedbackSurfaceTokenId({
            ...base, tone: 'row', platform: 'web', hovered: true, disabled: true,
        })).toBeNull();
    });
});
