import { HappierSurfaceGradientLayer, happierSurfaceGradientWebStyle, type HappierSurfaceGradient } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

export type SurfaceGradient = HappierSurfaceGradient;

export type GradientSurfaceProps = Readonly<{
    fallbackColor: string;
    gradient?: SurfaceGradient | null;
    overlay?: SurfaceGradient | null;
    clipToPaddingBox?: boolean;
    borderRadius: number;
    style?: StyleProp<ViewStyle>;
    children?: React.ReactNode;
}>;

export const GradientSurface = React.memo(function GradientSurface(props: GradientSurfaceProps) {
    return (
        <View
            style={[
                {
                    backgroundColor: props.fallbackColor,
                    borderRadius: props.borderRadius,
                    overflow: 'hidden',
                    position: 'relative',
                },
                props.style,
                Platform.OS === 'web' ? combinedWebGradientStyle(props.gradient, props.overlay, props.clipToPaddingBox !== false) : null,
            ]}
        >
            <HappierSurfaceGradientLayer underlay={props.gradient} gradient={props.overlay} borderRadius={props.borderRadius} />
            {props.children}
        </View>
    );
});

function combinedWebGradientStyle(gradient: SurfaceGradient | null | undefined, overlay: SurfaceGradient | null | undefined, clip: boolean) {
    const base = happierSurfaceGradientWebStyle(gradient, clip);
    const top = happierSurfaceGradientWebStyle(overlay, clip);
    return base && top ? { ...top, backgroundImage: `${top.backgroundImage}, ${base.backgroundImage}` } : top ?? base;
}
