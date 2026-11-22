import Color from 'color';
import { parseThemeColor } from '@/theme/parseThemeColor';
import { deriveThemePaintResult, fixedThemePaint, type ThemePaint } from '@/theme/profiles/themePaint';
export { readThemeDocumentColor as readGlassDocumentColor } from '@/theme/parseThemeColor';
import { DEFAULT_GLASS_TINT_INTENSITY, readGlassMaterials, readGlassPreset, readGlassTintedMaterials, readGlassTintIntensity, resolveGlassTintValues } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
import type { GlassMaterialSettings, GlassSurfaceGroup, GlassSurfaceMaterial } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
export { GLASS_PRESETS, GLASS_SURFACE_GROUPS, GLASS_BLUR_STEPS, GLASS_BLUR_INTENSITY, GLASS_BLUR_RADIUS_PX, glassPresetMaterials, readGlassMaterials, readGlassPreset, readGlassTintedMaterials, readGlassTintIntensity, resolveGlassPresetSettingsDelta, resolveGlassSurfaceSettingsDelta, resolveGlassIntensitySettingsDelta, resolveGlassTintSettingsDelta } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
export type { GlassBlurStep, GlassSurfaceGroup, GlassSurfaceMaterial, GlassSurfaceMaterials, GlassPreset, GlassMaterialChoice, GlassMaterialSettings } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';

/** Quiet ink strength shared by the material's contrast policy and its painted ink scope. */
export const GLASS_BACKED_FAINT_INK_SHARE = 0.7;

export type GlassMaterialEnvironment = Readonly<{
    desktopWindow?: boolean;
    nativeWindowMaterialLive?: boolean;
    reduceTransparency?: boolean;
    highContrast?: boolean;
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
    reason: 'reduceTransparency' | 'noBacking' | 'unsupported' | 'unavailable' | null;
}>;

function isWallpaperShellPlane(group: GlassSurfaceGroup, environment: GlassMaterialEnvironment): boolean {
    return environment.atmosphereBehind === 'wallpaper' && (group === 'chrome' || group === 'sidebar');
}

/**
 * Stored choices survive accessibility overrides. Never fade foreground content. Window focus is not an input: an
 * unfocused window keeps its glass (owner 2026-11-11: it went fully opaque whenever the window lost focus).
 */
export function resolveGlassSurfaceMaterial(settings: GlassMaterialSettings, group: GlassSurfaceGroup, environment: GlassMaterialEnvironment = {}): GlassSurfaceResolution {
    const requested = (environment.nativeRenderer === true ? readGlassMaterials(settings) : readGlassTintedMaterials(settings))[group];
    // A shown background backs content; Wallpaper also backs the title bar, rail and sidebar (A2/A3).
    // Their stored material applies even without live desktop glass. Solid's stored material stays opaque.
    const atmosphereBacked = isWallpaperShellPlane(group, environment)
        || (group === 'content' && (environment.atmosphereBehind === 'band' || environment.atmosphereBehind === 'wallpaper'));
    const reason: GlassSurfaceResolution['reason'] = environment.reduceTransparency ? 'reduceTransparency'
        : group === 'card' && environment.atmosphereBehind !== 'band' && environment.atmosphereBehind !== 'wallpaper'
            && resolveGlassSurfaceMaterial(settings, 'content', environment).material.opacity === 1 ? 'noBacking'
        : atmosphereBacked ? null
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
export type GlassBackdropPaintGround = Readonly<{ page: ThemePaint; solid: ThemePaint; ink?: ThemePaint; controlFill?: ThemePaint }>;
export type GlassBackdropPaintMap = GlassBackdropMap & Readonly<{ coatPaint?: ThemePaint }>;
type GlassCompression = Readonly<{ value: number; inputs: readonly ThemePaint[] }>;

/**
 * Glass composites the filtered backdrop and coat C at opacity α. Before filter clipping, brightness
 * and lift form an affine map, followed by saturation. `tone` is that filter; `coat` is C.
 * `opaqueCoat` lets a floating surface use its solid paint when that map erases the backdrop.
 */
export type GlassBackdropMap = Readonly<{ tone: string; coat: string | null; opacity?: number; opaqueCoat?: true }>;

/**
 * How a floating surface declares its job. Panels (centred dialogs, phone sheets and large anchored
 * panels such as Add widget, About this widget or Workflow run inputs) carry the page at a heavy coat
 * behind their blur (the page colour at 55% at Subtle, a frosted modal); menus, tooltips and small
 * popovers keep the tint's hair (owner, 2026-10-16). Over the plain page a panel still lands on its
 * floating paint. Coats interpolate with the global tint.
 */
export type FloatingSurfaceRole = 'menu' | 'panel';
/**
 * The coat a floating surface carries: the tint's hair (`false`), the tint's panel coat (`true`), or,
 * over a live picture (a shared screen or browser page: arbitrary pixels, not atmosphere), Strong's
 * panel coat, so a black terminal never turns a light menu into a grey wash of itself. Only the shipped
 * default glass takes it: a customized preset, blur or tint applies as set there too (owner, 2026-10-04), so
 * there a panel over a picture (`livePicturePanel`) keeps its own panel coat and a menu its hair.
 */
export type GlassFloatingCoat = boolean | 'livePicture' | 'livePicturePanel';
const GLASS_LIVE_PICTURE_PANEL_COAT = resolveGlassTintValues(100).panelCoat;

/** The glass the app ships with: the Auto preset at regular blur and the default tint. Anything else is the person's choice. */
function isDefaultGlassAppearance(settings: GlassMaterialSettings): boolean {
    return readGlassPreset(settings) === 'auto' && (settings.glassBlurIntensity ?? 'regular') === 'regular'
        && readGlassTintIntensity(settings.glassTintIntensity) === DEFAULT_GLASS_TINT_INTENSITY;
}

/**
 * The heavy coat a named-preset floating surface carries over its glass, or undefined for the tint's hair.
 * Panels take the tint's panel coat; over a live picture every floating surface takes Strong's. Under the default
 * glass, every light floating surface (menus, popovers, tooltips, toasts, dialogs, sheets) carries Strong's coat too,
 * a white veil (owner 2026-11-22, light glass veil, amending OWNER-1330-COAT/03): through the hair a dark terminal or
 * code block under a light menu read as a mid-grey wash; at 0.85 the backdrop passes at most 15%. Dark menus keep the
 * hair, and a customized glass applies as set. Native glass paints exactly this coat (it has no backdrop tone to solve
 * against).
 */
export function resolveGlassPanelCoatOpacity(settings: GlassMaterialSettings, dark: boolean, panel: GlassFloatingCoat = false): number | undefined {
    const overPicture = panel === 'livePicture' || panel === 'livePicturePanel';
    const readable = isDefaultGlassAppearance(settings) && (overPicture || !dark);
    const coat: GlassFloatingCoat = readable ? 'livePicture' : panel === 'livePicture' ? false : panel === 'livePicturePanel' ? true : panel;
    if (!coat || readGlassPreset(settings) === 'custom') return undefined;
    const tint = resolveGlassTintValues(settings.glassTintIntensity);
    return coat === 'livePicture' ? Math.max(tint.panelCoat, GLASS_LIVE_PICTURE_PANEL_COAT) : tint.panelCoat;
}

/**
 * The reading coat a page's content plane carries over a shown picture (the page colour, blurred, no tone): Elements
 * stand on it, so their glass sees the picture through it. A Solid or Custom content material applies as set.
 */
export function resolveGlassReadingCoatOpacity(settings: GlassMaterialSettings, environment: GlassMaterialEnvironment, dark: boolean): number {
    const material = resolveGlassSurfaceMaterial(settings, 'content', environment).material;
    if (material.opacity === 1 || readGlassPreset(settings) === 'custom') return material.opacity;
    return dark ? 0.66 : 0.56;
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
function solveGlassFixedPoint(compressionPaint: GlassCompression, alpha: number, ground: GlassBackdropPaintGround | null, floating: boolean): GlassBackdropPaintMap {
    const compression = compressionPaint.value;
    const page = ground ? parseRgb(ground.page.color) : null;
    const authoredSolid = ground ? parseRgb(ground.solid.color) : null;
    const solid = authoredSolid ?? page;
    const scale = compression / (1 - alpha);
    if (!page || !solid || alpha <= 0) return { tone: `brightness(${toneNumber(scale)}) saturate(1.05)`, coat: null };
    const solidPaint = authoredSolid ? ground!.solid : ground!.page;
    // The parsed channels above came from these selected paired inputs; keep the solve single-pass.
    const result = deriveThemePaintResult([solidPaint, ground!.page, ...compressionPaint.inputs], () => {
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
        if (neutralLift === 0) {
            const brightness = Number(toneNumber(unliftedScale));
            return {
                tone: `brightness(${brightness}) saturate(1.05)`,
                backdrop: saturate(page.map(value => clamp(value * brightness))),
                flat: brightness === 0,
            };
        }
        // Evaluate the exact rounded CSS coefficients, clamping at each filter boundary.
        const total = Number(toneNumber(scale + neutralLift));
        const pivot = Number(toneNumber(scale / (scale + neutralLift)));
        return {
            tone: `invert(1) brightness(${pivot}) invert(1) brightness(${total}) saturate(1.05)`,
            backdrop: saturate(page.map(value => clamp((1 - clamp((1 - value) * pivot)) * total))),
            flat: pivot === 0 || total === 0,
        };
    };
    let { tone, backdrop, flat } = filter(lift);
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
            // A full coat covers the backdrop: its gain is zero, never compression / 0 (brightness(Infinity)).
            ({ tone, backdrop, flat } = filter(0, opacity >= 1 ? 0 : compression / (1 - opacity)));
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
            ({ tone, backdrop, flat } = unlifted);
            opacity = unliftedOpacity;
        }
        coat = coatFor(opacity);
    }
    return { tone, flat, color: Color.rgb(coat.map(value => value * 255)).round().string(),
        ...(opacity !== alpha ? { opacity } : {}) };
    });
    return { tone: result.tone, coat: result.color, coatPaint: { color: result.color, source: result.source },
        // A zero rounded gain erases the backdrop. Paint that same solid fill directly so a
        // browser that skips compositing the filter still shows the floating surface.
        ...(floating && authoredSolid && result.flat ? { opaqueCoat: true as const } : {}),
        ...(result.opacity === undefined ? {} : { opacity: result.opacity }) };
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
/** The page's own content as the backdrop a floating surface may cover: its ink is the darkest (and lightest) it carries. */
const pageInkTone = (ground: GlassBackdropPaintGround | null): GlassAtmosphereTone | undefined => {
    const ink = ground?.ink ? parseRgb(ground.ink.color) : null;
    if (!ink) return undefined;
    const luminance = relativeLuminance(ink);
    return { dark: luminance, light: luminance, focus: luminance };
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
 * theme's ink to keep its contrast. Pictures that agree with the theme change nothing. A light floating surface
 * over the plain page has no measured picture, but it hangs over that page's content, whose darkest is the page's own
 * ink (rows of text under a menu): it solves against that ink, so its words stay readable over a list (COR5B).
 * `coat` is the page coat the surface stands on (an Element on the reading coat): its glass sees the picture through
 * it, so the solve does not dim a backdrop the coat has already calmed (owner, 2026-11-11 #04).
 */
function legibleCompression(compression: number, dark: boolean, tone: GlassAtmosphereTone | undefined, ground: GlassBackdropPaintGround | null, coat = 0): GlassCompression {
    const page = ground ? parseRgb(ground.page.color) : null;
    const solid = ground ? parseRgb(ground.solid.color) ?? page : null;
    const ink = ground?.ink ? parseRgb(ground.ink.color) : null;
    if (!tone || !page || !solid || !ink) return { value: compression, inputs: [] };
    const extreme = greyOf(dark ? tone.light : tone.dark);
    const picture = page.map(value => value * coat + extreme * (1 - coat));
    const fill = ground?.controlFill ? parseThemeColor(ground.controlFill.color) : null;
    const inputs = [ground!.ink!, ...(fill ? [ground!.controlFill!] : [])];
    const fillRgb = fill ? fill.rgb().array().map(value => value / 255) : null;
    const fillAlpha = fill ? fill.alpha() : 0;
    const holds = (k: number) => {
        const glass = solid.map((value, channel) => Math.min(1, Math.max(0, value + k * (picture[channel]! - page[channel]!))));
        const faint = ink.map((value, channel) => value * GLASS_BACKED_FAINT_INK_SHARE + glass[channel]! * (1 - GLASS_BACKED_FAINT_INK_SHARE));
        // A nested control's translucent fill lies over the glass, so its label stands on both.
        const control = fillRgb ? glass.map((value, channel) => fillRgb[channel]! * fillAlpha + value * (1 - fillAlpha)) : glass;
        return contrast(ink, glass) >= LEGIBLE_BODY_CONTRAST && contrast(faint, glass) >= LEGIBLE_FAINT_CONTRAST
            && contrast(ink, control) >= LEGIBLE_BODY_CONTRAST;
    };
    if (holds(compression)) return { value: compression, inputs };
    let low = 0;
    let high = compression;
    for (let step = 0; step < 20; step++) {
        const middle = (low + high) / 2;
        if (holds(middle)) low = middle; else high = middle;
    }
    return { value: low, inputs };
}

/**
 * The one owner of a glass surface's backdrop treatment. Named-preset Elements and floating surfaces
 * use the fixed-point model; picture-backed shell planes show the frosted picture under their coat.
 * Custom, Solid, Reduce Transparency and unbacked surfaces return null and paint exactly as set.
 */
export function resolveGlassBackdropMap(settings: GlassMaterialSettings, group: GlassSurfaceGroup, dark: boolean, environment: GlassMaterialEnvironment = {}, ground: GlassBackdropGround | null = null, panel: GlassFloatingCoat = false): GlassBackdropMap | null {
    const result = resolveGlassBackdropMapPaint(settings, group, dark, environment, ground ? {
        page: fixedThemePaint(ground.page), solid: fixedThemePaint(ground.solid),
        ...(ground.ink === undefined ? {} : { ink: fixedThemePaint(ground.ink) }),
        ...(ground.controlFill === undefined ? {} : { controlFill: fixedThemePaint(ground.controlFill) }),
    } : null, panel);
    if (!result) return null;
    const { coatPaint: _paint, ...map } = result;
    return map;
}

export function resolveGlassBackdropMapPaint(settings: GlassMaterialSettings, group: GlassSurfaceGroup, dark: boolean, environment: GlassMaterialEnvironment, ground: GlassBackdropPaintGround | null, panel: GlassFloatingCoat): GlassBackdropPaintMap | null {
    const wallpaperPlane = isWallpaperShellPlane(group, environment);
    if ((group !== 'floating' && group !== 'card' && !wallpaperPlane) || readGlassPreset(settings) === 'custom') return null;
    const { opacity } = resolveGlassSurfaceMaterial(settings, group, environment).material;
    if (opacity === 1) return null;
    if (group === 'floating' || group === 'card') {
        const picture = environment.atmosphereBehind === 'band' || environment.atmosphereBehind === 'wallpaper';
        const tint = resolveGlassTintValues(settings.glassTintIntensity);
        // Panels, live pictures and light floating glass under the default glass carry a heavy coat
        // (`resolveGlassPanelCoatOpacity`); other menus and popovers are the tint's hair solved below, as Elements are
        // (owner, 2026-11-11). A customized appearance is the plain floating surface it would be anywhere else.
        const alpha = group === 'floating' ? resolveGlassPanelCoatOpacity(settings, dark, panel) : undefined;
        // A light floating surface over the plain page hangs over that page's content: it solves against the page's ink.
        const contentTone = group === 'floating' && !picture && !dark ? pageInkTone(ground) : undefined;
        if (alpha !== undefined) {
            // The heavy coat carries the panel: the backdrop passes at most at 1 − α, never brightened.
            const compression = legibleCompression(Math.min(1 - alpha, dark ? 1 : tint.lightCompression), dark, picture ? environment.atmosphereTone : contentTone, ground);
            return { opacity: alpha, ...solveGlassFixedPoint(compression, alpha, ground, true) };
        }
        // Every tint lands on the surface's own solid paint over the plain page, its warm hue included;
        // Lower tints carry that paint in a thinner coat, so the picture shows through more.
        const compression = dark ? picture ? tint.pictureDarkCompression : tint.plainDarkCompression : tint.lightCompression;
        // Light never brightens the backdrop past the page. At k = 1 the coat thickens only as far
        // as the paint needs, keeping k exact without a neutral lift.
        // Elements stand on the page's reading coat; floating surfaces may hang over any plane, so they keep the bare picture.
        const standing = group === 'card' && picture ? resolveGlassReadingCoatOpacity(settings, environment, dark) : 0;
        // Dark floating glass keeps passing an ordinary page through unchanged (no content tone).
        return solveGlassFixedPoint(legibleCompression(dark ? compression : Math.min(compression, 1 - opacity), dark, picture ? environment.atmosphereTone : contentTone, ground, standing), opacity, ground, group === 'floating');
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
