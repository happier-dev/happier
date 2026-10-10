import * as React from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle, type ViewProps } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import Color from 'color';
import { HappierMaterialRoleProvider, HappierSurfaceGradientLayer, happierSurfaceGradientWebStyle, happierSurfaceFinishLift, resolveHappierSurfaceFinish, type HappierSurfaceGradient, type HappierSurfaceFinishRole, type HappierMaterialSurfaceRender } from '@happier-dev/plugin-ui/presentation';
import { resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';
import { readSurfaceStyleProperty } from '@/components/ui/surfaces/surfaceStyle';

import { createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';

import { getBlurViewComponent } from './blurMaterial';
import { getGlassViewComponent, useLiquidGlassAvailable } from './liquidGlass';
import { resolveGlassCapability } from './resolveGlassCapability';
import { GLASS_BLUR_INTENSITY, GLASS_BLUR_RADIUS_PX, resolveGlassBackdropTone, resolveGlassSurfaceMaterial, type GlassSurfaceGroup } from './glassMaterial';
import { useGlassMaterialSettings } from './useGlassMaterialSettings';
import { useGlassRuntimeEnvironment } from './glassRuntimeEnvironment';
import { glassSurfaceBackgroundColor, glassSurfaceTintColor } from './glassSurfacePaint';
import { useGlassMaterialColorResolver } from './useGlassSurfaceColor';

const retainSolidColor = (input: Readonly<{ color: string }>) => input.color;

// The containing material owns its plane. Lists inside a floating surface inherit that paint
// instead of covering only the body with an opaque fill and leaving separate header/footer bands.
const GlassSurfaceGroupContext = React.createContext<Readonly<{ group: GlassSurfaceGroup; finish: boolean; translucent: boolean }> | null>(null);
export function useContainingGlassSurfaceGroup(): GlassSurfaceGroup | null {
    return React.useContext(GlassSurfaceGroupContext)?.group ?? null;
}

export type GlassSurfaceProps = Pick<ViewProps, 'accessibilityRole' | 'accessibilityLabel' | 'role' | 'aria-label' | 'onLayout'> & Readonly<{
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
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
    testID?: string;
    surfaceGroup?: GlassSurfaceGroup;
    /** The containing same-group plane already owns its tint coat. */
    nested?: boolean;
    /** Structural surfaces select a finish; chrome planes keep their existing flat material. */
    finishRole?: HappierSurfaceFinishRole | null;
    /** A shared surface passes the state-settled overlay; null explicitly stays flat. */
    gradient?: HappierSurfaceGradient | null;
}>;

/**
 * Tiered "glass" chrome material used by the bottom tab bars.
 *
 * - iOS 26 with Liquid Glass → real `GlassView` (`expo-glass-effect`).
 * - Other native builds        → translucent `expo-blur` `BlurView`.
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
    const environment = useGlassRuntimeEnvironment();
    const group = props.surfaceGroup ?? 'floating';
    const resolveMaterialColor = useGlassMaterialColorResolver(group);
    const styleBackground = readSurfaceStyleProperty(props.style, 'backgroundColor');
    const borderRadius = readSurfaceStyleProperty(props.style, 'borderRadius');
    const containingSurface = React.useContext(GlassSurfaceGroupContext);
    const finishRole = props.finishRole === undefined ? (group === 'floating' ? 'floating' : null) : props.finishRole;
    const inheritsFinish = props.nested === true && containingSurface?.group === group && containingSurface?.finish === true;
    const gradient = finishRole ? (props.gradient === undefined
        ? resolveThemeSurfaceFinish(theme, finishRole, undefined, inheritsFinish)
        : resolveHappierSurfaceFinish({ role: finishRole, gradients: { [finishRole]: props.gradient }, nested: inheritsFinish })) : null;
    const finishLift = finishRole ? happierSurfaceFinishLift(gradient, finishRole, theme.dark, Platform.OS === 'web') : null;
    const solidColor = props.solidColor ?? (typeof styleBackground === 'string' ? styleBackground : undefined) ?? (group === 'floating' ? theme.colors.edge.floatingFill : theme.colors.surface.base);
    const viewProps = { testID: props.testID, accessibilityRole: props.accessibilityRole, accessibilityLabel: props.accessibilityLabel, role: props.role, 'aria-label': props['aria-label'], onLayout: props.onLayout };
    const { material } = resolveGlassSurfaceMaterial(settings, group, {
        ...environment,
        reduceTransparency: reduceTransparency || environment.reduceTransparency === true,
    });
    const intensity = props.blurIntensity ?? GLASS_BLUR_INTENSITY[material.blur as keyof typeof GLASS_BLUR_INTENSITY];
    const tintColor = glassSurfaceTintColor({ color: solidColor, ink: theme.colors.text.primary, dark: theme.dark, settings, group,
        environment: { ...environment, reduceTransparency: reduceTransparency || environment.reduceTransparency === true } });

    const capability = props.enabled === false
        ? 'solid'
        : resolveGlassCapability({
            liquidGlassAvailable,
            // SDK 55 Android has no shared blur target; use the honest tint fallback.
            blurAvailable: Platform.OS === 'ios',
            webBlurAvailable: Platform.OS === 'web',
            ...environment,
            reduceTransparency: reduceTransparency || environment.reduceTransparency === true,
            settings,
            surfaceGroup: group,
        });
    const inheritsTranslucentMaterial = props.nested === true && containingSurface?.group === group && containingSurface?.translucent === true && material.opacity < 1 && props.enabled !== false;

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
    const translucent = material.opacity < 1 && props.enabled !== false && (Platform.OS === 'web'
        ? capability === 'webBlur' : Platform.OS === 'android' || Boolean(nativeBackdrop) || inheritsTranslucentMaterial);
    const plane = React.useMemo(() => ({ group, finish: Boolean(gradient) || Boolean(inheritsFinish), translucent }), [group, gradient, inheritsFinish, translucent]);

    if (Platform.OS !== 'web') {
        const backgroundColor = nativeBackdrop || inheritsTranslucentMaterial ? 'transparent'
            : Platform.OS === 'android' && props.enabled !== false
                ? Color(tintColor).alpha(material.opacity).rgb().string() : solidColor;
        // Only the SDK background changes tier. Input/scroll/selection state
        // must stay under the same native parent when a preset or OS choice changes.
        return <View {...viewProps} style={[props.style, { backgroundColor }, finishLift]}>
            <View pointerEvents="none" style={[
                StyleSheet.absoluteFillObject,
                { borderRadius, overflow: 'hidden' },
            ]}>{nativeBackdrop}<HappierSurfaceGradientLayer gradient={gradient} borderRadius={typeof borderRadius === 'number' ? borderRadius : undefined} /></View>
            <GlassSurfaceGroupContext.Provider value={plane}>
                <HappierMaterialRoleProvider role={group} finish={plane.finish} translucentColor={theme.colors.surface.selected}
                    resolveMaterialColor={props.enabled === false || material.opacity === 1 || (Platform.OS === 'ios' && !nativeBackdrop && !inheritsTranslucentMaterial) ? retainSolidColor : resolveMaterialColor}>
                    {props.children}
                </HappierMaterialRoleProvider>
            </GlassSurfaceGroupContext.Provider>
        </View>;
    }

    // Web paints the material on its own layer beneath the content, in every tier, so a tier change
    // never moves the content to another parent. A CSS `backdrop-filter` makes its element a backdrop
    // root: on the surface itself it would cut everything inside (a menu, tooltip or popover opened
    // from this surface) off the page, and that nested glass would blur an empty plane.
    const paint = capability === 'webBlur'
        // `createBackdropWebStyle` returns web `CSSProperties` (backdrop-filter + -webkit- prefix +
        // tint); cast to the RN-web `ViewStyle` at this web boundary.
        ? createBackdropWebStyle({
            backgroundColor: glassSurfaceBackgroundColor(tintColor, group, props.nested),
            blurPx: props.blurIntensity === undefined ? GLASS_BLUR_RADIUS_PX[material.blur as keyof typeof GLASS_BLUR_RADIUS_PX] : Math.round(intensity / 5),
            surfaceGroup: group,
            backdropTone: inheritsTranslucentMaterial ? undefined : resolveGlassBackdropTone(settings, group, theme.dark, {
                ...environment, reduceTransparency: reduceTransparency || environment.reduceTransparency === true,
            }),
        }) as unknown as ViewStyle
        : { backgroundColor: props.enabled === false ? solidColor : glassSurfaceBackgroundColor(solidColor, group, props.nested) };
    return (
        <View {...viewProps} style={[props.style, { backgroundColor: 'transparent' }, finishLift]}>
            {/* Native View types omit RN-web's dataSet; this branch is the web boundary. */}
            <View {...{ dataSet: { happyGlassBackdrop: 'true' } }} style={[StyleSheet.absoluteFillObject, webMaterialLayerShape(props.style), paint, happierSurfaceGradientWebStyle(gradient, !theme.dark)]} />
            <GlassSurfaceGroupContext.Provider value={plane}>
                <HappierMaterialRoleProvider role={group} finish={plane.finish} translucentColor={theme.colors.surface.selected}
                    resolveMaterialColor={props.enabled === false || material.opacity === 1 ? retainSolidColor : resolveMaterialColor}>
                    {props.children}
                </HappierMaterialRoleProvider>
            </GlassSurfaceGroupContext.Provider>
        </View>
    );
});

const WEB_CORNER_RADII = ['borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'] as const;

/** Core shared frames and sheets bind the same material owner as mounted plugin surfaces. */
export const renderThemeMaterialSurface: HappierMaterialSurfaceRender = input => <GlassSurface
    surfaceGroup={input.role} finishRole={input.finishRole ?? 'card'} nested={input.role === 'floating' ? input.nested : true}
    gradient={input.gradient}
    style={input.style as StyleProp<ViewStyle>} testID={input.testID} onLayout={input.onLayout} accessibilityLabel={input.accessibilityLabel}
>{input.children}</GlassSurface>;

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
