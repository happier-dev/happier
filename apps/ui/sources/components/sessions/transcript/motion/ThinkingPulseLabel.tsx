import * as React from 'react';
import { Animated, Easing, Platform } from 'react-native';

import { Text } from '@/components/ui/text/Text';

export const ThinkingPulseLabel = React.memo(function ThinkingPulseLabel(props: {
    label: string;
    enabled: boolean;
    style?: any;
}) {
    const opacity = React.useRef(new Animated.Value(1)).current;

    React.useEffect(() => {
        if (!props.enabled) {
            opacity.setValue?.(1);
            return;
        }
        if (typeof (Animated as any).loop !== 'function') return;

        const durationMs = 1800;
        const useNativeDriver = Platform.OS !== 'web';
        const animation = (Animated as any).loop(
            (Animated as any).sequence([
                Animated.timing(opacity, {
                    toValue: 0.60,
                    duration: durationMs,
                    easing: Easing.inOut(Easing.quad),
                    useNativeDriver,
                }),
                Animated.timing(opacity, {
                    toValue: 1,
                    duration: durationMs,
                    easing: Easing.inOut(Easing.quad),
                    useNativeDriver,
                }),
            ]),
        );
        animation.start();
        return () => {
            animation.stop?.();
        };
    }, [opacity, props.enabled]);

    if (!props.enabled) {
        return <Text style={props.style}>{props.label}</Text>;
    }

    return (
        <Animated.View style={{ opacity }}>
            <Text style={props.style}>{props.label}</Text>
        </Animated.View>
    );
});
