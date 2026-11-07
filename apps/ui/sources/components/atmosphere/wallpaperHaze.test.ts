import Color from 'color';
import { describe, expect, it } from 'vitest';
import { resolveWallpaperHaze, WALLPAPER_HAZE_LAYERS } from './wallpaperHaze';

const PAGE = '#ffffff';
const INK = '#1c1c1e';
const grey = (luminance: number) => {
    const value = luminance <= 0.0031308 ? luminance * 12.92 : 1.055 * luminance ** (1 / 2.4) - 0.055;
    return Color.rgb(value * 255, value * 255, value * 255);
};
/** The ground a head line stands on where the picture is `luminance`, under the haze's veil. */
const veiled = (luminance: number, veil: ReturnType<typeof resolveWallpaperHaze>['veil']) =>
    veil ? grey(luminance).mix(Color(veil.color), veil.alpha) : grey(luminance);
const band = { x: 0.36, y: 0.17 };
const at = { x: 0.5, y: 0.5 };

describe('the Wallpaper haze is the head lines\' legibility device', () => {
    // A bright sky over dark land: the theme ink holds at the centre and fails at the band's edges.
    const mixed = { dark: 0.035, light: 0.82, focus: 0.5 };
    // A night picture under the light theme.
    const night = { dark: 0.004, light: 0.3, focus: 0.01 };

    it('with the default look keeps the theme ink and veils toward the page just enough for small head lines, across the whole band', () => {
        for (const heads of [mixed, night]) {
            const haze = resolveWallpaperHaze({ heads, page: PAGE, primary: INK, column: band, at, adaptive: true });
            expect(haze.ink).toBe('theme');
            expect(haze.veil?.color).toBe(PAGE);
            expect(Color(INK).contrast(veiled(heads.dark, haze.veil))).toBeGreaterThanOrEqual(4.5);
            // Just enough: a visibly weaker veil would fail.
            expect(Color(INK).contrast(veiled(heads.dark, { ...haze.veil!, alpha: haze.veil!.alpha - 0.04 }))).toBeLessThan(4.5);
            // The band's farthest corners stand inside the veil's solid core; the soft layers stay as composed.
            const veil = haze.veil!;
            expect(Math.hypot(band.x / veil.rx, band.y / veil.ry)).toBeLessThanOrEqual(veil.solid + 1e-9);
            expect(haze.layers).toBe(WALLPAPER_HAZE_LAYERS);
        }
    });

    it('keeps the haze as composed where the head lines already read', () => {
        expect(resolveWallpaperHaze({ heads: { dark: 0.4, light: 0.9, focus: 0.7 }, page: PAGE, primary: INK, column: band, at, adaptive: true }))
            .toEqual({ layers: WALLPAPER_HAZE_LAYERS, veil: null, ink: 'theme' });
    });

    it('applies a person\'s own look exactly as set: no veil, and the page colour only where the picture runs hard against the theme', () => {
        expect(resolveWallpaperHaze({ heads: mixed, page: PAGE, primary: INK, column: band, at, adaptive: false }))
            .toEqual({ layers: WALLPAPER_HAZE_LAYERS, veil: null, ink: 'theme' });
        expect(resolveWallpaperHaze({ heads: night, page: PAGE, primary: INK, column: band, at, adaptive: false }))
            .toEqual({ layers: WALLPAPER_HAZE_LAYERS, veil: null, ink: 'page' });
        expect(resolveWallpaperHaze({ heads: undefined, page: PAGE, primary: INK, column: band, at, adaptive: true }))
            .toEqual({ layers: WALLPAPER_HAZE_LAYERS, veil: null, ink: 'theme' });
    });

    it('in dark deepens the picture toward its own hue rather than greying it, with the same just-enough strength', () => {
        const page = '#1b1919';
        const ink = '#f2efed';
        // A peach dusk sky over the head lines.
        const dusk = { dark: 0.06, light: 0.55, focus: 0.3 };
        const orange = 'rgb(226, 150, 104)';
        const neutral = resolveWallpaperHaze({ heads: dusk, page, primary: ink, column: band, at, adaptive: true });
        const tinted = resolveWallpaperHaze({ heads: dusk, page, primary: ink, column: band, at, adaptive: true, bandColor: orange });
        const veil = tinted.veil!;
        // The veil leans to the picture's hue and keeps the page's lightness.
        expect(Math.abs(Color(veil.color).hue() - Color(orange).hue())).toBeLessThan(12);
        expect(Color(veil.color).lch().array()[1]!).toBeGreaterThan(Color(page).lch().array()[1]! + 8);
        expect(Math.abs(Color(veil.color).lch().array()[0]! - Color(page).lch().array()[0]!)).toBeLessThan(1.5);
        // Same strength as the neutral veil, and the head lines still read over the brightest sky.
        expect(Math.abs(veil.alpha - neutral.veil!.alpha)).toBeLessThan(0.03);
        const ground = grey(dusk.light).mix(Color(veil.color), veil.alpha);
        expect(Color(ink).contrast(ground)).toBeGreaterThanOrEqual(4.5);
        // Over the sky itself the veiled colour stays orange: more chroma than the neutral veil leaves.
        const sky = Color(orange);
        expect(sky.mix(Color(veil.color), veil.alpha).lch().array()[1]!).toBeGreaterThan(sky.mix(Color(page), neutral.veil!.alpha).lch().array()[1]! + 4);
    });

    it('holds the quieter head-line ink too: a secondary action beside the greeting reads at AA in dark', () => {
        const page = '#1b1919';
        const ink = '#f2efed';
        const secondary = '#9a918c';
        // A dusk sky the primary ink reads over unveiled, where the quieter ink would not.
        const dusk = { dark: 0.02, light: 0.1, focus: 0.05 };
        const haze = resolveWallpaperHaze({ heads: dusk, page, primary: ink, secondary, column: band, at, adaptive: true });
        expect(Color(secondary).contrast(veiled(dusk.light, haze.veil))).toBeGreaterThanOrEqual(4.5);
        expect(Color(ink).contrast(veiled(dusk.light, haze.veil))).toBeGreaterThanOrEqual(4.5);
    });

    it('keeps light light: the veil keeps the white page\'s lightness, where an orange band holds no tint', () => {
        const haze = resolveWallpaperHaze({ heads: { dark: 0.035, light: 0.82, focus: 0.5 }, page: PAGE, primary: INK, column: band, at, adaptive: true, bandColor: 'rgb(226, 150, 104)' });
        expect(Color(haze.veil!.color).hex()).toBe(Color(PAGE).hex());
    });
});
