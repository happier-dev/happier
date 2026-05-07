import * as React from 'react';
import { Animated, Platform, type StyleProp, type ViewStyle } from 'react-native';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { motionTokens } from '@/components/ui/motion/motionTokens';

export type OverlayMotionKind = 'popover' | 'modal';
export type OverlayMotionDirection = 'top' | 'bottom' | 'left' | 'right' | 'center';

export type OverlayMotionPreset = Readonly<{
    enterMs: number;
    exitMs: number;
    fromOpacity: number;
    fromScale: number;
    fromTranslateX: number;
    fromTranslateY: number;
}>;

export function resolveOverlayMotionDirectionFromPlacement(placement: string): OverlayMotionDirection {
    switch (placement) {
        case 'top':
        case 'bottom':
        case 'left':
        case 'right':
            return placement;
        default:
            return 'center';
    }
}

export function resolveOverlayMotionPreset(params: Readonly<{
    kind: OverlayMotionKind;
    direction?: OverlayMotionDirection;
}>): OverlayMotionPreset {
    const direction = params.direction ?? 'center';

    if (params.kind === 'modal') {
        return {
            enterMs: motionTokens.overlay.modal.enterMs,
            exitMs: motionTokens.overlay.modal.exitMs,
            fromOpacity: 0,
            fromScale: motionTokens.overlay.modal.fromScale,
            fromTranslateX: 0,
            fromTranslateY: motionTokens.overlay.modal.fromTranslateY,
        };
    }

    const fromDistance = motionTokens.overlay.popover.fromDistance;

    return {
        enterMs: motionTokens.overlay.popover.enterMs,
        exitMs: motionTokens.overlay.popover.exitMs,
        fromOpacity: 0,
        fromScale: motionTokens.overlay.popover.fromScale,
        fromTranslateX:
            direction === 'left'
                ? fromDistance
                : direction === 'right'
                    ? -fromDistance
                    : 0,
        fromTranslateY:
            direction === 'top'
                ? fromDistance
                : direction === 'bottom'
                    ? -fromDistance
                    : 0,
    };
}

export function useOverlayPresence(visible: boolean, exitMs: number): Readonly<{
    present: boolean;
    exiting: boolean;
}> {
    const [presentState, setPresentState] = React.useState(visible);
    const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        return () => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
        };
    }, []);

    React.useEffect(() => {
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }

        if (visible) {
            setPresentState(true);
            return;
        }

        if (!presentState) return;

        if (exitMs <= 0) {
            setPresentState(false);
            return;
        }

        timeoutRef.current = setTimeout(() => {
            timeoutRef.current = null;
            setPresentState(false);
        }, exitMs);
    }, [exitMs, presentState, visible]);

    const present = visible || presentState;
    return {
        present,
        exiting: present && !visible,
    };
}

export function useOverlayMotionAnimation(params: Readonly<{
    visible: boolean;
    preset: OverlayMotionPreset;
}>): Readonly<{
    exitMs: number;
    progress: Animated.Value;
    style: StyleProp<ViewStyle>;
}> {
    const reducedMotion = useReducedMotionPreference();
    const progress = React.useRef(new Animated.Value(0)).current;

    React.useEffect(() => {
        Animated.timing(progress, {
            toValue: params.visible ? 1 : 0,
            duration: reducedMotion
                ? motionTokens.durationMs.instant
                : (params.visible ? params.preset.enterMs : params.preset.exitMs),
            easing: motionTokens.easing.standard,
            useNativeDriver: Platform.OS !== 'web',
        }).start();
    }, [params.preset.enterMs, params.preset.exitMs, params.visible, progress, reducedMotion]);

    const opacity = progress.interpolate({
        inputRange: [0, 1],
        outputRange: [params.preset.fromOpacity, 1],
    });
    const scale = progress.interpolate({
        inputRange: [0, 1],
        outputRange: [params.preset.fromScale, 1],
    });
    const translateX = progress.interpolate({
        inputRange: [0, 1],
        outputRange: [params.preset.fromTranslateX, 0],
    });
    const translateY = progress.interpolate({
        inputRange: [0, 1],
        outputRange: [params.preset.fromTranslateY, 0],
    });

    return {
        exitMs: reducedMotion ? motionTokens.durationMs.instant : params.preset.exitMs,
        progress,
        style: {
            opacity,
            transform: [{ translateX }, { translateY }, { scale }],
        },
    };
}

export function OverlayMotionFrame(props: Readonly<{
    visible: boolean;
    kind: OverlayMotionKind;
    direction?: OverlayMotionDirection;
    style?: StyleProp<ViewStyle>;
    pointerEvents?: 'box-none' | 'none' | 'auto' | 'box-only';
    children: React.ReactNode;
}>): React.ReactElement {
    const preset = React.useMemo(() => resolveOverlayMotionPreset({
        kind: props.kind,
        direction: props.direction,
    }), [props.direction, props.kind]);
    const motion = useOverlayMotionAnimation({
        visible: props.visible,
        preset,
    });

    return (
        <Animated.View
            pointerEvents={props.pointerEvents ?? (props.visible ? 'auto' : 'none')}
            style={[props.style, motion.style]}
        >
            {props.children}
        </Animated.View>
    );
}
