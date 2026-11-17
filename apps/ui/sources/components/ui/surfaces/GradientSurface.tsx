import type { SurfaceAddress } from '@happier-dev/plugin-ui';
import { useUnistyles } from 'react-native-unistyles';
import { HappierSurfaceGradientLayer, happierSurfaceGradientWebStyle, resolveHappierThemeSurfaceStyle, useHappierThemeSurfaceOverridesEnabled, type HappierSurfaceGradient } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

export type SurfaceGradient = HappierSurfaceGradient;

export type GradientSurfaceProps = Readonly<{
    fallbackColor: string;
    themeSurface?: SurfaceAddress;
    gradient?: SurfaceGradient | null;
    overlay?: SurfaceGradient | null;
    clipToPaddingBox?: boolean;
    borderRadius: number;
    style?: StyleProp<ViewStyle>;
    children?: React.ReactNode;
}>;

export const GradientSurface = React.memo(function GradientSurface(props: GradientSurfaceProps) {
    const { theme } = useUnistyles();
    const surfaceOverridesEnabled = useHappierThemeSurfaceOverridesEnabled();
    const overrideBackgroundColor = surfaceOverridesEnabled && props.themeSurface
        ? resolveHappierThemeSurfaceStyle(theme, props.themeSurface, Platform.OS)?.backgroundColor
        : undefined;
    return (
        <View
            style={[
                {
                    backgroundColor: overrideBackgroundColor === undefined ? props.fallbackColor : 'transparent',
                    borderRadius: props.borderRadius,
                    overflow: 'hidden',
                    position: 'relative',
                },
                props.style,
                Platform.OS === 'web' ? combinedWebGradientStyle(props.gradient, props.overlay, props.clipToPaddingBox !== false) : null,
            ]}
        >
            <HappierSurfaceGradientLayer overrideBackgroundColor={overrideBackgroundColor} underlay={props.gradient} gradient={props.overlay} borderRadius={props.borderRadius} />
            {props.children}
        </View>
    );
});

export function combinedWebGradientStyle(gradient: SurfaceGradient | null | undefined, overlay: SurfaceGradient | null | undefined, clip: boolean): ReturnType<typeof happierSurfaceGradientWebStyle> {
    const base = happierSurfaceGradientWebStyle(gradient, clip);
    const top = happierSurfaceGradientWebStyle(overlay, clip);
    if (!base || !top) return top ?? base;
    // Each layer keeps its own extent: a banded finish stays a strip over the full-height base.
    const layer = <K extends 'backgroundSize' | 'backgroundPosition' | 'backgroundRepeat'>(key: K, full: string) => `${top[key] ?? full}, ${base[key] ?? full}`;
    return top.backgroundSize || base.backgroundSize
        ? { ...top, backgroundImage: `${top.backgroundImage}, ${base.backgroundImage}`, backgroundSize: layer('backgroundSize', '100% 100%'), backgroundPosition: layer('backgroundPosition', 'top'), backgroundRepeat: layer('backgroundRepeat', 'no-repeat') }
        : { ...top, backgroundImage: `${top.backgroundImage}, ${base.backgroundImage}` };
}
