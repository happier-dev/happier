import { LinearGradient } from 'expo-linear-gradient';
import * as React from 'react';
import { StyleSheet as ReactNativeStyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

export type SurfaceGradient = Readonly<{
    colors: readonly [string, string, ...string[]];
    start?: Readonly<{ x: number; y: number }>;
    end?: Readonly<{ x: number; y: number }>;
}>;

export type GradientSurfaceProps = Readonly<{
    fallbackColor: string;
    gradient?: SurfaceGradient;
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
            ]}
        >
            {props.gradient ? (
                <LinearGradient
                    pointerEvents="none"
                    colors={props.gradient.colors}
                    start={props.gradient.start}
                    end={props.gradient.end}
                    style={ReactNativeStyleSheet.absoluteFill}
                />
            ) : null}
            {props.children}
        </View>
    );
});
