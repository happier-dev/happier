import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming } from 'react-native-reanimated';

const WEB_PULSE_TIMING_FUNCTION = 'steps(6, end)';

export interface StatusDotProps {
    color: string;
    isPulsing?: boolean;
    size?: number;
    style?: ViewStyle;
    testID?: string;
    /** Keep pulsing state visible while disabling the web CSS animation. */
    animationEnabled?: boolean;
}

export const StatusDot = React.memo((props: StatusDotProps) => {
    if (Platform.OS === 'web') {
        return <WebStatusDot {...props} />;
    }
    if (props.isPulsing) {
        return <PulsingStatusDot {...props} />;
    }
    return <StaticStatusDot {...props} />;
});

function WebStatusDot({ color, isPulsing, size = 6, style, testID, animationEnabled = true }: StatusDotProps) {
    const baseStyle: ViewStyle = {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
    };

    return (
        <View
            testID={testID}
            style={[
                baseStyle,
                isPulsing && animationEnabled ? webPulseStyle : null,
                style,
            ]}
        />
    );
}

function StaticStatusDot({ color, size = 6, style, testID }: StatusDotProps) {
    const baseStyle: ViewStyle = {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
    };

    return (
        <View
            testID={testID}
            style={[
                baseStyle,
                style
            ]}
        />
    );
}

function PulsingStatusDot({ color, size = 6, style, testID }: StatusDotProps) {
    const opacity = useSharedValue(1);

    React.useEffect(() => {
        opacity.value = withRepeat(
            withTiming(0.3, { duration: 1000 }),
            -1, // infinite
            true // reverse
        );
    }, []);

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
            testID={testID}
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
    animationTimingFunction: WEB_PULSE_TIMING_FUNCTION,
};
