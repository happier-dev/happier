import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming } from 'react-native-reanimated';

export interface StatusDotProps {
    color: string;
    isPulsing?: boolean;
    size?: number;
    style?: ViewStyle;
}

export const StatusDot = React.memo((props: StatusDotProps) => {
    if (Platform.OS === 'web') {
        return <WebStatusDot {...props} />;
    }
    return <NativeStatusDot {...props} />;
});

function WebStatusDot({ color, isPulsing, size = 6, style }: StatusDotProps) {
    const baseStyle: ViewStyle = {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
    };

    return (
        <View
            style={[
                baseStyle,
                isPulsing ? webPulseStyle : null,
                style,
            ]}
        />
    );
}

function NativeStatusDot({ color, isPulsing, size = 6, style }: StatusDotProps) {
    const opacity = useSharedValue(1);

    React.useEffect(() => {
        if (isPulsing) {
            opacity.value = withRepeat(
                withTiming(0.3, { duration: 1000 }),
                -1, // infinite
                true // reverse
            );
        } else {
            opacity.value = withTiming(1, { duration: 200 });
        }
    }, [isPulsing]);

    const animatedStyle = useAnimatedStyle(() => {
        return {
            opacity: opacity.value,
        };
    });

    const baseStyle: ViewStyle = {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
    };

    return (
        <Animated.View
            style={[
                baseStyle,
                animatedStyle,
                style
            ]}
        />
    );
}

type WebPulseStyle = ViewStyle & {
    animationDirection?: 'alternate';
    animationDuration?: string;
    animationIterationCount?: string;
    animationName?: string;
    animationTimingFunction?: string;
};

const webPulseStyle: WebPulseStyle = {
    animationDirection: 'alternate',
    animationDuration: '1000ms',
    animationIterationCount: 'infinite',
    animationName: 'happierStatusDotPulse',
    animationTimingFunction: 'ease-in-out',
};
