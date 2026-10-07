import * as React from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import Color from 'color';

import { createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';

import { getBlurViewComponent } from './blurMaterial';
import { getGlassViewComponent, useLiquidGlassAvailable } from './liquidGlass';
import { resolveGlassCapability } from './resolveGlassCapability';
import { GLASS_BLUR_INTENSITY, resolveGlassSurfaceMaterial, type GlassSurfaceGroup } from './glassMaterial';
import { useGlassMaterialSettings } from './useGlassMaterialSettings';
import { useGlassRuntimeEnvironment } from './glassRuntimeEnvironment';
import { glassSurfaceBackgroundColor } from './glassSurfacePaint';

export type GlassSurfaceProps = Readonly<{
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
    const solidColor = props.solidColor ?? (group === 'floating' ? theme.colors.edge.floatingFill : theme.colors.surface.base);
    const { material } = resolveGlassSurfaceMaterial(settings, group, {
        ...environment,
        reduceTransparency: reduceTransparency || environment.reduceTransparency === true,
    });
    const intensity = props.blurIntensity ?? GLASS_BLUR_INTENSITY[material.blur];

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

    let nativeBackdrop: React.ReactNode = null;
    if (capability === 'liquidGlass') {
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

    if (capability === 'blur') {
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

    if (Platform.OS !== 'web') {
        const color = solidColor;
        const backgroundColor = nativeBackdrop ? 'transparent'
            : Platform.OS === 'android' && props.enabled !== false
                ? Color(color).alpha(material.opacity).rgb().string() : color;
        // Only the SDK background changes tier. Input/scroll/selection state
        // must stay under the same native parent when a preset or OS choice changes.
        return <View testID={props.testID} style={[{ backgroundColor }, props.style]}>
            <View pointerEvents="none" style={[
                StyleSheet.absoluteFillObject,
                { borderRadius: StyleSheet.flatten(props.style)?.borderRadius, overflow: 'hidden' },
            ]}>{nativeBackdrop}</View>
            {props.children}
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
            backgroundColor: glassSurfaceBackgroundColor(solidColor, group, props.nested),
            // Map the native blur intensity (≈25/50/80) to a softer CSS radius
            // so web glass reads as a refined frost, not an overpowering blur.
            blurPx: Math.round(intensity / 5),
            surfaceGroup: group,
        }) as unknown as ViewStyle
        : { backgroundColor: glassSurfaceBackgroundColor(solidColor, group, props.nested) };
    return (
        <View testID={props.testID} style={props.style}>
            <View style={[StyleSheet.absoluteFillObject, webMaterialLayerShape(props.style), paint]} />
            {props.children}
        </View>
    );
});

const WEB_CORNER_RADII = ['borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'] as const;

/** The layer fills the surface's padding box, so its corners follow the surface's inner radius. */
function webMaterialLayerShape(style: StyleProp<ViewStyle>): ViewStyle {
    const flat = StyleSheet.flatten(style) ?? {};
    const inset = typeof flat.borderWidth === 'number' ? flat.borderWidth : 0;
    const shape: ViewStyle = { pointerEvents: 'none' };
    for (const key of WEB_CORNER_RADII) {
        const radius = flat[key];
        if (typeof radius === 'number') shape[key] = Math.max(0, radius - inset);
    }
    return shape;
}
