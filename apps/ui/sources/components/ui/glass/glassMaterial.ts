import Color from 'color';
import { parseThemeColor } from '@/theme/parseThemeColor';
import { GLASS_BACKED_FAINT_INK_SHARE } from './glassBackedInk';
export { readThemeDocumentColor as readGlassDocumentColor } from '@/theme/parseThemeColor';
import { DEFAULT_GLASS_TINT_INTENSITY, readGlassMaterials, readGlassPreset, readGlassTintedMaterials, readGlassTintIntensity, resolveGlassTintValues } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
import type { GlassMaterialSettings, GlassSurfaceGroup, GlassSurfaceMaterial } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
export { GLASS_PRESETS, GLASS_SURFACE_GROUPS, GLASS_BLUR_STEPS, GLASS_BLUR_INTENSITY, GLASS_BLUR_RADIUS_PX, glassPresetMaterials, readGlassMaterials, readGlassPreset, readGlassTintedMaterials, readGlassTintIntensity, resolveGlassPresetSettingsDelta, resolveGlassSurfaceSettingsDelta, resolveGlassIntensitySettingsDelta, resolveGlassTintSettingsDelta } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
export type { GlassBlurStep, GlassSurfaceGroup, GlassSurfaceMaterial, GlassSurfaceMaterials, GlassPreset, GlassMaterialChoice, GlassMaterialSettings } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';

export type GlassMaterialEnvironment = Readonly<{
    desktopWindow?: boolean;
    nativeWindowMaterialLive?: boolean;
    reduceTransparency?: boolean;
    highContrast?: boolean;
    windowActive?: boolean;
    atmosphereBehind?: 'none' | 'band' | 'wallpaper';
    /** The measured tone of the picture behind content, published by the atmosphere while it covers an area. */
    atmosphereTone?: GlassAtmosphereTone;
    /**
     * Native renderers have no web backdrop tone, and in-flow Elements there are a coat without blur:
     * they keep the stored (Medium) coats instead of the tint's, so a Subtle hair never leaves a card bare.
     */
    nativeRenderer?: boolean;
}>;

/**
 * Relative luminance (0–1) of the picture where content sits: the near-darkest and near-lightest of the
 * content column (where cards can stand), and the middle around the column's centre (where head lines stand on the
 * picture itself). Default glass and ink derive from it, so they stay legible over pictures that run
 * against the theme.
 */
export type GlassAtmosphereTone = Readonly<{
    dark: number;
    light: number;
    focus: number;
    /**
     * The ink of the Wallpaper plane, where head lines stand on the picture itself: the atmosphere decides it
     * together with the haze under them (`resolveWallpaperHaze`). Absent means the theme's.
     */
    ink?: 'theme' | 'page';
}>;

export type GlassSurfaceResolution = Readonly<{
    material: GlassSurfaceMaterial;
    reason: 'reduceTransparency' | 'inactiveWindow' | 'noBacking' | 'unsupported' | 'unavailable' | null;
}>;

/** Stored choices survive accessibility and window-focus overrides. Never fade foreground content. */
export function resolveGlassSurfaceMaterial(settings: GlassMaterialSettings, group: GlassSurfaceGroup, environment: GlassMaterialEnvironment = {}): GlassSurfaceResolution {
    const requested = (environment.nativeRenderer === true ? readGlassMaterials(settings) : readGlassTintedMaterials(settings))[group];
    // A shown Wallpaper lies under the title bar, rail and sidebar, so for them it is a backing like desktop glass
    // (owner ruling 2026-10-23): their stored material applies. Solid stays opaque because its stored material is.
    const overWallpaper = environment.atmosphereBehind === 'wallpaper' && (group === 'chrome' || group === 'sidebar');
    const reason: GlassSurfaceResolution['reason'] = environment.reduceTransparency ? 'reduceTransparency'
        : environment.windowActive === false ? 'inactiveWindow'
        : group === 'card' && environment.atmosphereBehind !== 'band' && environment.atmosphereBehind !== 'wallpaper'
            && resolveGlassSurfaceMaterial(settings, 'content', environment).material.opacity === 1 ? 'noBacking'
        : overWallpaper ? null
        : environment.desktopWindow !== true && ((group === 'content' && environment.atmosphereBehind !== 'band' && environment.atmosphereBehind !== 'wallpaper')
            || (group !== 'floating' && group !== 'card' && readGlassPreset(settings) === 'auto')) ? 'unsupported'
        : environment.desktopWindow === true && group !== 'floating' && group !== 'card' && environment.nativeWindowMaterialLive !== true ? 'unavailable'
        : null;
    return {
        material: reason ? { blur: 'off' as const, opacity: 1 } : requested,
        reason,
    };
}

/**
 * The plain page a surface stands on and the solid paint it shows there. Theme variables are resolved live.
 * `ink` is the theme's primary ink: with a measured picture tone, default glass keeps it legible, also under
 * `controlFill`, the translucent fill a control nested in the glass paints over it (a bordered pill).
 */
export type GlassBackdropGround = Readonly<{ page: string; solid: string; ink?: string; controlFill?: string }>;

/**
 * Glass composites the filtered backdrop and coat C at opacity α. Before filter clipping, brightness
 * and lift form an affine map, followed by saturation. `tone` is that filter; `coat` is C.
 */
export type GlassBackdropMap = Readonly<{ tone: string; coat: string | null; opacity?: number }>;

/**
 * How a floating surface declares its job. Panels (centred dialogs, phone sheets and large anchored
 * panels such as Add widget, About this widget or Workflow run inputs) carry the page at a heavy coat
 * behind their blur, as monocode's modals do (the page colour at 55% in dark at Subtle); menus,
 * tooltips and small popovers keep the tint's hair (owner, 2026-10-16). Over the plain page a panel
 * still lands on its floating paint. Coats interpolate with the global tint.
 */
export type FloatingSurfaceRole = 'menu' | 'panel';
/**
 * The coat a floating surface carries: the tint's hair (`false`), the tint's panel coat (`true`), or,
 * over a live picture (a shared screen or browser page: arbitrary pixels, not atmosphere), Strong's
 * panel coat, so a black terminal never turns a light menu into a grey wash of itself. Only the shipped
 * default glass takes it: a customized preset, blur or tint applies as set there too (owner, 2026-10-04).
 */
export type GlassFloatingCoat = boolean | 'livePicture';
const GLASS_LIVE_PICTURE_PANEL_COAT = resolveGlassTintValues(100).panelCoat;

/** The glass the app ships with: the Auto preset at regular blur and the default tint. Anything else is the person's choice. */
function isDefaultGlassAppearance(settings: GlassMaterialSettings): boolean {
    return readGlassPreset(settings) === 'auto' && (settings.glassBlurIntensity ?? 'regular') === 'regular'
        && readGlassTintIntensity(settings.glassTintIntensity) === DEFAULT_GLASS_TINT_INTENSITY;
}

const toneNumber = (value: number) => String(Math.round(value * 1000) / 1000);
const parseRgb = (value: string): readonly [number, number, number] | null => {
    const color = parseThemeColor(value);
    if (color === null || color.alpha() < 1) return null;
    const [r, g, b] = color.rgb().array();
    return [r! / 255, g! / 255, b! / 255];
};

/**
 * Solves against the applied, rounded filter including clipping and saturation. A neutral lift is
 * used only where a feasible coat carries the target and k < 1 − α. Saturated authored fills can exceed that coat's
 * gamut: raise α just enough to reach every channel, dropping the lift when that permits a thinner
 * feasible coat, rather than clamp the coat.
 * This is colour feasibility for named materials, never a legibility floor on custom opacity.
 */
function solveGlassFixedPoint(compression: number, alpha: number, ground: GlassBackdropGround | null): GlassBackdropMap {
    const page = ground ? parseRgb(ground.page) : null;
    const solid = ground ? parseRgb(ground.solid) ?? page : null;
    const scale = compression / (1 - alpha);
    if (!page || !solid || alpha <= 0) return { tone: `brightness(${toneNumber(scale)}) saturate(1.05)`, coat: null };
    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    // CSS saturate(1.05)'s sRGB matrix, expressed using its luminance weights.
    const saturate = (rgb: readonly number[]) => {
        const luminance = 0.213 * rgb[0]! + 0.715 * rgb[1]! + 0.072 * rgb[2]!;
        return rgb.map(value => clamp(luminance + 1.05 * (value - luminance)));
    };
    const saturatedPage = saturate(page);
    const spread = solid.map((value, channel) => value - compression * saturatedPage[channel]!);
    const allowLift = compression < 1 - alpha;
    const lift = allowLift ? Math.max(0, (Math.max(...spread) - alpha) / (1 - alpha)) : 0;
    const filter = (neutralLift: number, unliftedScale = scale) => {
        if (neutralLift === 0) return {
            tone: `brightness(${toneNumber(unliftedScale)}) saturate(1.05)`,
            backdrop: saturate(page.map(value => clamp(value * Number(toneNumber(unliftedScale))))),
        };
        // Evaluate the exact rounded CSS coefficients, clamping at each filter boundary.
        const total = Number(toneNumber(scale + neutralLift));
        const pivot = Number(toneNumber(scale / (scale + neutralLift)));
        return {
            tone: `invert(1) brightness(${pivot}) invert(1) brightness(${total}) saturate(1.05)`,
            backdrop: saturate(page.map(value => clamp((1 - clamp((1 - value) * pivot)) * total))),
        };
    };
    let { tone, backdrop } = filter(lift);
    const coatFor = (opacity: number) => solid.map((value, channel) => (value - (1 - opacity) * backdrop[channel]!) / opacity);
    const feasibleOpacity = (filtered: readonly number[]) => Math.max(alpha, ...solid.map((value, channel) => {
        const behind = filtered[channel]!;
        return value >= behind ? (behind === 1 ? 0 : (value - behind) / (1 - behind))
            : (behind - value) / behind;
    }));
    let opacity = alpha;
    let coat = coatFor(opacity);
    const infeasible = () => coat.some(value => value < -0.002 || value > 1.002);
    if (!allowLift) {
        // Without a lift, thicken the coat and re-derive the brightness at that coat, so the backdrop
        // keeps exactly k. The required coat grows with its own brightness, so this converges in a few steps.
        for (let step = 0; step < 8 && infeasible(); step++) {
            opacity = feasibleOpacity(backdrop);
            ({ tone, backdrop } = filter(0, compression / (1 - opacity)));
            coat = coatFor(opacity);
        }
        coat = coat.map(clamp);
    } else if (coat.some(value => value < 0 || value > 1)) {
        opacity = feasibleOpacity(backdrop);
        const unlifted = filter(0);
        const unliftedOpacity = feasibleOpacity(unlifted.backdrop);
        // Keep the lift when rounding only needs a slight α adjustment; saturated targets can use
        // a much thinner feasible coat without it. Both candidates solve the actual clipped filter.
        if (unliftedOpacity < opacity) {
            ({ tone, backdrop } = unlifted);
            opacity = unliftedOpacity;
        }
        coat = coatFor(opacity);
    }
    return { tone, coat: Color.rgb(coat.map(value => value * 255)).round().string(),
        ...(opacity !== alpha ? { opacity } : {}) };
}

/**
 * Body ink keeps 4.5:1 and the faint step 3:1 over default glass (DESIGN.md). The solve below ignores the
 * filter's saturation and rounding, so it aims a few percent above both.
 */
const LEGIBLE_BODY_CONTRAST = 4.5 * 1.03;
const LEGIBLE_FAINT_CONTRAST = 3 * 1.03;
const relativeLuminance = (rgb: readonly number[]) => {
    const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
};
const contrast = (a: readonly number[], b: readonly number[]) => {
    const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
    return (high! + 0.05) / (low! + 0.05);
};
/** The sRGB grey with relative luminance `luminance`. */
const greyOf = (luminance: number) => {
    const linear = Math.min(1, Math.max(0, luminance));
    return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
};

/**
 * The most backdrop a named material lets through over the measured picture. The glass is the surface's
 * solid paint plus `compression` × (picture − page), so where the picture runs against the theme (its darkest
 * under light ink, its lightest under dark ink) the compression drops just far enough for the
 * theme's ink to keep its contrast. Pictures that agree with the theme, and the plain page, change nothing.
 */
function legibleCompression(compression: number, dark: boolean, tone: GlassAtmosphereTone | undefined, ground: GlassBackdropGround | null): number {
    const page = ground ? parseRgb(ground.page) : null;
    const solid = ground ? parseRgb(ground.solid) ?? page : null;
    const ink = ground?.ink ? parseRgb(ground.ink) : null;
    if (!tone || !page || !solid || !ink) return compression;
    const picture = greyOf(dark ? tone.light : tone.dark);
    const fill = ground?.controlFill ? parseThemeColor(ground.controlFill) : null;
    const fillRgb = fill ? fill.rgb().array().map(value => value / 255) : null;
    const fillAlpha = fill ? fill.alpha() : 0;
    const holds = (k: number) => {
        const glass = solid.map((value, channel) => Math.min(1, Math.max(0, value + k * (picture - page[channel]!))));
        const faint = ink.map((value, channel) => value * GLASS_BACKED_FAINT_INK_SHARE + glass[channel]! * (1 - GLASS_BACKED_FAINT_INK_SHARE));
        // A nested control's translucent fill lies over the glass, so its label stands on both.
        const control = fillRgb ? glass.map((value, channel) => fillRgb[channel]! * fillAlpha + value * (1 - fillAlpha)) : glass;
        return contrast(ink, glass) >= LEGIBLE_BODY_CONTRAST && contrast(faint, glass) >= LEGIBLE_FAINT_CONTRAST
            && contrast(ink, control) >= LEGIBLE_BODY_CONTRAST;
    };
    if (holds(compression)) return compression;
    let low = 0;
    let high = compression;
    for (let step = 0; step < 20; step++) {
        const middle = (low + high) / 2;
        if (holds(middle)) low = middle; else high = middle;
    }
    return low;
}

/**
 * The one owner of a glass surface's backdrop treatment. Named-preset Elements and floating surfaces
 * use the fixed-point model; picture-backed shell planes show the frosted picture under their coat.
 * Custom, Solid, Reduce Transparency and unbacked surfaces return null and paint exactly as set.
 */
export function resolveGlassBackdropMap(settings: GlassMaterialSettings, group: GlassSurfaceGroup, dark: boolean, environment: GlassMaterialEnvironment = {}, ground: GlassBackdropGround | null = null, panel: GlassFloatingCoat = false): GlassBackdropMap | null {
    const wallpaperPlane = environment.atmosphereBehind === 'wallpaper' && (group === 'chrome' || group === 'sidebar');
    if ((group !== 'floating' && group !== 'card' && !wallpaperPlane) || readGlassPreset(settings) === 'custom') return null;
    const { opacity } = resolveGlassSurfaceMaterial(settings, group, environment).material;
    if (opacity === 1) return null;
    if (group === 'floating' || group === 'card') {
        const picture = environment.atmosphereBehind === 'band' || environment.atmosphereBehind === 'wallpaper';
        const tint = resolveGlassTintValues(settings.glassTintIntensity);
        // A customized appearance over a live picture is the plain floating surface it would be anywhere else.
        const coat = panel === 'livePicture' && !isDefaultGlassAppearance(settings) ? false : panel;
        if (group === 'floating' && coat) {
            // The heavy coat carries the panel: the backdrop passes at most at 1 − α, never brightened.
            const alpha = coat === 'livePicture' ? Math.max(tint.panelCoat, GLASS_LIVE_PICTURE_PANEL_COAT) : tint.panelCoat;
            const compression = legibleCompression(Math.min(1 - alpha, dark ? 1 : tint.lightCompression), dark, picture ? environment.atmosphereTone : undefined, ground);
            return { opacity: alpha, ...solveGlassFixedPoint(compression, alpha, ground) };
        }
        // Every tint lands on the surface's own solid paint over the plain page, its warm hue included;
        // Lower tints carry that paint in a thinner coat, so the picture shows through more.
        const compression = dark ? picture ? tint.pictureDarkCompression : tint.plainDarkCompression : tint.lightCompression;
        // Light never brightens the backdrop past the page. At k = 1 the coat thickens only as far
        // as the paint needs, keeping k exact without a neutral lift.
        return solveGlassFixedPoint(legibleCompression(dark ? compression : Math.min(compression, 1 - opacity), dark, picture ? environment.atmosphereTone : undefined, ground), opacity, ground);
    }
    // Shell planes over a wallpaper are frosted picture under their coat, as in the atmosphere lab's G1
    // (owner, 2026-10-24: the title bar shows the picture): light keeps it unwashed, dark only dims it.
    return { tone: dark ? 'brightness(0.86) saturate(1.05)' : 'saturate(1.5)', coat: null };
}

/**
 * The notch's ink glass, on every dock (owner ruling, Desktop notch item 16). The desktop stands behind it,
 * not a page, so it skips the fixed-point solve: its paint at the Tint's coat over the native material, or
 * the same paint solid where no material stands behind it, because a coat alone would show the sharp
 * desktop. A custom opacity applies as set, with no floor (item 15).
 */
export function resolveGlassNotchPaint(paint: string, settings: GlassMaterialSettings, environment: GlassMaterialEnvironment): string {
    const { material } = resolveGlassSurfaceMaterial(settings, 'floating', environment);
    if (material.opacity === 1 || environment.nativeWindowMaterialLive !== true) return paint;
    const opacity = readGlassPreset(settings) === 'custom' ? material.opacity : resolveGlassTintValues(settings.glassTintIntensity).notchCoat;
    return parseThemeColor(paint)?.alpha(opacity).rgb().string() ?? paint;
}

/** The backdrop filter of `resolveGlassBackdropMap`, or '' when the surface keeps its exact paint. */
export function resolveGlassBackdropTone(settings: GlassMaterialSettings, group: GlassSurfaceGroup, dark: boolean, environment: GlassMaterialEnvironment = {}, ground: GlassBackdropGround | null = null, panel: GlassFloatingCoat = false): string {
    return resolveGlassBackdropMap(settings, group, dark, environment, ground, panel)?.tone ?? '';
}
