import * as React from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle, type ViewProps } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierMaterialRoleProvider, HappierOpenedLayer, HappierSurfaceGradientLayer, happierSurfaceGradientWebStyle, happierSurfaceFinishLift, resolveHappierSurfaceFinish, useContainingHappierMaterialRole, type HappierSurfaceGradient, type HappierSurfaceFinishRole, type HappierMaterialSurfaceRender } from '@happier-dev/plugin-ui/presentation';
import { resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';
import { readSurfaceStyleProperty } from '@/components/ui/surfaces/surfaceStyle';

import { createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';

import { getBlurViewComponent, isNativeBlurAvailable } from './blurMaterial';
import { getGlassViewComponent, useLiquidGlassAvailable } from './liquidGlass';
import { resolveGlassCapability } from './resolveGlassCapability';
import { GLASS_BLUR_INTENSITY, GLASS_BLUR_RADIUS_PX, readGlassPreset, resolveGlassBackdropMap, resolveGlassSurfaceMaterial, type FloatingSurfaceRole, type GlassFloatingCoat, type GlassSurfaceGroup } from './glassMaterial';
import { useGlassMaterialSettings } from './useGlassMaterialSettings';
import { useGlassRuntimeEnvironment } from './glassRuntimeEnvironment';
import { glassElementsCoatColor, glassSurfaceBackgroundColor, glassSurfaceTintColor, resolveGlassSurfacePlaneMaterial, glassSurfacePlaneBackdropStyle, type AtmosphereContentCoat } from './glassSurfacePaint';
import { useGlassMaterialColorResolver } from './useGlassSurfaceColor';
import { parseThemeColor } from '@/theme/parseThemeColor';
import { GLASS_BACKED_FAINT_INK_SHARE, GLASS_QUIET_INK_WEB_TOKENS, GlassBackedInkContext, glassQuietThemeInks, glassThemeInkWebStyle, resolveGlassBackedInk, resolveGlassPictureInk } from './glassBackedInk';
import { GlassLivePictureBackdropContext } from './livePictureBackdrop';

const retainSolidColor = (input: Readonly<{ color: string }>) => input.color;
const withMaterialOpacity = (color: string, opacity: number) => parseThemeColor(color)?.alpha(opacity).rgb().string() ?? color;

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

export type GlassSurfaceProps = Pick<ViewProps, 'accessibilityRole' | 'accessibilityLabel' | 'role' | 'aria-label' | 'onLayout' | 'collapsable' | 'onPointerEnter' | 'onPointerLeave'> & Readonly<{
    ref?: React.Ref<React.ComponentRef<typeof View>>;
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
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
 * - Android                  → the authored tint, without a targetless SDK view.
 * - Web                      → the group's live tint/blur projection.
 * - Reduce Transparency      → solid, without changing the stored choice.
 *
 * Callers pass layout style (padding, border) only; the background/material is
 * owned here so each tier renders correctly. Do not pass an opaque
 * `backgroundColor` in `style` or the translucency tiers will be hidden.
 */
export const GlassSurface = React.memo(function GlassSurface(props: GlassSurfaceProps) {
    const { theme } = useUnistyles();
    const liquidGlassAvailable = useLiquidGlassAvailable();
    const reduceTransparency = useReduceTransparency();
    const settings = useGlassMaterialSettings();
    const runtimeEnvironment = useGlassRuntimeEnvironment();
    const group = props.surfaceGroup ?? 'floating';
    const resolveMaterialColor = useGlassMaterialColorResolver(group, props.plane === true);
    const styleBackground = readSurfaceStyleProperty(props.style, 'backgroundColor');
    const borderRadius = readSurfaceStyleProperty(props.style, 'borderRadius');
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
    const authoredSolid = props.solidColor ?? (typeof styleBackground === 'string' ? styleBackground : undefined);
    const solidColor = shellHeld && authoredSolid !== 'transparent' ? theme.colors.surface.base
        : authoredSolid ?? (group === 'floating' ? theme.colors.edge.floatingFill : theme.colors.surface.base);
    const viewProps = { ref: props.ref, testID: props.testID, accessibilityRole: props.accessibilityRole, accessibilityLabel: props.accessibilityLabel, role: props.role, 'aria-label': props['aria-label'], onLayout: props.onLayout,
        collapsable: props.collapsable, onPointerEnter: props.onPointerEnter, onPointerLeave: props.onPointerLeave };
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
    const panel: GlassFloatingCoat = group !== 'floating' ? false : overLivePicture ? 'livePicture' : props.floatingRole === 'panel';
    const [tintColor, backdropTone, panelCoatOpacity] = React.useMemo(() => {
        if (props.noCoat) return ['transparent', '', undefined] as const;
        const toneEnvironment = { ...environment, reduceTransparency: toneReduceTransparency };
        // The solid paint this surface shows over the plain page: the glass resolves to it there.
        const groundSolid = group === 'card' ? glassElementsCoatColor(solidColor, theme.colors.surface.base) : solidColor;
        // Controls nested in this glass paint its translucent inner fill; their labels stand on it too.
        const controlFill = props.translucentColor ?? theme.colors.surface.selected;
        const map = resolveGlassBackdropMap(settings, group, theme.dark, toneEnvironment, { page: theme.colors.surface.base, solid: groundSolid, ink: theme.colors.text.primary, controlFill }, panel);
        return [
            glassSurfaceTintColor({ color: groundSolid, ink: theme.colors.text.primary, controlFill, dark: theme.dark, settings, group, page: theme.colors.surface.base, environment: toneEnvironment, panel }),
            map?.tone ?? '',
            map?.opacity,
        ] as const;
    }, [solidColor, theme, settings, group, environment, toneReduceTransparency, panel, props.translucentColor, props.noCoat]);

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

    let nativeBackdrop: React.ReactNode = null;
    if (!inheritsTranslucentMaterial && capability === 'liquidGlass') {
        const GlassView = getGlassViewComponent();
        if (GlassView) {
            nativeBackdrop = (
                <GlassView
                    glassEffectStyle={props.glassEffectStyle ?? (material.blur === 'light' ? 'clear' : 'regular')}
                    style={StyleSheet.absoluteFillObject}
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

    // Inheritance follows the rendered tier, not a preference whose SDK may be unavailable.
    const translucent = material.opacity < 1 && enabled && (transparentPlane || (Platform.OS === 'web'
        ? capability === 'webBlur' || group === 'card' : capability === 'tint' || Platform.OS === 'android' || Boolean(nativeBackdrop) || inheritsTranslucentMaterial));
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
        [onPicture, backed, pictureInk, theme.colors]);
    // Text and icons that receive the faint tokens from JavaScript take them from this scope. Like the
    // web stylesheet tokens, they inherit through nested surfaces; the provider stays mounted so a tier
    // change never remounts the content.
    const withBackedInk = (children: React.ReactNode) => <GlassBackedInkContext.Provider value={props.noCoat ? containingInk : ownInk ?? inheritedInk}>{children}</GlassBackedInkContext.Provider>;
    // Keep the provider topology even without a coat. Omitted fields inherit the shared plane;
    // a plain widget must not reset its parent's ink, colour resolver or translucency.
    const materialPlane = props.noCoat ? { role: containingMaterialRole } : {
        role: group,
        finish: plane?.finish,
        translucentColor: props.translucentColor ?? theme.colors.surface.selected,
        resolveMaterialColor: !enabled || (Platform.OS !== 'web' && (material.opacity === 1 || (Platform.OS === 'ios' && capability !== 'tint' && !nativeBackdrop && !inheritsTranslucentMaterial && !transparentPlane)))
            ? retainSolidColor : resolveMaterialColor,
    };

    if (Platform.OS !== 'web') {
        const backgroundColor = transparentPlane && enabled ? 'transparent' : nativeBackdrop || inheritsTranslucentMaterial ? 'transparent'
            : (capability === 'tint' || Platform.OS === 'android') && enabled
                ? withMaterialOpacity(tintColor, material.opacity) : solidColor;
        // Only the SDK background changes tier. Input/scroll/selection state
        // must stay under the same native parent when a preset or OS choice changes.
        return <View {...viewProps} style={[props.style, props.noCoat ? null : { backgroundColor }, finishLift]}>
            <View pointerEvents="none" style={[
                StyleSheet.absoluteFillObject,
                { borderRadius, overflow: 'hidden' },
            ]}>{nativeBackdrop}{props.atmosphereCoat === 'reading' && nativeBackdrop ? <View pointerEvents="none"
                style={[StyleSheet.absoluteFillObject, { backgroundColor: withMaterialOpacity(tintColor, material.opacity) }]} /> : null}
                <HappierSurfaceGradientLayer gradient={gradient} borderRadius={typeof borderRadius === 'number' ? borderRadius : undefined} /></View>
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
    const paint = props.noCoat ? { backgroundColor: 'transparent' } : props.plane === true
        // The same CSS-to-RN-web boundary as the functional surface's backdrop below.
        ? { ...glassSurfacePlaneBackdropStyle(settings, group, theme.dark, effectiveEnvironment, props.atmosphereCoat),
            backgroundColor: glassSurfaceBackgroundColor(solidColor, group, nested, true, props.atmosphereCoat ? material.opacity : undefined) } as unknown as ViewStyle
        : inheritsTranslucentMaterial ? { backgroundColor: 'transparent' }
        : capability === 'webBlur'
        // `createBackdropWebStyle` returns web `CSSProperties` (backdrop-filter + -webkit- prefix +
        // tint); cast to the RN-web `ViewStyle` at this web boundary.
        ? createBackdropWebStyle({
            backgroundColor: glassSurfaceBackgroundColor(tintColor, group, group === 'card' ? false : nested, false, panelCoatOpacity),
            blurPx: props.blurIntensity === undefined ? GLASS_BLUR_RADIUS_PX[material.blur as keyof typeof GLASS_BLUR_RADIUS_PX] : Math.round(intensity / 5),
            surfaceGroup: group,
            backdropTone: inheritsTranslucentMaterial ? undefined : backdropTone,
        }) as unknown as ViewStyle
        : { backgroundColor: !enabled || (group === 'card' && material.opacity === 1) ? solidColor
            : glassSurfaceBackgroundColor(group === 'card' ? tintColor : solidColor, group, group === 'card' ? false : nested, false) };
    return (
        <View {...viewProps} style={[props.style, props.noCoat ? null : { backgroundColor: 'transparent' }, finishLift, backedInkStyle]}>
            {/* Native View types omit RN-web's dataSet; this branch is the web boundary. */}
            <View {...{ dataSet: { happyGlassBackdrop: 'true' } }} style={[StyleSheet.absoluteFillObject, webMaterialLayerShape(props.style), paint, happierSurfaceGradientWebStyle(gradient, !theme.dark)]} />
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

/** The layer fills the surface's padding box, so its corners follow the surface's inner radius. */
function webMaterialLayerShape(style: StyleProp<ViewStyle>): ViewStyle {
    const borderWidth = readSurfaceStyleProperty(style, 'borderWidth');
    const inset = typeof borderWidth === 'number' ? borderWidth : 0;
    // Unistyles styles retain non-enumerable geometry: flattening an array can
    // expose only its secret references. CSS inheritance keeps the paint's
    // corners attached to the real root without throwing those references away.
    const shape = { pointerEvents: 'none', borderRadius: 'inherit' } as unknown as ViewStyle;
    for (const key of WEB_CORNER_RADII) {
        const radius = readSurfaceStyleProperty(style, key);
        if (typeof radius === 'number') shape[key] = Math.max(0, radius - inset);
    }
    return shape;
}
