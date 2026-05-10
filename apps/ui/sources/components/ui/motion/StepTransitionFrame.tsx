import * as React from 'react';
import { Animated, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import {
    resolveStepTransitionDirection,
    type StepTransitionDirection,
} from './resolveStepTransitionDirection';
import { stepTransitionTokens } from './stepTransitionTokens';

export type { StepTransitionDirection };

export type StepTransitionFrameProps = Readonly<{
    transitionKey: string | number;
    children: React.ReactNode;
    direction?: StepTransitionDirection;
    style?: StyleProp<ViewStyle>;
    contentStyle?: StyleProp<ViewStyle>;
    /** Override the reduced-motion preference (test/escape hatch). */
    reducedMotion?: boolean;
    testID?: string;
}>;

const stylesheet = StyleSheet.create({
    container: {
        width: '100%',
    },
    layer: {
        width: '100%',
    },
});

function directionToTranslate(direction: StepTransitionDirection, distance: number): number {
    switch (direction) {
        case 'forward':
            return distance;
        case 'backward':
            return -distance;
        case 'replace':
        default:
            return 0;
    }
}

export function StepTransitionFrame(props: StepTransitionFrameProps) {
    const styles = stylesheet;
    const detectedReducedMotion = useReducedMotionPreference();
    const reducedMotion = props.reducedMotion ?? detectedReducedMotion;
    const direction = props.direction ?? 'replace';

    const opacity = React.useRef(new Animated.Value(reducedMotion ? 1 : stepTransitionTokens.fromOpacity)).current;
    const translateX = React.useRef(
        new Animated.Value(reducedMotion ? 0 : directionToTranslate(direction, stepTransitionTokens.translatePx)),
    ).current;

    const lastKeyRef = React.useRef<string | number>(props.transitionKey);

    React.useEffect(() => {
        if (lastKeyRef.current === props.transitionKey) return;
        lastKeyRef.current = props.transitionKey;

        if (reducedMotion) {
            opacity.setValue(1);
            translateX.setValue(0);
            return;
        }

        opacity.setValue(stepTransitionTokens.fromOpacity);
        translateX.setValue(directionToTranslate(direction, stepTransitionTokens.translatePx));

        Animated.parallel([
            Animated.timing(opacity, {
                toValue: stepTransitionTokens.toOpacity,
                duration: stepTransitionTokens.durationMs.enter,
                easing: stepTransitionTokens.easing,
                useNativeDriver: true,
            }),
            Animated.timing(translateX, {
                toValue: 0,
                duration: stepTransitionTokens.durationMs.enter,
                easing: stepTransitionTokens.easing,
                useNativeDriver: true,
            }),
        ]).start();
    }, [props.transitionKey, direction, reducedMotion, opacity, translateX]);

    // First mount: animate in unless reduced motion.
    React.useEffect(() => {
        if (reducedMotion) {
            opacity.setValue(1);
            translateX.setValue(0);
            return;
        }
        Animated.parallel([
            Animated.timing(opacity, {
                toValue: stepTransitionTokens.toOpacity,
                duration: stepTransitionTokens.durationMs.enter,
                easing: stepTransitionTokens.easing,
                useNativeDriver: true,
            }),
            Animated.timing(translateX, {
                toValue: 0,
                duration: stepTransitionTokens.durationMs.enter,
                easing: stepTransitionTokens.easing,
                useNativeDriver: true,
            }),
        ]).start();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <View style={[styles.container, props.style]} testID={props.testID}>
            <Animated.View
                style={[styles.layer, props.contentStyle, { opacity, transform: [{ translateX }] }]}
            >
                {props.children}
            </Animated.View>
        </View>
    );
}

// Re-export for convenience.
export { resolveStepTransitionDirection };
