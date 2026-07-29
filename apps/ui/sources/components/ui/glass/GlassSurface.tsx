import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';

import { getBlurViewComponent } from './blurMaterial';
import { getGlassViewComponent, useLiquidGlassAvailable } from './liquidGlass';
import { resolveGlassCapability } from './resolveGlassCapability';

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
    /** Fill color for the opaque solid tier (web / reduce-transparency / disabled). Defaults to `surface.base`. */
    solidColor?: string;
    testID?: string;
}>;

/**
 * Tiered "glass" chrome material used by the bottom tab bars.
 *
 * - iOS 26 with Liquid Glass → real `GlassView` (`expo-glass-effect`).
 * - Other native builds        → translucent `expo-blur` `BlurView`.
 * - Web / Reduce Transparency  → opaque `surface.base` (today's look).
 *
 * Callers pass layout style (padding, border) only; the background/material is
 * owned here so each tier renders correctly. Do not pass an opaque
 * `backgroundColor` in `style` or the translucency tiers will be hidden.
 */
export const GlassSurface = React.memo(function GlassSurface(props: GlassSurfaceProps) {
    const { theme } = useUnistyles();
    const liquidGlassAvailable = useLiquidGlassAvailable();
    const reduceTransparency = useReduceTransparency();

    const capability = props.enabled === false
        ? 'solid'
        : resolveGlassCapability({
            liquidGlassAvailable,
            blurAvailable: Platform.OS !== 'web',
            webBlurAvailable: Platform.OS === 'web',
            reduceTransparency,
        });

    if (capability === 'liquidGlass') {
        const GlassView = getGlassViewComponent();
        if (GlassView) {
            return (
                <GlassView
                    testID={props.testID}
                    glassEffectStyle={props.glassEffectStyle ?? 'regular'}
                    style={props.style}
                >
                    {props.children}
                </GlassView>
            );
        }
    }

    if (capability === 'blur') {
        const BlurView = getBlurViewComponent();
        if (BlurView) {
            return (
                <BlurView
                    testID={props.testID}
                    tint={theme.dark ? 'dark' : 'light'}
                    intensity={props.blurIntensity ?? 50}
                    experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
                    style={props.style}
                >
                    {props.children}
                </BlurView>
            );
        }
    }

    if (capability === 'webBlur') {
        return (
            <View
                testID={props.testID}
                // `createBackdropWebStyle` returns web `CSSProperties` (backdrop-filter +
                // -webkit- prefix + tint, with a "blur off" preference fallback); cast to
                // the RN-web `ViewStyle` at this web boundary.
                style={[
                    createBackdropWebStyle({
                        backgroundColor: theme.colors.glass.webBlurTint,
                        // Map the native blur intensity (≈25/50/80) to a softer CSS radius
                        // so web glass reads as a refined frost, not an overpowering blur.
                        blurPx: Math.round((props.blurIntensity ?? 50) / 5),
                        fallbackBackgroundColorWhenBlurDisabled: props.solidColor ?? theme.colors.surface.base,
                    }) as unknown as ViewStyle,
                    props.style,
                ]}
            >
                {props.children}
            </View>
        );
    }

    return (
        <View
            testID={props.testID}
            style={[{ backgroundColor: props.solidColor ?? theme.colors.surface.base }, props.style]}
        >
            {props.children}
        </View>
    );
});
