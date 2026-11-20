import * as React from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { Canvas, Image } from '@shopify/react-native-skia';

import type { StepFreezeImageProps } from './StepFreezeImage';

export function StepFreezeImage({ freeze, opacity, durationMs, delayMs, onCleared }: StepFreezeImageProps) {
    const [progress] = React.useState(() => new Animated.Value(0));
    const lastFrame = opacity.length - 1;
    let lastVisibleFrame = lastFrame;
    while (lastVisibleFrame >= 0 && !(opacity[lastVisibleFrame] > 0)) {
        lastVisibleFrame--;
    }
    const clearFrame = Math.min(lastFrame, lastVisibleFrame + 1);
    const visibleDuration = clearFrame > 0 ? durationMs * clearFrame / lastFrame : 0;
    const [visible, setVisible] = React.useState(visibleDuration > 0);
    const { x, y, width, height } = freeze.rect;
    React.useLayoutEffect(() => {
        if (!visible) {
            onCleared();
            return;
        }
        const animation = Animated.timing(progress, {
            toValue: 1, duration: visibleDuration, delay: delayMs, easing: Easing.linear, useNativeDriver: true,
        });
        animation.start(({ finished }) => { if (finished) setVisible(false); });
        return () => animation.stop();
    }, [progress, visibleDuration, delayMs, visible, onCleared]);
    const image = freeze.image;
    if (!image || !visible) return null;
    const visibleOpacity = opacity.slice(0, clearFrame + 1);
    return <Animated.View pointerEvents="none" style={{
        position: 'absolute', left: x, top: y, width, height,
        opacity: progress.interpolate({
            inputRange: visibleOpacity.map((_, index) => index / clearFrame),
            outputRange: visibleOpacity,
        }),
    }}>
        <Canvas style={StyleSheet.absoluteFill}><Image image={image} x={0} y={0} width={width} height={height} fit="fill" /></Canvas>
    </Animated.View>;
}
