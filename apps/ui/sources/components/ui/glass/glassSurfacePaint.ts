import { Platform } from 'react-native';
import Color from 'color';
import { parseThemeColor } from '@/theme/parseThemeColor';
import { happierMaterialBackgroundColor, happierMaterialInnerBackgroundColor } from '@happier-dev/plugin-ui/presentation';
import { createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { GLASS_BLUR_RADIUS_PX, readGlassPreset, resolveGlassBackdropMap, resolveGlassReadingCoatOpacity, resolveGlassBackdropTone, resolveGlassSurfaceMaterial, type GlassFloatingCoat, type GlassMaterialSettings, type GlassMaterialEnvironment, type GlassSurfaceGroup, type GlassSurfaceMaterial } from './glassMaterial';

/** Clear only the page coat. Functional surfaces still resolve their own material and accessibility overrides. */
export type AtmosphereContentCoat = 'opaque' | 'reading';

export function resolveGlassSurfacePlaneMaterial(settings: GlassMaterialSettings, group: GlassSurfaceGroup, environment: GlassMaterialEnvironment = {}, coat?: AtmosphereContentCoat, dark = false): GlassSurfaceMaterial {
    if (group === 'content' && coat) {
        if (coat === 'opaque') return { blur: 'off', opacity: 1 };
        return { ...resolveGlassSurfaceMaterial(settings, group, environment).material, opacity: resolveGlassReadingCoatOpacity(settings, environment, dark) };
    }
    if (group === 'content' && (environment.atmosphereBehind === 'band' || environment.atmosphereBehind === 'wallpaper')) {
        return { blur: 'off', opacity: 0 };
    }
    return resolveGlassSurfaceMaterial(settings, group, environment).material;
}

/** Shell filters are inert siblings of the content, never properties of its ancestors. */
export function glassSurfacePlaneBackdropStyle(settings: GlassMaterialSettings, group: GlassSurfaceGroup, dark: boolean, environment: GlassMaterialEnvironment, coat?: AtmosphereContentCoat) {
    const reading = group === 'content' && coat === 'reading'
        && (environment.atmosphereBehind === 'band' || environment.atmosphereBehind === 'wallpaper');
    if (!reading && (environment.atmosphereBehind !== 'wallpaper' || (group !== 'chrome' && group !== 'sidebar'))) return null;
    const material = resolveGlassSurfacePlaneMaterial(settings, group, environment, coat, dark);
    if (material.blur === 'off' || material.opacity === 1) return null;
    return createBackdropWebStyle({
        backgroundColor: 'transparent',
        surfaceGroup: group,
        blurPx: GLASS_BLUR_RADIUS_PX[material.blur],
        backdropTone: resolveGlassBackdropTone(settings, group, dark, environment),
    });
}

/**
 * The coat colour of a glass surface. On web, named-preset Elements and floating surfaces take the
 * fixed-point coat of `resolveGlassBackdropMap`, so over the plain `page` the glass equals its solid
 * paint. Native renderers have no backdrop tone: a named dark menu's hair of coat uses low-alpha ink
 * there. A panel's heavy coat carries its own surface (an ink coat turned a dark dialog near-white,
 * NATIVE-STABILITY M1). Custom and solid retain their authored color.
 */
export function glassSurfaceTintColor(input: Readonly<{ color: string; ink: string; controlFill?: string; dark: boolean; settings: GlassMaterialSettings; group: GlassSurfaceGroup; environment?: GlassMaterialEnvironment; page?: string; panel?: GlassFloatingCoat }>): string {
    if (Platform.OS === 'web' && input.page !== undefined) {
        const color = parseThemeColor(input.color);
        const page = parseThemeColor(input.page);
        if (color === null || page === null) return input.color;
        const coat = resolveGlassBackdropMap(input.settings, input.group, input.dark, input.environment, {
            page: page.rgb().string(), solid: color.rgb().string(), ink: input.ink, controlFill: input.controlFill,
        }, input.panel ?? false)?.coat;
        // Keep the authored spelling when the coat is the paint itself.
        if (coat) return coat === color.rgb().round().string() ? input.color : coat;
    }
    return input.dark && input.group === 'floating' && !input.panel && readGlassPreset(input.settings) !== 'custom'
        && resolveGlassSurfaceMaterial(input.settings, input.group, input.environment).material.opacity < 1
        ? input.ink : input.color;
}

/**
 * A translucent Elements fill (a page sheet's whisper of tint) stands for that tint over the page. As glass
 * the page under it is gone, so its coat keeps the page it stands for; opaque and unresolved fills pass.
 */
export function glassElementsCoatColor(authored: string, authoredPage: string): string {
    const fill = parseThemeColor(authored);
    const ground = parseThemeColor(authoredPage);
    if (fill === null || ground === null) return authored;
    const alpha = fill.alpha();
    // Opaque fills are already the paper; a fully clear fill draws no paper to keep.
    if (alpha >= 1 || alpha === 0) return authored;
    const [r, g, b] = fill.rgb().array();
    const [pr, pg, pb] = ground.rgb().array();
    return Color.rgb(pr + (r - pr) * alpha, pg + (g - pg) * alpha, pb + (b - pb) * alpha).round().string();
}

/** Shared presentation owner changes only paint alpha, never foreground opacity. */
export function glassSurfaceBackgroundColor(color: string, group: GlassSurfaceGroup, nested = false, plane = nested, coatOpacity?: number): string {
    if (Platform.OS === 'web' && coatOpacity !== undefined) {
        return `color-mix(in srgb, ${color} ${coatOpacity * 100}%, transparent)`;
    }
    if (Platform.OS === 'web' && group === 'content' && plane) {
        const prefix = `--happier-glass-content-${nested ? 'nested-' : ''}`;
        return `var(${prefix}plane-background-color, color-mix(in srgb, ${color} var(${prefix}plane-opacity, var(${prefix}opacity, 100%)), transparent))`;
    }
    return happierMaterialBackgroundColor(color, group, Platform.OS === 'web', nested);
}

/**
 * Working content in flow: a prompt, a tool card, a code frame, a reference chip. Solid, it is its own fill.
 * Over glass content it takes the material's inner translucent fill (the ink tint inner surfaces use) instead
 * of the page plane a picture clears, so it never turns into a slab or vanishes. `nested` is a fill inside
 * such a card: it clears over glass, so tints never stack, and keeps its own fill when solid.
 */
export function glassContentFill(color: string, colors: Readonly<{ surface: Readonly<{ selected: string }> }>, options?: Readonly<{ nested?: boolean }>): string {
    return options?.nested
        ? glassSurfaceBackgroundColor(color, 'content', true, false)
        : happierMaterialInnerBackgroundColor(color, colors.surface.selected, 'content', Platform.OS === 'web');
}

/**
 * The navigation theme's background, which react-navigation paints behind every stack screen. It is the
 * opaque chrome canvas, except while the atmosphere paints behind the active surface (`atmosphereBehind`):
 * then it clears so the one atmosphere layer shows through, and every route the atmosphere does not
 * cover keeps its opaque chrome. A desktop overlay window is always clear.
 */
export function glassNavigationBackgroundColor(canvas: string, environment: GlassMaterialEnvironment, overlayWindow = false): string {
    if (overlayWindow || environment.atmosphereBehind === 'band' || environment.atmosphereBehind === 'wallpaper') return 'transparent';
    return glassSurfaceBackgroundColor(canvas, 'chrome', true);
}

/**
 * The shell owns one coat plane per group; inner paints only inherit it. A plane lies on the window
 * canvas, with the atmosphere beneath it when mounted. It paints the tint only: a `backdrop-filter`
 * on the content ancestor would make the plane a backdrop root and
 * cut every floating surface opened inside it (a column's menus and popovers) off the page behind.
 * A plane that floats over content (the column peek) paints through `GlassSurface` instead.
 */
export function glassSurfacePlaneStyle(color: string, group: GlassSurfaceGroup): Readonly<{ backgroundColor: string }> {
    return { backgroundColor: glassSurfaceBackgroundColor(color, group, false, true) };
}
