import { Platform } from 'react-native';
import Color from 'color';
import { parseThemeColor } from '@/theme/parseThemeColor';
import { happierMaterialBackgroundPaint, happierMaterialInnerBackgroundPaint } from '@happier-dev/plugin-ui/presentation';
import { deriveThemePaint, deriveThemePaintResult, fixedThemePaint, type ThemePaint } from '@/theme/profiles/themePaint';
import { createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { GLASS_BLUR_RADIUS_PX, readGlassPreset, resolveGlassBackdropMapPaint, resolveGlassBackdropTone, resolveGlassPanelCoatOpacity, resolveGlassSurfaceMaterial, type GlassBackdropPaintMap, type GlassFloatingCoat, type GlassMaterialSettings, type GlassMaterialEnvironment, type GlassSurfaceGroup, type GlassSurfaceMaterial } from './glassMaterial';
import type { GlassCapability } from './resolveGlassCapability';
import { resolveGlassSurfacePlaneMaterial, type AtmosphereContentCoat } from './glassSurfaceColor';
export { resolveGlassSurfacePlaneMaterial, type AtmosphereContentCoat } from './glassSurfaceColor';

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
    const solid = fixedThemePaint(input.color);
    const ink = fixedThemePaint(input.ink);
    const page = input.page === undefined ? undefined : fixedThemePaint(input.page);
    const map = Platform.OS === 'web' && page ? resolveGlassBackdropMapPaint(input.settings, input.group, input.dark, input.environment ?? {}, {
        page, solid, ink, ...(input.controlFill === undefined ? {} : { controlFill: fixedThemePaint(input.controlFill) }),
    }, input.panel ?? false) : null;
    return resolveGlassTintPaint({ ...input, solid, ink, page, web: Platform.OS === 'web' }, map).color;
}

function resolveGlassTintPaint(input: Readonly<{ solid: ThemePaint; ink: ThemePaint; page?: ThemePaint; web: boolean; dark: boolean;
    settings: GlassMaterialSettings; group: GlassSurfaceGroup; environment?: GlassMaterialEnvironment; panel?: GlassFloatingCoat }>, map: GlassBackdropPaintMap | null): ThemePaint {
    if (input.web && input.page !== undefined) {
        if (map?.opaqueCoat) return input.solid;
        const color = parseThemeColor(input.solid.color);
        const page = parseThemeColor(input.page.color);
        if (color === null || page === null) return input.solid;
        // Keep the authored spelling when the coat is the paint itself.
        if (map?.coatPaint) return { ...map.coatPaint, color: map.coatPaint.color === color.rgb().round().string() ? input.solid.color : map.coatPaint.color };
    }
    return input.dark && input.group === 'floating' && !input.panel && readGlassPreset(input.settings) !== 'custom'
        && resolveGlassSurfaceMaterial(input.settings, input.group, input.environment).material.opacity < 1
        ? input.ink : input.solid;
}

/**
 * A translucent Elements fill (a page sheet's whisper of tint) stands for that tint over the page. As glass
 * the page under it is gone, so its coat keeps the page it stands for; opaque and unresolved fills pass.
 */
export function glassElementsCoatColor(authored: string, authoredPage: string): string {
    return glassElementsCoatPaint(fixedThemePaint(authored), fixedThemePaint(authoredPage)).color;
}

export function glassElementsCoatPaint(authored: ThemePaint, authoredPage: ThemePaint): ThemePaint {
    const result = deriveThemePaintResult([authored, authoredPage], (color, page) => {
        const fill = parseThemeColor(color);
        const ground = parseThemeColor(page);
        if (fill === null || ground === null || fill.alpha() >= 1 || fill.alpha() === 0) return { color, transformed: false };
        const alpha = fill.alpha();
        const [r, g, b] = fill.rgb().array();
        const [pr, pg, pb] = ground.rgb().array();
        return { color: Color.rgb(pr + (r - pr) * alpha, pg + (g - pg) * alpha, pb + (b - pb) * alpha).round().string(), transformed: true };
    });
    return result.transformed ? { color: result.color, source: result.source } : authored;
}

/** Shared presentation owner changes only paint alpha, never foreground opacity. */
export function glassSurfaceBackgroundColor(color: string, group: GlassSurfaceGroup, nested = false, plane = nested, coatOpacity?: number): string {
    return glassSurfaceBackgroundPaint(fixedThemePaint(color), group, Platform.OS === 'web', nested, plane, coatOpacity).color;
}

export function glassSurfaceBackgroundPaint(color: ThemePaint, group: GlassSurfaceGroup, web: boolean, nested: boolean, plane: boolean, coatOpacity?: number): ThemePaint {
    if (web && coatOpacity !== undefined) {
        if (group === 'floating' && coatOpacity === 1) return color;
        return deriveThemePaint([color], value => `color-mix(in srgb, ${value} ${coatOpacity * 100}%, transparent)`);
    }
    if (web && group === 'content' && plane) {
        const prefix = `--happier-glass-content-${nested ? 'nested-' : ''}`;
        return deriveThemePaint([color], value => `var(${prefix}plane-background-color, color-mix(in srgb, ${value} var(${prefix}plane-opacity, var(${prefix}opacity, 100%)), transparent))`);
    }
    return happierMaterialBackgroundPaint(color, group, web, nested, deriveThemePaint);
}

/** Resolved facts from the mounted surface; this does not decide capability or material policy. */
export type GlassSurfaceCompositionContext = Readonly<{
    settings: GlassMaterialSettings;
    environment: GlassMaterialEnvironment;
    web: boolean;
    group: GlassSurfaceGroup;
    nested: boolean;
    plane: boolean;
    noCoat: boolean;
    enabled: boolean;
    shellHeld: boolean;
    capability: GlassCapability;
    material: GlassSurfaceMaterial;
    inheritsTranslucentMaterial: boolean;
    hasNativeBackdrop: boolean;
    tintsWithoutBlur: boolean;
    panel: GlassFloatingCoat;
    atmosphereCoat?: AtmosphereContentCoat;
}>;

export function resolveGlassSurfaceSolidPaint(solid: ThemePaint, page: ThemePaint, shellHeld: boolean): ThemePaint {
    return shellHeld && solid.color !== 'transparent' ? page : solid;
}

type GlassSurfaceCoatInput = Readonly<{
    solid: ThemePaint; page: ThemePaint; ink: ThemePaint; controlFill: ThemePaint; dark: boolean;
    context: Pick<GlassSurfaceCompositionContext, 'settings' | 'group' | 'environment' | 'panel' | 'web' | 'noCoat'>;
}>;

export function resolveGlassSurfaceCoatPaint(input: GlassSurfaceCoatInput): Readonly<{ tint: ThemePaint; backdropTone: string; coatOpacity?: number }> {
    const { context } = input;
    if (context.noCoat) return { tint: fixedThemePaint('transparent'), backdropTone: '' };
    const ground = context.group === 'card' ? glassElementsCoatPaint(input.solid, input.page) : input.solid;
    const map = resolveGlassBackdropMapPaint(context.settings, context.group, input.dark, context.environment, {
        page: input.page, solid: ground, ink: input.ink, controlFill: input.controlFill,
    }, context.panel);
    const tint = resolveGlassTintPaint({ solid: ground, page: input.page, ink: input.ink, dark: input.dark, ...context }, map);
    return { tint, backdropTone: map?.tone ?? '', coatOpacity: context.web && map?.opaqueCoat ? 1 : map?.opacity };
}

function materialOpacityPaint(color: ThemePaint, opacity: number): ThemePaint {
    const result = deriveThemePaintResult([color], value => {
        const parsed = parseThemeColor(value);
        return { color: parsed?.alpha(opacity).rgb().string() ?? value, transformed: parsed !== null };
    });
    return result.transformed ? { color: result.color, source: result.source } : color;
}

export function resolveGlassSurfacePaintLayers(input: Readonly<{
    solid: ThemePaint; tint: ThemePaint; dark: boolean; coatOpacity?: number; context: GlassSurfaceCompositionContext;
}>): Readonly<{ background: ThemePaint; coat?: ThemePaint }> {
    const { solid, tint, context: c } = input;
    if (!c.web) {
        const coatOpacity = !c.hasNativeBackdrop ? undefined
            : c.atmosphereCoat === 'reading' ? c.material.opacity
            : c.group === 'floating' ? resolveGlassPanelCoatOpacity(c.settings, input.dark, c.panel, { nativeRenderer: true }) : undefined;
        const background = (c.plane && c.material.opacity === 0 && c.enabled) || c.hasNativeBackdrop || c.inheritsTranslucentMaterial
            ? fixedThemePaint('transparent') : c.tintsWithoutBlur && c.enabled ? materialOpacityPaint(tint, c.material.opacity) : solid;
        return { background, ...(coatOpacity === undefined ? {} : { coat: materialOpacityPaint(tint, coatOpacity) }) };
    }
    if (c.noCoat) return { background: fixedThemePaint('transparent') };
    const background = c.plane
        ? glassSurfaceBackgroundPaint(solid, c.group, true, c.nested, true, c.atmosphereCoat ? c.material.opacity : undefined)
        : c.inheritsTranslucentMaterial ? fixedThemePaint('transparent')
        : c.capability === 'webBlur' ? glassSurfaceBackgroundPaint(tint, c.group, true, c.group === 'card' ? false : c.nested, false, input.coatOpacity)
        : !c.enabled || (c.group === 'card' && c.material.opacity === 1) ? solid
        : glassSurfaceBackgroundPaint(c.group === 'card' ? tint : solid, c.group, true, c.group === 'card' ? false : c.nested, false);
    return { background };
}

/** The guide can use exactly the same compositor when the mounted instance supplied its facts. */
export function resolveGlassSurfaceCompositionPaint(input: Omit<GlassSurfaceCoatInput, 'context'> & Readonly<{ context: GlassSurfaceCompositionContext }>): Readonly<{
    solid: ThemePaint; tint: ThemePaint; backdropTone: string; coatOpacity?: number; background: ThemePaint; coat?: ThemePaint;
}> {
    const solid = resolveGlassSurfaceSolidPaint(input.solid, input.page, input.context.shellHeld);
    const coat = resolveGlassSurfaceCoatPaint({ ...input, solid });
    return { solid, ...coat, ...resolveGlassSurfacePaintLayers({ ...input, solid, ...coat }) };
}

/**
 * Working content in flow: a prompt, a tool card, a code frame, a reference chip. Solid, it is its own fill.
 * Over glass content it takes the material's inner translucent fill (the ink tint inner surfaces use) instead
 * of the page plane a picture clears, so it never turns into a slab or vanishes. `nested` is a fill inside
 * such a card: it clears over glass, so tints never stack, and keeps its own fill when solid.
 */
export function glassContentFill(color: string, colors: Readonly<{ surface: Readonly<{ selected: string }> }>, options?: Readonly<{ nested?: boolean }>): string {
    return glassContentFillPaint(fixedThemePaint(color), fixedThemePaint(colors.surface.selected), options).color;
}

export function glassContentFillPaint(color: ThemePaint, selected: ThemePaint, options?: Readonly<{ nested?: boolean }>): ThemePaint {
    return options?.nested
        ? happierMaterialBackgroundPaint(color, 'content', Platform.OS === 'web', true, deriveThemePaint)
        : happierMaterialInnerBackgroundPaint(color, selected, 'content', Platform.OS === 'web', paint => paint.color, deriveThemePaint);
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
