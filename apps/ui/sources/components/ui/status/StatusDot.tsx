import * as React from 'react';
import { Animated, Platform, View, type ViewStyle } from 'react-native';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

const WEB_PULSE_TIMING_FUNCTION = 'steps(6, end)';

export interface StatusDotProps {
    color: string;
    isPulsing?: boolean;
    size?: number;
    style?: ViewStyle;
    testID?: string;
    accessibilityLabel?: string;
    /** Keep pulsing state visible while disabling the web CSS animation. */
    animationEnabled?: boolean;
}

export const StatusDot = React.memo((props: StatusDotProps) => {
    if (!props.isPulsing || props.animationEnabled === false) {
        return <StaticStatusDot {...props} />;
    }
    return <MotionAwareStatusDot {...props} />;
});

function MotionAwareStatusDot(props: StatusDotProps) {
    const reducedMotion = useReducedMotionPreference();
    if (reducedMotion) {
        return <StaticStatusDot {...props} />;
    }

    if (Platform.OS === 'web') {
        return <WebStatusDot {...props} />;
    }
    return <PulsingStatusDot {...props} />;
}

function accessibilityProps(accessibilityLabel: string | undefined) {
    return accessibilityLabel
        ? {
            accessibilityRole: 'image' as const,
            accessibilityLabel,
        }
        : {
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants' as const,
        };
}

function WebStatusDot({ color, isPulsing, size = 6, style, testID, animationEnabled = true, accessibilityLabel }: StatusDotProps) {
    const baseStyle: ViewStyle = {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
    };

    return (
        <View
            testID={testID}
            {...accessibilityProps(accessibilityLabel)}
            style={[
                baseStyle,
                isPulsing && animationEnabled ? webPulseStyle : null,
                style,
            ]}
        />
    );
}

function StaticStatusDot({ color, size = 6, style, testID, accessibilityLabel }: StatusDotProps) {
    const baseStyle: ViewStyle = {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
    };

    return (
        <View
            testID={testID}
            {...accessibilityProps(accessibilityLabel)}
            style={[
                baseStyle,
                style
            ]}
        />
    );
}

function PulsingStatusDot({ color, size = 6, style, testID, accessibilityLabel }: StatusDotProps) {
    const opacity = React.useRef(new Animated.Value(1)).current;

    React.useEffect(() => {
        const animation = Animated.loop(
            Animated.sequence([
                Animated.timing(opacity, {
                    toValue: 0.3,
                    duration: 1000,
                    useNativeDriver: true,
                }),
                Animated.timing(opacity, {
                    toValue: 1,
                    duration: 1000,
                    useNativeDriver: true,
                }),
            ]),
        );
        animation.start();
        return () => {
            animation.stop();
        };
    }, [opacity]);

    const baseStyle: ViewStyle = {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
    };

    return (
        <Animated.View
            testID={testID}
            {...accessibilityProps(accessibilityLabel)}
            style={[
                baseStyle,
                { opacity },
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
