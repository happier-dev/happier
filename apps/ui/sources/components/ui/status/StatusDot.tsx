import * as React from 'react';
import { Platform, View, ViewStyle } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming } from 'react-native-reanimated';

export interface StatusDotProps {
    color: string;
    isPulsing?: boolean;
    size?: number;
    style?: ViewStyle;
}

const STATUS_DOT_PULSE_STYLE_ID = 'happier-status-dot-pulse-style';
let statusDotPulseStyleInjected = false;

function injectStatusDotPulseStyle(): void {
    if (statusDotPulseStyleInjected || Platform.OS !== 'web') return;
    if (typeof document === 'undefined') return;

    statusDotPulseStyleInjected = true;
    if (document.getElementById(STATUS_DOT_PULSE_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STATUS_DOT_PULSE_STYLE_ID;
    style.textContent = [
        '@keyframes happierStatusDotPulse {',
        '  0% { opacity: 1; }',
        '  50% { opacity: 0.3; }',
        '  100% { opacity: 1; }',
        '}',
    ].join('\n');
    document.head.appendChild(style);
}

const AnimatedStatusDot = React.memo(({ color, isPulsing, size = 6, style }: StatusDotProps) => {
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
    }, [isPulsing, opacity]);

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
});

const webPulseStyle = {
    animationName: 'happierStatusDotPulse',
    animationDuration: '1000ms',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    animationFillMode: 'both',
} as ViewStyle;

const WebStatusDot = React.memo(({ color, isPulsing, size = 6, style }: StatusDotProps) => {
    React.useEffect(() => {
        if (isPulsing) {
            injectStatusDotPulseStyle();
        }
    }, [isPulsing]);

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
});

export const StatusDot = React.memo((props: StatusDotProps) => {
    if (Platform.OS === 'web') {
        return <WebStatusDot {...props} />;
    }
    return <AnimatedStatusDot {...props} />;
});
