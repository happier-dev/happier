import * as React from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { Canvas, Image } from '@shopify/react-native-skia';

import type { StepFreezeImageProps } from './StepFreezeImage';

export function StepFreezeImage({ freeze, opacity, durationMs, delayMs }: StepFreezeImageProps) {
    const [progress] = React.useState(() => new Animated.Value(0));
    const { x, y, width, height } = freeze.rect;
    React.useLayoutEffect(() => {
        const animation = Animated.timing(progress, {
            toValue: 1, duration: durationMs, delay: delayMs, easing: Easing.linear, useNativeDriver: true,
        });
        animation.start();
        return () => animation.stop();
    }, [progress, durationMs, delayMs]);
    const image = freeze.image;
    if (!image) return null;
    return <Animated.View pointerEvents="none" style={{
        position: 'absolute', left: x, top: y, width, height,
        opacity: progress.interpolate({
            inputRange: opacity.map((_, index) => index / (opacity.length - 1)),
            outputRange: [...opacity],
        }),
    }}>
        <Canvas style={StyleSheet.absoluteFill}><Image image={image} x={0} y={0} width={width} height={height} fit="fill" /></Canvas>
    </Animated.View>;
}
