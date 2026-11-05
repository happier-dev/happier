import { describe, expect, it } from 'vitest';
import Color from 'color';
import { GlassSurfaceMaterialsSchema } from '@happier-dev/protocol';
import { DEFAULT_GLASS_TINT_INTENSITY } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
import { darkTheme, lightTheme } from '@/theme';
import { applyGlassBackdropFilter, glassContrastRatio, renderGlassOver } from '@/dev/testkit/glassBackdrop';

import {
    GLASS_SURFACE_GROUPS, glassPresetMaterials, readGlassMaterials, readGlassPreset, resolveGlassPresetSettingsDelta,
    resolveGlassSurfaceMaterial, resolveGlassSurfaceSettingsDelta, resolveGlassIntensitySettingsDelta, resolveGlassBackdropTone,
    resolveGlassBackdropMap, readGlassTintedMaterials,
    resolveGlassNotchPaint,
} from './glassMaterial';

describe('glass material Account owner', () => {
    it('keeps Elements solid without backing and uses the card coat over atmosphere or a live translucent Window', () => {
        const settings = { glassSurfaceMaterials: glassPresetMaterials('auto') };
        const solid = { blur: 'off', opacity: 1 } as const;
        expect(resolveGlassSurfaceMaterial(settings, 'card').material).toEqual(solid);
        expect(resolveGlassSurfaceMaterial(settings, 'card', { atmosphereBehind: 'none' }).material).toEqual(solid);
        expect(resolveGlassSurfaceMaterial(settings, 'card', { desktopWindow: true }).material).toEqual(solid);
        for (const atmosphereBehind of ['band', 'wallpaper'] as const) {
            expect(resolveGlassSurfaceMaterial(settings, 'card', { atmosphereBehind }).material).toEqual(readGlassTintedMaterials(settings).card);
            // Native renderers have no backdrop tone or card blur: they keep the stored coat, not the tint's hair.
            expect(resolveGlassSurfaceMaterial(settings, 'card', { atmosphereBehind, nativeRenderer: true }).material).toEqual(settings.glassSurfaceMaterials.card);
            expect(resolveGlassSurfaceMaterial(settings, 'card', { atmosphereBehind, reduceTransparency: true }).material).toEqual(solid);
            expect(resolveGlassSurfaceMaterial(settings, 'card', { atmosphereBehind, windowActive: false }).material).toEqual(solid);
        }
        expect(resolveGlassSurfaceMaterial(settings, 'card', { desktopWindow: true, nativeWindowMaterialLive: true }).material)
            .toEqual(readGlassTintedMaterials(settings).card);
        const windowSolid = { glassSurfaceMaterials: { ...glassPresetMaterials('everywhere'), content: solid } };
        expect(resolveGlassSurfaceMaterial(windowSolid, 'card', { desktopWindow: true, nativeWindowMaterialLive: true }).material).toEqual(solid);
        const elementsSolid = { glassSurfaceMaterials: { ...glassPresetMaterials('auto'), card: solid } };
        expect(resolveGlassSurfaceMaterial(elementsSolid, 'card', { atmosphereBehind: 'wallpaper' }).material).toEqual(solid);
        for (const preset of ['auto', 'everywhere', 'clear'] as const) {
            const choices = { glassSurfaceMaterials: glassPresetMaterials(preset) };
            expect(resolveGlassSurfaceMaterial(choices, 'content').material).toEqual(solid);
            expect(resolveGlassSurfaceMaterial(choices, 'card').material).toEqual(solid);
            expect(resolveGlassSurfaceMaterial(choices, 'card', { atmosphereBehind: 'band' }).material).toEqual(readGlassTintedMaterials(choices).card);
        }
    });
    it('keeps cards and composer material opaque under Solid and Reduce Transparency even over a background', () => {
        for (const atmosphereBehind of ['band', 'wallpaper'] as const) {
            for (const preset of ['solid', 'clear'] as const) {
                const settings = { glassSurfaceMaterials: glassPresetMaterials(preset) };
                const environment = { atmosphereBehind, reduceTransparency: preset === 'clear' };
                // Cards and composer consume surface material, not the cleared page plane.
                for (const group of GLASS_SURFACE_GROUPS) {
                    expect(resolveGlassSurfaceMaterial(settings, group, environment).material).toEqual({ blur: 'off', opacity: 1 });
                }
            }
        }
    });
    it('treats a shown Wallpaper as backing: under Auto the title bar, rail and sidebar keep their glass on web and without live desktop glass', () => {
        // Owner ruling 2026-10-23: under Auto, an active Wallpaper counts as something behind the window, like desktop glass.
        const auto = { glassSurfaceMaterials: glassPresetMaterials('auto') };
        const solid = { blur: 'off', opacity: 1 } as const;
        expect(readGlassPreset(auto)).toBe('auto');
        for (const group of ['chrome', 'sidebar'] as const) {
            expect(readGlassTintedMaterials(auto)[group]).not.toEqual(solid);
            expect(resolveGlassSurfaceMaterial(auto, group, { atmosphereBehind: 'none' }).material).toEqual(solid);
            expect(resolveGlassSurfaceMaterial(auto, group, { atmosphereBehind: 'band' }).material).toEqual(solid);
            expect(resolveGlassSurfaceMaterial(auto, group, { atmosphereBehind: 'wallpaper' }))
                .toEqual({ material: readGlassTintedMaterials(auto)[group], reason: null });
            expect(resolveGlassSurfaceMaterial(auto, group, { atmosphereBehind: 'wallpaper', desktopWindow: true, nativeWindowMaterialLive: false }))
                .toEqual({ material: readGlassTintedMaterials(auto)[group], reason: null });
            expect(resolveGlassSurfaceMaterial({ glassSurfaceMaterials: glassPresetMaterials('solid') }, group, { atmosphereBehind: 'wallpaper' }).material).toEqual(solid);
            expect(resolveGlassSurfaceMaterial(auto, group, { atmosphereBehind: 'wallpaper', reduceTransparency: true }).material).toEqual(solid);
            expect(resolveGlassSurfaceMaterial(auto, group, { atmosphereBehind: 'wallpaper', windowActive: false }).material).toEqual(solid);
        }
    });

    it('applies a dimming tone without a contrast lift to wallpaper chrome and sidebar, retaining solid/custom and ordinary window treatment', () => {
        for (const group of ['chrome', 'sidebar'] as const) {
            const settings = { glassSurfaceMaterials: glassPresetMaterials('clear') };
            expect(resolveGlassBackdropTone(settings, group, true)).toBe('');
            expect(resolveGlassBackdropTone(settings, group, true, { atmosphereBehind: 'band' })).toBe('');
            const tone = resolveGlassBackdropTone(settings, group, true, { atmosphereBehind: 'wallpaper' });
            expect(tone).toMatch(/brightness\(/);
            expect(tone).not.toMatch(/contrast\(/);
            expect(applyGlassBackdropFilter(tone, [0, 0, 0])).toEqual([0, 0, 0]);
            expect(resolveGlassBackdropTone(settings, group, true, { atmosphereBehind: 'wallpaper', reduceTransparency: true })).toBe('');
            const custom = { glassSurfaceMaterials: { ...settings.glassSurfaceMaterials, [group]: { blur: 'off' as const, opacity: 0.13 } } };
            expect(resolveGlassBackdropTone(custom, group, true, { atmosphereBehind: 'wallpaper' })).toBe('');
        }
    });
    describe('fixed point: glass over the plain page lands on its own paint at every tint', () => {
        it('interpolates compression continuously, including the default 14% picture wash and panel coats', () => {
            for (const [tint, plainDark, pictureDark, light, panelCoat] of [
                [0, 1, 1, 1, 0.55], [12, 1, 0.868, 0.863, 0.586],
                [50, 1, 0.45, 0.43, 0.7], [100, 0.7, 0.35, 0.3, 0.85],
            ] as const) {
                const settings = { glassSurfaceMaterials: glassPresetMaterials('auto'), glassTintIntensity: tint };
                for (const group of ['card', 'floating'] as const) {
                    for (const dark of [false, true]) {
                        for (const atmosphereBehind of ['none', 'wallpaper'] as const) {
                            const environment = { atmosphereBehind, desktopWindow: true, nativeWindowMaterialLive: true };
                            const map = resolveGlassBackdropMap(settings, group, dark, environment)!;
                            const opacity = resolveGlassSurfaceMaterial(settings, group, environment).material.opacity;
                            const compression = dark ? atmosphereBehind === 'none' ? plainDark : pictureDark : Math.min(light, 1 - opacity);
                            const filtered = applyGlassBackdropFilter(map.tone, [60, 60, 60]);
                            expect((1 - opacity) * filtered[0]! / 60).toBeCloseTo(compression, 3);
                        }
                    }
                }
                const panel = resolveGlassBackdropMap(settings, 'floating', true, {}, null, true)!;
                expect(panel.opacity).toBeCloseTo(panelCoat);
            }
        });
        type Tint = number;
        const rgb = (value: string) => Color(value).rgb().array().slice(0, 3) as unknown as [number, number, number];
        const sky: [number, number, number] = [193, 146, 143];
        const FERRIS_SKY: [number, number, number] = [15, 110, 155];
        const render = (theme: typeof darkTheme | typeof lightTheme, group: 'card' | 'floating', preset: 'auto' | 'everywhere' | 'clear', atmosphereBehind: 'none' | 'band' | 'wallpaper', backdrop: [number, number, number], tint: Tint) => {
            const settings = { glassSurfaceMaterials: glassPresetMaterials(preset), glassTintIntensity: tint };
            const environment = { atmosphereBehind };
            const solid = group === 'card' ? theme.colors.edge.cardFill : theme.colors.edge.floatingFill;
            const map = resolveGlassBackdropMap(settings, group, theme.dark, environment, { page: theme.colors.surface.base, solid });
            const opacity = map?.opacity ?? resolveGlassSurfaceMaterial(settings, group, environment).material.opacity;
            expect(map?.coat).toBeTruthy();
            // Every tint lands on the surface's solid paint over the plain page, warm hue included (owner, 13:34).
            const paint = rgb(solid);
            return { map: map!, opacity, paint, out: renderGlassOver({ filter: map!.tone, coat: rgb(map!.coat!), opacity, backdrop }) };
        };
        it('lands Medium floating glass on a saturated authored fill without clamping an infeasible coat', () => {
            const settings = { glassSurfaceMaterials: glassPresetMaterials('auto'), glassTintIntensity: 50 };
            const map = resolveGlassBackdropMap(settings, 'floating', true, {}, { page: 'rgb(20,10,10)', solid: 'rgb(100,20,20)' });
            expect(map?.coat).toBeTruthy();
            const opacity = map?.opacity ?? resolveGlassSurfaceMaterial(settings, 'floating').material.opacity;
            const out = renderGlassOver({ filter: map!.tone, coat: rgb(map!.coat!), opacity, backdrop: [20, 10, 10] });
            out.forEach((value, channel) => expect(Math.abs(value - [100, 20, 20][channel]!)).toBeLessThanOrEqual(1));
        });
        it('keeps Elements, menus and panels on their solid paint at every integer tint', () => {
            for (let tint = 0; tint <= 100; tint++) {
                for (const theme of [darkTheme, lightTheme]) {
                    for (const group of ['card', 'floating'] as const) {
                        const { paint, out } = render(theme, group, 'auto', 'band', rgb(theme.colors.surface.base), tint);
                        out.forEach((value, channel) => expect(Math.abs(value - paint[channel]!)).toBeLessThanOrEqual(1));
                    }
                    const settings = { glassSurfaceMaterials: glassPresetMaterials('auto'), glassTintIntensity: tint };
                    const solid = theme.colors.edge.floatingFill;
                    const map = resolveGlassBackdropMap(settings, 'floating', theme.dark, {}, { page: theme.colors.surface.base, solid }, true)!;
                    const out = renderGlassOver({ filter: map.tone, coat: rgb(map.coat!), opacity: map.opacity!, backdrop: rgb(theme.colors.surface.base) });
                    out.forEach((value, channel) => expect(Math.abs(value - rgb(solid)[channel]!)).toBeLessThanOrEqual(1));
                }
            }
        });
        it('gives a floating surface over a live picture the Strong panel coat at the default tint, still landing on its paint', () => {
            // A live picture is arbitrary pixels (a black terminal under a light menu): it passes at most
            // Strong's 15% share, so the menu reads as its own clean paint, not a grey wash of the picture.
            for (const tint of [undefined, DEFAULT_GLASS_TINT_INTENSITY]) {
                for (const theme of [darkTheme, lightTheme]) {
                    const settings = { glassSurfaceMaterials: glassPresetMaterials('auto'), glassTintIntensity: tint };
                    const solid = theme.colors.edge.floatingFill;
                    const map = resolveGlassBackdropMap(settings, 'floating', theme.dark, {}, { page: theme.colors.surface.base, solid }, 'livePicture')!;
                    expect(map.opacity).toBeGreaterThanOrEqual(0.85 - 1e-9);
                    const over = (backdrop: [number, number, number]) => renderGlassOver({ filter: map.tone, coat: rgb(map.coat!), opacity: map.opacity!, backdrop });
                    over(rgb(theme.colors.surface.base)).forEach((value, channel) => expect(Math.abs(value - rgb(solid)[channel]!)).toBeLessThanOrEqual(1));
                    const extreme: [number, number, number] = theme.dark ? [255, 255, 255] : [0, 0, 0];
                    over(extreme).forEach((value, channel) => expect(Math.abs(value - rgb(solid)[channel]!)).toBeLessThanOrEqual(0.15 * 255 + 2));
                }
            }
        });
        it('leaves a customized tint, intensity or preset exactly as set over a live picture', () => {
            for (const settings of [
                { glassSurfaceMaterials: glassPresetMaterials('auto'), glassTintIntensity: 0 },
                { glassSurfaceMaterials: glassPresetMaterials('auto'), glassTintIntensity: 100 },
                { glassSurfaceMaterials: glassPresetMaterials('auto', 'strong'), glassBlurIntensity: 'strong' as const },
                { glassSurfaceMaterials: glassPresetMaterials('everywhere') },
            ]) {
                for (const theme of [darkTheme, lightTheme]) {
                    const ground = { page: theme.colors.surface.base, solid: theme.colors.edge.floatingFill };
                    expect(resolveGlassBackdropMap(settings, 'floating', theme.dark, {}, ground, 'livePicture'))
                        .toEqual(resolveGlassBackdropMap(settings, 'floating', theme.dark, {}, ground, false));
                }
            }
        });
        for (const tint of [0, 12, 50, 73, 100]) {
            for (const theme of [darkTheme, lightTheme]) {
                for (const group of ['card', 'floating'] as const) {
                    for (const preset of ['auto', 'everywhere', 'clear'] as const) {
                        for (const atmosphereBehind of group === 'card' ? ['band', 'wallpaper'] as const : ['none', 'band'] as const) {
                            it(`${tint} ${theme.dark ? 'dark' : 'light'} ${group} ${preset} over ${atmosphereBehind}`, () => {
                                const { map, paint, out } = render(theme, group, preset, atmosphereBehind, rgb(theme.colors.surface.base), tint);
                                out.forEach((value, channel) => expect(Math.abs(value - paint[channel]!)).toBeLessThanOrEqual(1));
                                // contrast() pivots at mid-grey and lifts a dark page into a grey slab.
                                expect(map.tone).not.toMatch(/contrast\(/);
                                // DESIGN forbids desaturating glass.
                                expect(map.tone).toMatch(/saturate\(1\.05\)/);
                            });
                        }
                    }
                }
            }
            if (tint < 50) continue;
            it(`${tint}: compresses a bright picture under dark glass so primary ink stays legible, keeping its hue`, () => {
                for (const group of ['card', 'floating'] as const) {
                    const page = rgb(darkTheme.colors.surface.base);
                    const k = tint === 50 ? 0.45 : 0.45 + (tint - 50) / 50 * (0.35 - 0.45);
                    const { paint, out } = render(darkTheme, group, 'auto', 'band', sky, tint);
                    // out = k·X + c with c fixed by the page: the sky maps to the compressed value.
                    out.forEach((value, channel) => expect(Math.abs(value - (paint[channel]! + k * (sky[channel]! - page[channel]!)))).toBeLessThanOrEqual(2));
                    expect(out[0]).toBeGreaterThan(out[2]! + 15);
                    expect(glassContrastRatio(out, rgb(darkTheme.colors.text.primary))).toBeGreaterThanOrEqual(4.5);
                }
            });
            it(`${tint}: keeps light glass hanging from white, so the darkest backdrop still carries primary ink`, () => {
                for (const group of ['card', 'floating'] as const) {
                    const { out } = render(lightTheme, group, 'auto', 'band', [0, 0, 0], tint);
                    expect(glassContrastRatio(out, rgb(lightTheme.colors.text.primary))).toBeGreaterThanOrEqual(4.5);
                }
            });
        }
        it('passes a picture through Subtle glass as monocode does: blur, no dim and no wash', () => {
            const luminance = (rgb: readonly number[]) => Color.rgb(rgb as number[]).luminosity();
            // The balloons' sky, the blurred ferris wheel sky (measured live) and a bright cloud.
            for (const backdrop of [sky, FERRIS_SKY, [236, 240, 244]] as [number, number, number][]) {
                for (const group of ['card', 'floating'] as const) {
                    const label = `${group} over ${backdrop.join(',')}`;
                    // Light paint is the page itself: the inside stays within ±5% of the backdrop's luminance.
                    const { out: light } = render(lightTheme, group, 'auto', 'band', backdrop, 0);
                    expect.soft(Math.abs(luminance(light) / luminance(backdrop) - 1), `light ${label}`).toBeLessThanOrEqual(0.05);
                    // Dark keeps k = 1: the backdrop's lightness moves only by the surface's own paint step
                    // over the page (luma, which saturate(1.05) preserves), never dimmed or washed further.
                    const { out: dark, paint } = render(darkTheme, group, 'auto', 'band', backdrop, 0);
                    const luma = (value: readonly number[]) => 0.213 * value[0]! + 0.715 * value[1]! + 0.072 * value[2]!;
                    const step = luma(paint) - luma(rgb(darkTheme.colors.surface.base));
                    expect.soft(luma(dark) - luma(backdrop), `dark ${label}`).toBeGreaterThanOrEqual(-1);
                    expect.soft(luma(dark) - luma(backdrop), `dark ${label}`).toBeLessThanOrEqual(step + 1);
                }
            }
        });
        it('lets an ordinary page show through Subtle and Medium dark floating glass unchanged, like the monocode reference', () => {
            const page = rgb(darkTheme.colors.surface.base);
            const row: [number, number, number] = [60, 54, 52];
            for (const tint of [0, 12, 50]) {
                const { out: overPage } = render(darkTheme, 'floating', 'auto', 'none', page, tint);
                const { out: overRow } = render(darkTheme, 'floating', 'auto', 'none', row, tint);
                overRow.forEach((value, channel) => expect(Math.abs((value - overPage[channel]!) - (row[channel]! - page[channel]!))).toBeLessThanOrEqual(1.5));
            }
        });
        it('carries Subtle dark glass in a thin warm coat with no neutral lift, instead of a neutral ink hair', () => {
            for (const group of ['card', 'floating'] as const) {
                const { map, opacity } = render(darkTheme, group, 'auto', 'band', sky, 0);
                const [r, g] = rgb(map.coat!);
                expect(r).toBeGreaterThan(g!);
                // A neutral lift (invert/brightness) would grey the dark parts of the picture.
                expect(map.tone).not.toMatch(/invert/);
                // As thin as the fixed point allows.
                expect(opacity).toBeLessThanOrEqual(0.07);
            }
        });
    });
    it('leaves unbacked, solid, Reduce Transparency and authored Elements and floating surfaces untoned', () => {
        const ground = { page: darkTheme.colors.surface.base, solid: darkTheme.colors.edge.cardFill };
        for (const preset of ['auto', 'everywhere', 'clear'] as const) {
            const settings = { glassSurfaceMaterials: glassPresetMaterials(preset) };
            expect(resolveGlassBackdropMap(settings, 'card', true, {}, ground)).toBeNull();
            expect(resolveGlassBackdropMap(settings, 'card', true, { atmosphereBehind: 'wallpaper', reduceTransparency: true }, ground)).toBeNull();
            expect(resolveGlassBackdropMap(settings, 'floating', false, { reduceTransparency: true }, ground)).toBeNull();
        }
        expect(resolveGlassBackdropMap({ glassSurfaceMaterials: glassPresetMaterials('solid') }, 'card', true, { atmosphereBehind: 'wallpaper' }, ground)).toBeNull();
        // An authored table (not a named preset) keeps its exact material, untoned.
        const auto = { glassSurfaceMaterials: glassPresetMaterials('auto') };
        const custom = { ...auto, ...resolveGlassSurfaceSettingsDelta(auto, 'card', { opacity: 0.33 }) };
        expect(resolveGlassSurfaceMaterial(custom, 'card', { atmosphereBehind: 'wallpaper' }).material.opacity).toBe(0.33);
        expect(resolveGlassBackdropMap(custom, 'card', true, { atmosphereBehind: 'wallpaper' }, ground)).toBeNull();
        expect(resolveGlassBackdropMap(custom, 'floating', true, {}, ground)).toBeNull();
    });
    it('selects Clear with strong blur and low coats, round-trips through existing settings and preserves exact custom values', () => {
        const settings = { glassBlurIntensity: 'regular' as const };
        const clear = { ...settings, ...resolveGlassPresetSettingsDelta(settings, 'clear') };
        expect(readGlassPreset(clear)).toBe('clear');
        expect(clear.glassBlurIntensity).toBe('strong');
        for (const group of GLASS_SURFACE_GROUPS) {
            const material = readGlassMaterials(clear)[group];
            expect(material.blur).toBe('strong');
            expect(material.opacity).toBeGreaterThan(0);
            expect(material.opacity).toBeLessThanOrEqual(group === 'card' ? 0.5 : 0.1);
        }
        expect(readGlassMaterials(clear).floating.opacity).toBe(0.02);
        const custom = { ...clear, ...resolveGlassSurfaceSettingsDelta(clear, 'floating', { opacity: 0.013 }) };
        expect(readGlassPreset(custom)).toBe('custom');
        expect(resolveGlassSurfaceMaterial(custom, 'floating').material.opacity).toBe(0.013);
        expect(resolveGlassSurfaceMaterial(clear, 'floating', { reduceTransparency: true }).material).toEqual({ blur: 'off', opacity: 1 });
        expect(readGlassPreset({})).toBe('auto');
    });
    it('reads predecessor off and all three intensity values without requiring a new table', () => {
        expect(readGlassPreset({ glassBlurEnabled: false, glassBlurIntensity: 'strong' })).toBe('solid');
        for (const glassBlurIntensity of ['light', 'regular', 'strong'] as const) {
            const materials = readGlassMaterials({ glassBlurEnabled: true, glassBlurIntensity });
            expect(materials.floating).toEqual({ blur: 'strong', opacity: 0.02 });
            expect(materials.chrome.blur).toBe(glassBlurIntensity);
            expect(materials.content.blur).toBe(glassBlurIntensity);
        }
    });

    it('defaults Auto to the layered W3 coats, not chrome-only or uniform Everywhere', () => {
        const materials = readGlassMaterials({});
        expect(materials.chrome).toEqual({ blur: 'regular', opacity: 0.70 });
        expect(materials.sidebar.opacity).toBeCloseTo(0.754);
        expect(materials.content).toEqual({ blur: 'regular', opacity: 0.84 });
        expect(materials.floating).toEqual({ blur: 'strong', opacity: 0.02 });
        expect(resolveGlassSurfaceMaterial({}, 'content', { desktopWindow: true, nativeWindowMaterialLive: true }).material)
            .toEqual(materials.content);
    });

    it('keeps custom transparency active even when every blur step is Off', () => {
        const start = { glassBlurEnabled: false };
        const custom = { ...start, ...resolveGlassSurfaceSettingsDelta(start, 'content', { opacity: 0 }) };
        expect(custom.glassBlurEnabled).toBe(true);
        expect(readGlassPreset(custom)).toBe('custom');
        expect(readGlassMaterials(custom).content).toEqual({ blur: 'off', opacity: 0 });
    });

    it('lets predecessor clients re-enable glass after a current client selected Solid', () => {
        const settings = { glassBlurEnabled: true, glassBlurIntensity: 'regular' as const };
        const solid = { ...settings, ...resolveGlassPresetSettingsDelta(settings, 'solid') };
        expect(readGlassPreset(solid)).toBe('solid');
        expect(readGlassPreset({ ...solid, glassBlurEnabled: true })).toBe('auto');
    });

    it('stores named tables and edits only the requested group, making the choice Custom', () => {
        const start = { glassBlurEnabled: true, glassBlurIntensity: 'regular' as const };
        const everywhere = { ...start, ...resolveGlassPresetSettingsDelta(start, 'everywhere') };
        expect(readGlassPreset(everywhere)).toBe('everywhere');
        expect(readGlassMaterials(everywhere).chrome).toEqual({ blur: 'regular', opacity: 0.70 });
        expect(readGlassMaterials(everywhere).floating).toEqual({ blur: 'strong', opacity: 0.02 });
        const custom = { ...everywhere, ...resolveGlassSurfaceSettingsDelta(everywhere, 'content', { opacity: 0, blur: 'strong' }) };
        expect(readGlassPreset(custom)).toBe('custom');
        expect(custom.glassSurfaceMaterials.floating).toEqual(everywhere.glassSurfaceMaterials?.floating);
        expect(resolveGlassSurfaceMaterial(custom, 'content', { desktopWindow: true, nativeWindowMaterialLive: true, highContrast: true }).material)
            .toEqual({ blur: 'strong', opacity: 0 });
    });

    it('keeps choice stored while Reduce Transparency and inactive windows temporarily resolve Solid', () => {
        const settings = { glassSurfaceMaterials: glassPresetMaterials('everywhere') };
        expect(resolveGlassSurfaceMaterial(settings, 'floating', { reduceTransparency: true })).toEqual({ material: { blur: 'off', opacity: 1 }, reason: 'reduceTransparency' });
        expect(resolveGlassSurfaceMaterial(settings, 'floating', { windowActive: false }).material.blur).toBe('off');
        expect(readGlassPreset(settings)).toBe('everywhere');
        expect(resolveGlassSurfaceMaterial(settings, 'floating').material.blur).toBe('strong');
    });

    it('resolves Auto per device and refuses to clear desktop fills before native material is live', () => {
        const settings = {};
        expect(resolveGlassSurfaceMaterial(settings, 'chrome').material.blur).toBe('off');
        expect(resolveGlassSurfaceMaterial(settings, 'chrome', { desktopWindow: true }).reason).toBe('unavailable');
        expect(resolveGlassSurfaceMaterial(settings, 'chrome', { desktopWindow: true, nativeWindowMaterialLive: true }).material.blur).toBe('regular');
        expect(resolveGlassSurfaceMaterial(settings, 'floating').material.blur).toBe('strong');
    });

    it('uses blur Off without discarding exact custom opacity on supported surfaces', () => {
        const settings = { glassSurfaceMaterials: { ...glassPresetMaterials('everywhere'), content: { blur: 'off' as const, opacity: 0.1 } } };
        expect(resolveGlassSurfaceMaterial(settings, 'content', { desktopWindow: true, nativeWindowMaterialLive: true }).material)
            .toEqual({ blur: 'off', opacity: 0.1 });
    });

    it('updates preset blur uniformly without overriding custom opacity', () => {
        const settings = { glassSurfaceMaterials: { ...glassPresetMaterials('everywhere'), floating: { blur: 'light' as const, opacity: 0.12 } } };
        const updated = resolveGlassIntensitySettingsDelta(settings, 'strong');
        expect(updated.glassSurfaceMaterials?.floating).toEqual({ blur: 'strong', opacity: 0.12 });
    });

    it('keeps every named floating preset clear and strongly frosted across intensity changes, leaving stored custom tables exact', () => {
        for (const preset of ['auto', 'everywhere', 'clear'] as const) {
            for (const intensity of ['light', 'regular', 'strong'] as const) {
                const settings = { glassBlurIntensity: intensity, ...resolveGlassPresetSettingsDelta({ glassBlurIntensity: intensity }, preset) };
                const updated = { ...settings, ...resolveGlassIntensitySettingsDelta(settings, intensity) };
                expect(readGlassPreset(updated)).toBe(preset);
                // The floating coat follows the tint (Subtle by default); the frost stays Strong.
                expect(resolveGlassSurfaceMaterial(updated, 'floating').material).toEqual({ blur: 'strong', opacity: readGlassTintedMaterials(updated).floating.opacity });
                expect(readGlassMaterials(updated).chrome.blur).toBe(intensity);
            }
        }
        const table = { ...glassPresetMaterials('everywhere'), floating: { blur: 'light' as const, opacity: 0.013 } };
        const custom = { glassSurfaceMaterials: table };
        expect(readGlassMaterials(custom)).toBe(table);
        expect(resolveGlassSurfaceMaterial(custom, 'floating').material).toBe(table.floating);
        expect(readGlassPreset(custom)).toBe('custom');
    });

    it('admits the full custom range while rejecting unknown material fields and invalid values', () => {
        expect(GlassSurfaceMaterialsSchema.safeParse({ ...glassPresetMaterials('everywhere'), content: { blur: 'strong', opacity: 0 } }).success).toBe(true);
        expect(GlassSurfaceMaterialsSchema.safeParse({ ...glassPresetMaterials('everywhere'), content: { blur: 'strong', opacity: -0.1 } }).success).toBe(false);
        expect(GlassSurfaceMaterialsSchema.safeParse({ ...glassPresetMaterials('everywhere'), extra: {} }).success).toBe(false);
    });
});

describe('the notch paint', () => {
    const ink = '#0C0B0B';
    const live = { desktopWindow: true, nativeWindowMaterialLive: true };
    const coat = (settings: Parameters<typeof resolveGlassNotchPaint>[1], environment: Parameters<typeof resolveGlassNotchPaint>[2] = live) =>
        Color(resolveGlassNotchPaint(ink, settings, environment)).alpha();

    it('is the ink at the default coat, with the material behind it', () => {
        const paint = Color(resolveGlassNotchPaint(ink, {}, live));
        expect(paint.alpha()).toBeCloseTo(0.95);
        expect(paint.rgb().array().slice(0, 3)).toEqual([12, 11, 11]);
    });

    it.each([[0, 0.55], [6, 0.75], [12, 0.95], [100, 1]])('follows Tint %i to a coat of %f', (glassTintIntensity, expected) => {
        expect(coat({ glassTintIntensity })).toBeCloseTo(expected);
    });

    it('thickens with no step just past the default', () => {
        expect(coat({ glassTintIntensity: 13 })).toBeGreaterThan(0.95);
        expect(coat({ glassTintIntensity: 13 })).toBeLessThan(0.96);
    });

    it('is the same ink, solid, wherever no native material stands behind it', () => {
        expect(coat({}, { desktopWindow: true, nativeWindowMaterialLive: false })).toBe(1);
        expect(coat({}, { ...live, reduceTransparency: true })).toBe(1);
        expect(coat({ glassBlurEnabled: false })).toBe(1);
    });

    it('applies a custom floating opacity as set, with no floor', () => {
        const materials = glassPresetMaterials('auto', 'regular');
        expect(coat({ glassSurfaceMaterials: { ...materials, floating: { blur: 'strong', opacity: 0.4 } } })).toBeCloseTo(0.4);
    });
});
