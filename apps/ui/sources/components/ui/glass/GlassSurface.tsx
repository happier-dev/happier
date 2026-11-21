import type { SurfaceAddress } from '@happier-dev/plugin-ui';
import { useHappierThemeSurfaceOverridesEnabled, useThemeSurfaceInspectionBinding } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle, type ViewProps } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierMaterialPlaneTransfer, HappierMaterialRoleProvider, HappierOpenedLayer, useContainingHappierMaterialPlane, HappierSurfaceGradientLayer, happierSurfaceGradientWebStyle, happierSurfaceFinishLift, resolveHappierSurfaceFinish, useContainingHappierMaterialRole, type HappierSurfaceGradient, type HappierSurfaceFinishRole, type HappierMaterialSurfaceRender } from '@happier-dev/plugin-ui/presentation';
import { resolveAndroidTranslucentUnlift, resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';
import { resolveThemeHairlineBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { readSurfaceStyleProperty } from '@/components/ui/surfaces/surfaceStyle';
import { shadowLevelStyle } from '@/shadowElevation';

import { createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';

import { drawsTintWithoutBlur, getBlurViewComponent, isNativeBlurAvailable } from './blurMaterial';
import { getGlassViewComponent, useLiquidGlassAvailable } from './liquidGlass';
import { resolveGlassCapability } from './resolveGlassCapability';
import { GLASS_BLUR_INTENSITY, GLASS_BLUR_RADIUS_PX, readGlassPreset, resolveGlassSurfaceMaterial, type FloatingSurfaceRole, type GlassFloatingCoat, type GlassSurfaceGroup } from './glassMaterial';
import { useGlassMaterialSettings } from './useGlassMaterialSettings';
import { useGlassAtmosphereScoped, useGlassRuntimeEnvironment } from './glassRuntimeEnvironment';
import { resolveGlassSurfaceSolidPaint, resolveGlassSurfaceCoatPaint, resolveGlassSurfacePaintLayers, resolveGlassSurfacePlaneMaterial, glassSurfacePlaneBackdropStyle, type AtmosphereContentCoat } from './glassSurfacePaint';
import { useGlassMaterialColorResolver } from './useGlassSurfaceColor';
import { fixedThemePaint, tokenThemePaint } from '@/theme/profiles/themePaint';
import { themeSurfaceStyles } from '@/theme/css/themeSurfaceStyles';
import { GLASS_BACKED_FAINT_INK_SHARE, GLASS_QUIET_INK_WEB_TOKENS, GlassBackedInkContext, glassQuietThemeInks, glassThemeInkWebStyle, resolveGlassBackedInk, resolveGlassPictureInk, useRetainedGlassBackedInk } from './glassBackedInk';
import { GlassLivePictureBackdropContext } from './livePictureBackdrop';

const retainSolidColor = (input: Readonly<{ color: string }>) => input.color;

// The containing material owns its plane. Lists inside a floating surface inherit that paint
// instead of covering only the body with an opaque fill and leaving separate header/footer bands.
// `openedOver` marks a floating layer opened from inside this surface (a popover, a menu, a field's
// choices). React context still flows through the layer's portal, but the layer is not in this surface's
// flow: its first surface stands on its own paint instead of inheriting this one.
const GlassSurfaceGroupContext = React.createContext<Readonly<{ group: GlassSurfaceGroup; finish: boolean; translucent: boolean; cleared: boolean; openedOver?: true }> | null>(null);
export function useContainingGlassSurfaceGroup(): GlassSurfaceGroup | null {
    return React.useContext(GlassSurfaceGroupContext)?.group ?? null;
}

/**
 * The boundary of a floating layer opened from inside a surface (the popover owner places it). A surface
 * directly in the layer is never nested in the opener's material, whatever it asks: it paints its own floating material (solid over another
 * floating surface, so glass never stacks on glass), and surfaces inside it nest in it as usual.
 */
export function GlassOpenedLayer(props: Readonly<{ children: React.ReactNode }>): React.ReactNode {
    const containing = React.useContext(GlassSurfaceGroupContext);
    const opened = React.useMemo(() => containing ? { ...containing, openedOver: true as const } : null, [containing]);
    // The public material plane (plugin surfaces) takes the same boundary, so its finish follows suit.
    const layer = <HappierOpenedLayer>{props.children}</HappierOpenedLayer>;
    return <GlassSurfaceGroupContext.Provider value={opened}>{layer}</GlassSurfaceGroupContext.Provider>;
}

/**
 * The surface planes a shell gives the content it presents: its glass group, material plane, backed ink and
 * live-picture backdrop. A body rendered away from that shell (a retained popover or dialog body) captures them at
 * the shell and reads them through `SurfacePlanesTransfer`, so it paints as if it stood there.
 */
export type SurfacePlanes = Readonly<{
    group: React.ContextType<typeof GlassSurfaceGroupContext>;
    material: ReturnType<typeof useContainingHappierMaterialPlane>;
    ink: React.ContextType<typeof GlassBackedInkContext>;
    livePicture: boolean;
}>;

export function useContainingSurfacePlanes(): SurfacePlanes {
    const group = React.useContext(GlassSurfaceGroupContext);
    const material = useContainingHappierMaterialPlane();
    const ink = React.useContext(GlassBackedInkContext);
    const livePicture = React.useContext(GlassLivePictureBackdropContext);
    return React.useMemo(() => ({ group, material, ink, livePicture }), [group, material, ink, livePicture]);
}

export function SurfacePlanesTransfer(props: Readonly<{ planes: SurfacePlanes; children: React.ReactNode }>): React.ReactNode {
    const { planes } = props;
    return <GlassSurfaceGroupContext.Provider value={planes.group}>
        <HappierMaterialPlaneTransfer plane={planes.material}>
            <GlassBackedInkContext.Provider value={planes.ink}>
                <GlassLivePictureBackdropContext.Provider value={planes.livePicture}>{props.children}</GlassLivePictureBackdropContext.Provider>
            </GlassBackedInkContext.Provider>
        </HappierMaterialPlaneTransfer>
    </GlassSurfaceGroupContext.Provider>;
}

/**
 * True directly on a content plane that has cleared over a Wallpaper (atmosphere A1): the picture is the
 * page there, so in-flow content has no page colour behind it. Under a Horizon band the layer paints the
 * page colour below the band, and a session's reading or opaque coat is its own page; both answer false.
 */
export function useGlassContentOverWallpaper(): boolean {
    const containing = React.useContext(GlassSurfaceGroupContext);
    const environment = useGlassRuntimeEnvironment();
    return containing !== null && isContentOverWallpaper(containing, environment);
}

function isContentOverWallpaper(plane: Readonly<{ group: GlassSurfaceGroup; cleared: boolean }>, environment: Readonly<{ atmosphereBehind?: 'none' | 'band' | 'wallpaper' }>): boolean {
    return plane.group === 'content' && plane.cleared && environment.atmosphereBehind === 'wallpaper';
}

export type GlassSurfaceProps = Pick<ViewProps, 'accessibilityRole' | 'accessibilityLabel' | 'role' | 'aria-label' | 'onLayout' | 'collapsable' | 'onPointerEnter' | 'onPointerLeave' | 'onFocus' | 'onBlur'> & Readonly<{
    ref?: React.Ref<React.ComponentRef<typeof View>>;
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    /** Stable address of this painted surface. */
    themeSurface?: SurfaceAddress;
    /** A structural host with no material of its own; preserves its children and the containing plane. */
    noCoat?: boolean;
    /**
     * Liquid Glass effect style. `regular` is the default chrome material; `clear`
     * is more transparent. Ignored when falling back to blur/solid.
     */
    glassEffectStyle?: 'regular' | 'clear';
    /** Blur intensity used by the `expo-blur` fallback. */
    blurIntensity?: number;
    /** When false, renders an opaque solid surface instead of glass/blur. */
    enabled?: boolean;
    /**
     * Fill color for the opaque solid tier (web / reduce-transparency / disabled). Defaults to the group's
     * step of the surface ladder: a floating surface's fill (`edge.floatingFill`), otherwise `surface.base`.
     */
    solidColor?: string;
    /** Authored translucent field ink for descendants; defaults to the theme's selected surface. */
    translucentColor?: string;
    testID?: string;
    surfaceGroup?: GlassSurfaceGroup;
    /** The containing same-group plane already owns its tint coat. */
    nested?: boolean;
    /** Shell page/chrome coat, whose blur stays beside its content rather than on an ancestor. */
    plane?: boolean;
    /** Transcript panes keep their opaque default or the content owner's opt-in reading coat. */
    atmosphereCoat?: AtmosphereContentCoat;
    /** Structural surfaces select a finish; chrome planes keep their existing flat material. */
    finishRole?: HappierSurfaceFinishRole | null;
    /** Small glass controls carry a hairline and the lowest lift in light themes. */
    controlEdge?: boolean;
    /**
     * A floating surface's job: `panel` (dialogs, sheets, large anchored panels) carries the page at a
     * heavy coat behind the blur; `menu` (the default: menus, tooltips, small popovers) keeps the hair of tint.
     */
    floatingRole?: FloatingSurfaceRole;
    /** A shared surface passes the state-settled overlay; null explicitly stays flat. */
    gradient?: HappierSurfaceGradient | null;
}>;

/**
 * Tiered "glass" chrome material used by the bottom tab bars.
 *
 * - iOS 26 with Liquid Glass → real `GlassView` (`expo-glass-effect`).
 * - Other iOS builds         → translucent `expo-blur` `BlurView`.
 * - Android                  → the authored tint on the page's own planes and cards; floating surfaces
 *                              (no blur target behind them) are solid unless their material is an unblurred tint.
 * - Web                      → the group's live tint/blur projection.
 * - Reduce Transparency      → solid, without changing the stored choice.
 *
 * Callers pass layout style (padding, border) only; the background/material is
 * owned here so each tier renders correctly. Do not pass an opaque
 * `backgroundColor` in `style` or the translucency tiers will be hidden.
 */
export const GlassSurface = React.memo(function GlassSurface(props: GlassSurfaceProps) {
    const inspection = useThemeSurfaceInspectionBinding(props.themeSurface);
    const inspectionRef = React.useCallback((node: React.ComponentRef<typeof View> | null) => {
        inspection?.ref(node);
        if (typeof props.ref === 'function') {
            const cleanup = props.ref(node);
            if (typeof cleanup === 'function') return () => { inspection?.ref(null); cleanup(); };
        } else if (props.ref) props.ref.current = node;
    }, [inspection, props.ref]);
    const { theme } = useUnistyles();
    const liquidGlassAvailable = useLiquidGlassAvailable();
    const reduceTransparency = useReduceTransparency();
    const settings = useGlassMaterialSettings();
    const runtimeEnvironment = useGlassRuntimeEnvironment();
    const atmosphereScoped = useGlassAtmosphereScoped();
    const group = props.surfaceGroup ?? 'floating';
    const resolveMaterialColor = useGlassMaterialColorResolver(group, props.plane === true);
    const surfaceOverridesEnabled = useHappierThemeSurfaceOverridesEnabled();
    const surfaceStyle = surfaceOverridesEnabled ? themeSurfaceStyles.surface(props.themeSurface) : undefined;
    const effectiveStyle = [props.style, surfaceStyle];
    const styleBackground = readSurfaceStyleProperty(props.style, 'backgroundColor');
    const borderRadius = readSurfaceStyleProperty(effectiveStyle, 'borderRadius');
    const materialShape: ViewStyle = {};
    for (const key of WEB_CORNER_RADII) {
        const radius = readSurfaceStyleProperty(effectiveStyle, key);
        if (radius !== undefined) materialShape[key] = radius;
    }
    const containingSurface = React.useContext(GlassSurfaceGroupContext);
    const containingMaterialRole = useContainingHappierMaterialRole();
    const nested = props.nested === true && containingSurface?.openedOver !== true;
    // Sidebar- and chrome-held Elements (the sidebar's list sheets) sit one quiet step above their plane
    // in the page colour; the card lift belongs to Elements on the page.
    const shellHeld = group === 'card' && (containingSurface?.group === 'sidebar' || containingSurface?.group === 'chrome');
    // Elements held by the sidebar or chrome plane (the sidebar's list groups) have that plane behind
    // them, not the content's band: they are backed only when the plane is itself glass over a
    // wallpaper or the live desktop. Otherwise they keep their exact solid paint.
    const shellUnbacked = shellHeld
        && !(containingSurface?.translucent === true && (runtimeEnvironment.atmosphereBehind === 'wallpaper'
            || (runtimeEnvironment.desktopWindow === true && runtimeEnvironment.nativeWindowMaterialLive === true)));
    const environment = shellUnbacked
        ? { ...runtimeEnvironment, atmosphereBehind: 'none' as const, desktopWindow: false, nativeWindowMaterialLive: false } : runtimeEnvironment;
    const finishRole = props.finishRole === undefined ? (group === 'floating' ? 'floating' : null) : props.finishRole;
    const inheritsFinish = nested && containingSurface?.group === group && containingSurface?.finish === true;
    const gradient = props.noCoat ? props.gradient ?? null : finishRole ? (props.gradient === undefined
        ? resolveThemeSurfaceFinish(theme, finishRole, undefined, inheritsFinish)
        : resolveHappierSurfaceFinish({ role: finishRole, gradients: { [finishRole]: props.gradient }, nested: inheritsFinish })) : null;
    const finishLift = finishRole ? happierSurfaceFinishLift(gradient, finishRole, theme.dark, Platform.OS === 'web') : null;
    const controlEdge = props.controlEdge ? resolveThemeHairlineBorderStyle(theme.colors.border.default) : null;
    const controlLift = props.controlEdge && !theme.dark ? shadowLevelStyle(theme.colors.shadowLevels[1]) : null;
    const authoredSolid = props.solidColor ?? (typeof styleBackground === 'string' ? styleBackground : undefined);
    const pagePaint = tokenThemePaint(theme, 'surface.base');
    const solidPaint = resolveGlassSurfaceSolidPaint(authoredSolid === undefined
        ? group === 'floating' ? fixedThemePaint(theme.colors.edge.floatingFill) : pagePaint
        : fixedThemePaint(authoredSolid), pagePaint, shellHeld);
    const solidColor = solidPaint.color;
    const viewProps = { ...inspection, ref: inspection ? inspectionRef : props.ref, testID: props.testID, accessibilityRole: props.accessibilityRole, accessibilityLabel: props.accessibilityLabel, role: props.role, 'aria-label': props['aria-label'], onLayout: props.onLayout,
        collapsable: inspection ? false : props.collapsable, onPointerEnter: props.onPointerEnter, onPointerLeave: props.onPointerLeave,
        onFocus: props.onFocus, onBlur: props.onBlur,
        ...(props.themeSurface ? { dataSet: { ...props.themeSurface, state: props.themeSurface.state ?? 'default' } } : null) };
    const effectiveEnvironment = {
        ...environment,
        reduceTransparency: reduceTransparency || environment.reduceTransparency === true,
    };
    const material = props.plane === true
        ? resolveGlassSurfacePlaneMaterial(settings, group, effectiveEnvironment, props.atmosphereCoat, theme.dark)
        : resolveGlassSurfaceMaterial(settings, group, effectiveEnvironment).material;
    const transparentPlane = props.plane === true && material.opacity === 0;
    const intensity = props.blurIntensity ?? GLASS_BLUR_INTENSITY[material.blur as keyof typeof GLASS_BLUR_INTENSITY];
    const toneReduceTransparency = reduceTransparency || environment.reduceTransparency === true;
    // Resolving the fixed point reads live theme variables from the document; do it once per input change.
    // Over a live picture (arbitrary pixels) every floating surface takes Strong's panel coat; over the plain
    // page that coat still lands on the floating paint, so only the picture case changes.
    const overLivePicture = React.useContext(GlassLivePictureBackdropContext);
    const panel: GlassFloatingCoat = group !== 'floating' ? false
        : overLivePicture ? props.floatingRole === 'panel' ? 'livePicturePanel' : 'livePicture'
        : props.floatingRole === 'panel';
    const coatPaint = React.useMemo(() => resolveGlassSurfaceCoatPaint({
        solid: solidPaint, page: pagePaint, ink: tokenThemePaint(theme, 'text.primary'),
        controlFill: props.translucentColor === undefined ? tokenThemePaint(theme, 'surface.selected') : fixedThemePaint(props.translucentColor),
        dark: theme.dark, context: { settings, group, environment: { ...environment, reduceTransparency: toneReduceTransparency },
            panel, noCoat: props.noCoat === true, web: Platform.OS === 'web' },
    }), [solidColor, authoredSolid, shellHeld, theme, settings, group, environment, toneReduceTransparency, panel, props.translucentColor, props.noCoat]);
    const backdropTone = coatPaint.backdropTone;

    // A floating surface opened from inside another (Inputs over the Run now panel, a select in a dialog)
    // has controls behind it, not atmosphere: under every named preset it stands on its own floating paint
    // rather than blurring them into a haze (glass is never stacked on glass). A Custom table applies as set.
    const overFloating = group === 'floating' && !nested && containingSurface?.group === 'floating'
        && readGlassPreset(settings) !== 'custom';
    const enabled = !props.noCoat && props.enabled !== false && !overFloating;
    const capability = !enabled || props.atmosphereCoat === 'opaque' || (transparentPlane && Platform.OS !== 'web')
        ? 'solid'
        : resolveGlassCapability({
            liquidGlassAvailable,
            // SDK 55 Android has no shared blur target; use the honest tint fallback.
            blurAvailable: isNativeBlurAvailable(),
            webBlurAvailable: Platform.OS === 'web',
            ...environment,
            reduceTransparency: reduceTransparency || environment.reduceTransparency === true,
            settings,
            surfaceGroup: group,
        });
    const inheritsTranslucentMaterial = nested && containingSurface?.group === group && containingSurface?.translucent === true && material.opacity < 1 && enabled;
    const tintsWithoutBlur = capability === 'tint' || drawsTintWithoutBlur(group);

    let nativeBackdrop: React.ReactNode = null;
    if (!inheritsTranslucentMaterial && capability === 'liquidGlass') {
        const GlassView = getGlassViewComponent();
        if (GlassView) {
            nativeBackdrop = (
                <GlassView
                    glassEffectStyle={props.glassEffectStyle ?? (material.blur === 'light' ? 'clear' : 'regular')}
                    colorScheme={theme.dark ? 'dark' : 'light'}
                    // Untinted, as in 0.2: any tint switches Liquid Glass to its darker tinted mode, and an opaque one
                    // turns it into a flat disc (owner, 2026-11-10). Panels carry their coat over the glass instead.
                    // Liquid Glass draws its own rim along its own shape: it takes the surface's corners.
                    style={[StyleSheet.absoluteFillObject, materialShape]}
                />
            );
        }
    }

    if (!inheritsTranslucentMaterial && capability === 'blur') {
        const BlurView = getBlurViewComponent();
        if (BlurView) {
            nativeBackdrop = (
                <BlurView
                    tint={theme.dark ? 'dark' : 'light'}
                    intensity={intensity}
                    style={StyleSheet.absoluteFillObject}
                />
            );
        }
    }

    const layerPaint = resolveGlassSurfacePaintLayers({ solid: solidPaint, tint: coatPaint.tint,
        dark: theme.dark, coatOpacity: coatPaint.coatOpacity, context: {
            settings, environment: effectiveEnvironment, web: Platform.OS === 'web', group, nested,
            plane: props.plane === true, noCoat: props.noCoat === true, enabled, shellHeld, capability, material,
            inheritsTranslucentMaterial, hasNativeBackdrop: Boolean(nativeBackdrop), tintsWithoutBlur, panel, atmosphereCoat: props.atmosphereCoat,
        } });

    // Inheritance follows the rendered tier, not a preference whose SDK may be unavailable.
    const translucent = material.opacity < 1 && enabled && (transparentPlane || (Platform.OS === 'web'
        ? capability === 'webBlur' || group === 'card' : tintsWithoutBlur || Boolean(nativeBackdrop) || inheritsTranslucentMaterial));
    const cleared = transparentPlane && enabled;
    const ownPlane = React.useMemo(() => ({ group, finish: Boolean(gradient) || Boolean(inheritsFinish), translucent, cleared }), [cleared, group, gradient, inheritsFinish, translucent]);
    const plane = props.noCoat ? containingSurface : ownPlane;
    // Faint ink on glass with a picture (or the live desktop) behind it gets a stronger step, on every
    // platform. Ordinary pages and unbacked glass keep the theme's secondary ink.
    const backed = translucent && props.plane !== true && (group === 'card' || group === 'floating')
        && (environment.atmosphereBehind === 'band' || environment.atmosphereBehind === 'wallpaper' || overLivePicture
            || (environment.desktopWindow === true && environment.nativeWindowMaterialLive === true));
    // Where the cleared page is the Wallpaper picture itself, its quiet ink steps up to the primary ink.
    const onPicture = !props.noCoat && plane !== null && isContentOverWallpaper(plane, environment);
    const containingInk = React.useContext(GlassBackedInkContext);
    // A surface on the picture plane is its own ground: it takes its own material's ink, never the plane's.
    const inheritedInk = containingInk?.picture ? null : containingInk;
    // The quiet inks a head line uses: tertiary meta and a plain control's glyph (secondary is the role's own).
    const pictureInk = onPicture ? environment.atmosphereTone?.ink : undefined;
    const ownInk = React.useMemo(() => onPicture
        ? resolveGlassPictureInk({ primary: theme.colors.text.primary, page: theme.colors.surface.base, themeSecondary: theme.colors.text.secondary,
            themeQuietInks: [theme.colors.text.tertiary, theme.colors.button.secondary.tint], pictureInk })
        : backed ? resolveGlassBackedInk(theme.colors.text.primary, theme.colors.text.secondary, glassQuietThemeInks(theme.colors)) : null,
        [onPicture, backed, pictureInk, theme.colors.text.primary, theme.colors.text.secondary, theme.colors.text.tertiary, theme.colors.surface.base, theme.colors.button.secondary.tint, theme.colors.composer.chipTint, theme.colors.input.placeholder]);
    // Text and icons that receive the faint tokens from JavaScript take them from this scope. Like the
    // web stylesheet tokens, they inherit through nested surfaces; the provider stays mounted so a tier
    // change never remounts the content.
    const publishedInk = useRetainedGlassBackedInk(props.noCoat ? containingInk : ownInk ?? inheritedInk);
    const withBackedInk = (children: React.ReactNode) => <GlassBackedInkContext.Provider value={publishedInk}>{children}</GlassBackedInkContext.Provider>;
    // Keep the provider topology even without a coat. Omitted fields inherit the shared plane;
    // a plain widget must not reset its parent's ink, colour resolver or translucency.
    const materialPlane = props.noCoat ? { role: containingMaterialRole } : {
        role: group,
        finish: plane?.finish,
        translucentColor: props.translucentColor ?? theme.colors.surface.selected,
        resolveMaterialColor: !enabled || (Platform.OS !== 'web' && (material.opacity === 1 || (!tintsWithoutBlur && !nativeBackdrop && !inheritsTranslucentMaterial && !transparentPlane)))
            ? retainSolidColor : resolveMaterialColor,
    };

    if (Platform.OS !== 'web') {
        const borderWidth = readSurfaceStyleProperty(effectiveStyle, 'borderWidth');
        const materialInset = typeof borderWidth === 'number' ? -borderWidth : 0;
        // The coat a native material carries over its glass: a reading ground's own, or a floating surface's heavy
        // panel coat (light popovers read through without it, NATIVE-SWEEP M3). Native glass has no backdrop tone,
        // so the web's fixed-point hair is not painted: a dark menu or bar stays clear glass (owner, 2026-11-10).
        const surfaceFill = readSurfaceStyleProperty(surfaceStyle, 'backgroundColor');
        const backgroundColor = layerPaint.background.color;
        // Only the SDK background changes tier. Input/scroll/selection state
        // must stay under the same native parent when a preset or OS choice changes.
        // A surface that keeps its tint on Android (no blur behind it) is not lifted there; an opaque one keeps its lift.
        return <View {...viewProps} style={[props.style, props.noCoat ? null : { backgroundColor },
            finishLift, controlLift, props.noCoat ? null : resolveAndroidTranslucentUnlift(backgroundColor), surfaceStyle,
            surfaceFill !== undefined ? { backgroundColor: 'transparent' } : null]}>
            {/* The material fills the border box, so the glass's own edge lies under the surface's border: one edge. */}
            <View pointerEvents="none" style={[
                StyleSheet.absoluteFillObject,
                { top: materialInset, left: materialInset, right: materialInset, bottom: materialInset, ...materialShape, overflow: 'hidden' },
            ]}>{nativeBackdrop}{surfaceFill !== undefined || layerPaint.coat !== undefined ? <View pointerEvents="none"
                style={[StyleSheet.absoluteFillObject, { backgroundColor: surfaceFill ?? layerPaint.coat!.color }]} /> : null}
                <HappierSurfaceGradientLayer gradient={surfaceFill === undefined ? gradient : null} borderRadius={typeof borderRadius === 'number' ? borderRadius : undefined} /></View>
            {controlEdge ? <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, materialShape, controlEdge]} /> : null}
            <GlassSurfaceGroupContext.Provider value={plane}>
                <HappierMaterialRoleProvider {...materialPlane}>
                    {withBackedInk(props.children)}
                </HappierMaterialRoleProvider>
            </GlassSurfaceGroupContext.Provider>
        </View>;
    }

    // On web the theme's ink tokens are redefined for this subtree too, so stylesheet consumers follow;
    // a surface on the picture plane restores the tokens the plane redefined.
    const backedInkStyle = props.noCoat ? null : onPicture && ownInk
        ? { '--colors-text-primary': ownInk.secondary, '--colors-text-secondary': ownInk.secondary, '--colors-text-tertiary': ownInk.secondary } as unknown as ViewStyle
        : backed || inheritedInk !== containingInk
        ? { ...glassThemeInkWebStyle(theme.colors.text), ...(backed ? Object.fromEntries(GLASS_QUIET_INK_WEB_TOKENS.map(token =>
            [token, `color-mix(in srgb, ${theme.colors.text.primary} ${GLASS_BACKED_FAINT_INK_SHARE * 100}%, transparent)`])) : null) } as unknown as ViewStyle : null;
    // Web paints the material on its own layer beneath the content, in every tier, so a tier change
    // never moves the content to another parent. A CSS `backdrop-filter` makes its element a backdrop
    // root: on the surface itself it would cut everything inside (a menu, tooltip or popover opened
    // from this surface) off the page, and that nested glass would blur an empty plane.
    const frosted = capability === 'webBlur' && props.plane !== true && !props.noCoat && !inheritsTranslucentMaterial;
    const paint = props.noCoat ? { backgroundColor: layerPaint.background.color } : props.plane === true
        // The same CSS-to-RN-web boundary as the functional surface's backdrop below.
        ? { ...glassSurfacePlaneBackdropStyle(settings, group, theme.dark, effectiveEnvironment, props.atmosphereCoat),
            backgroundColor: layerPaint.background.color } as unknown as ViewStyle
        : inheritsTranslucentMaterial ? { backgroundColor: layerPaint.background.color }
        : capability === 'webBlur'
        // `createBackdropWebStyle` returns web `CSSProperties` (backdrop-filter + -webkit- prefix +
        // tint); cast to the RN-web `ViewStyle` at this web boundary.
        ? createBackdropWebStyle({
            backgroundColor: layerPaint.background.color,
            blurPx: props.blurIntensity === undefined ? GLASS_BLUR_RADIUS_PX[material.blur as keyof typeof GLASS_BLUR_RADIUS_PX] : Math.round(intensity / 5),
            surfaceGroup: group,
            backdropTone: inheritsTranslucentMaterial ? undefined : backdropTone,
        }) as unknown as ViewStyle
        : { backgroundColor: layerPaint.background.color };
    // The concrete surface owns local exceptions (an opaque reading ground, an unbacked
    // sidebar card, or a clear content plane); descendants keep the same CSS binding.
    const innerMaterial = material.opacity === 1 ? material : resolveGlassSurfaceMaterial(settings, group, runtimeEnvironment).material;
    const innerPaint = props.noCoat ? null : {
        [`--happier-glass-${group}-nested-opacity`]: innerMaterial.opacity < 1 ? '0%' : '100%',
        [`--happier-glass-${group}-plane-background-color`]: material.opacity < 1
            && resolveGlassSurfacePlaneMaterial(settings, group, runtimeEnvironment).opacity === 0 ? 'transparent' : 'initial',
        // A scoped atmosphere (`GlassAtmosphereScope`) is not the window's: this surface carries its own group values.
        ...(atmosphereScoped ? {
            [`--happier-glass-${group}-opacity`]: `${material.opacity * 100}%`,
            [`--happier-glass-${group}-blur`]: `${GLASS_BLUR_RADIUS_PX[material.blur as keyof typeof GLASS_BLUR_RADIUS_PX]}px`,
        } : null),
    } as unknown as ViewStyle;
    const reachesPastEdges = frosted && group === 'floating';
    // A clipping surface stays a clip, not a scroll container: its frost layer reaches past the box, and with a hidden
    // overflow a focus or scroll-into-view scrolled the surface by that reach, cutting off a dialog's header (round 10).
    const clipWithoutScrolling = reachesPastEdges && readSurfaceStyleProperty(props.style, 'overflow') === 'hidden'
        ? { overflow: 'clip' } as unknown as ViewStyle : null;
    return (
        <View {...viewProps} style={[props.style, clipWithoutScrolling, props.noCoat ? null : { backgroundColor: 'transparent' }, finishLift, controlLift, backedInkStyle, innerPaint]}>
            {/* Native View types omit RN-web's dataSet; this branch is the web boundary. */}
            <View {...{ dataSet: { happyGlassBackdrop: 'true' } }} style={[StyleSheet.absoluteFillObject, webMaterialLayerShape(props.style, frosted, reachesPastEdges), paint, happierSurfaceGradientWebStyle(gradient, !theme.dark)]} />
            {controlEdge ? <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, materialShape, controlEdge]} /> : null}
            <GlassSurfaceGroupContext.Provider value={plane}>
                <HappierMaterialRoleProvider {...materialPlane}>
                    {withBackedInk(props.children)}
                </HappierMaterialRoleProvider>
            </GlassSurfaceGroupContext.Provider>
        </View>
    );
});

const WEB_CORNER_RADII = ['borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'] as const;

/** Core shared frames and sheets bind the same material owner as mounted plugin surfaces. */
function renderGlassMaterialSurface(input: Parameters<HappierMaterialSurfaceRender>[0], floatingRole?: FloatingSurfaceRole): React.ReactElement {
    return <GlassSurface
        themeSurface={input.themeSurface}
        surfaceGroup={input.role} finishRole={input.finishRole ?? 'card'} nested={input.role === 'floating' ? input.nested : true}
        noCoat={input.noCoat}
        floatingRole={floatingRole ?? input.floatingRole}
        gradient={input.gradient}
        style={input.style as StyleProp<ViewStyle>} testID={input.testID} onLayout={input.onLayout} accessibilityLabel={input.accessibilityLabel}
    >{input.children}</GlassSurface>;
}

export const renderThemeMaterialSurface: HappierMaterialSurfaceRender = input => renderGlassMaterialSurface(input);

/**
 * A floating card that rides over arbitrary content (a carried item's release preview) takes the panel
 * coat, so its words stay legible over the text beneath it; a menu's hair of tint is for menus.
 */
export const renderPanelMaterialSurface: HappierMaterialSurfaceRender = input => renderGlassMaterialSurface(input, 'panel');

/**
 * Software-composited Chrome (headless QA browsers, machines without a GPU) frosts a backdrop only up to a constant
 * ~96 device px short of the layer's right and bottom edges above 1x device scale (FIN 11-13: list rows read through a
 * popover at 200 % text; measured at DPR 2 and 3, the layer box itself exact). GPU compositing is unaffected. A frosted
 * floating layer reaches that far past those edges and clips itself back to the surface, so its frost always covers the
 * whole surface; 96 CSS px covers 96 device px at every scale. Floating surfaces are few at once; in-flow cards stay exact.
 */
const SOFTWARE_BACKDROP_SHORTFALL_PX = 96;

/**
 * The layer fills the surface's padding box, so its corners follow the surface's inner radius. A frosted layer is
 * shaped by a clip of those corners rather than by its own rounding: WebKit (the desktop app) drew ink ramps inside
 * the left and top edges of rounded frosted cards and the composer on light, while clip-shaped frosted menus in the
 * same window stayed clean (owner screenshots 2026-11-16, GLASS-SURFACES-1116).
 */
function webMaterialLayerShape(style: StyleProp<ViewStyle>, frosted = false, reachPastSoftwareShortfall = false): ViewStyle {
    const borderWidth = readSurfaceStyleProperty(style, 'borderWidth');
    const inset = typeof borderWidth === 'number' ? borderWidth : 0;
    // Unistyles styles retain non-enumerable geometry: flattening an array can
    // expose only its secret references. CSS inheritance keeps the paint's
    // corners attached to the real root without throwing those references away.
    const shape = { pointerEvents: 'none', borderRadius: 'inherit' } as unknown as ViewStyle;
    const radii: Partial<Record<(typeof WEB_CORNER_RADII)[number], number>> = {};
    for (const key of WEB_CORNER_RADII) {
        const radius = readSurfaceStyleProperty(style, key);
        if (typeof radius === 'number') radii[key] = Math.max(0, radius - inset);
    }
    if (!frosted) return Object.assign(shape, radii);
    const corner = (key: (typeof WEB_CORNER_RADII)[number]) => radii[key] ?? radii.borderRadius ?? 0;
    const reach = reachPastSoftwareShortfall ? SOFTWARE_BACKDROP_SHORTFALL_PX : 0;
    return {
        pointerEvents: 'none',
        ...(reach > 0 ? { right: -reach, bottom: -reach } : null),
        clipPath: `inset(0px ${reach}px ${reach}px 0px round ${corner('borderTopLeftRadius')}px ${corner('borderTopRightRadius')}px ${corner('borderBottomRightRadius')}px ${corner('borderBottomLeftRadius')}px)`,
    } as unknown as ViewStyle;
}
