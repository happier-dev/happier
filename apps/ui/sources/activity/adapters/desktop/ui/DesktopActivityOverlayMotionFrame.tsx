import * as React from 'react';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { DESKTOP_ACTIVITY_OVERLAY_RENDER_PROGRESS_FRAME_MS } from '../desktopActivityOverlayTiming';
import {
    resolveDesktopOverlayMotionSpec,
    type DesktopOverlayMotionSpec,
} from '../motion/desktopOverlaySprings';

const DesktopActivityOverlayMotionProgressContext = React.createContext(0);

export function useDesktopActivityOverlayMotionProgress(): number {
    return React.useContext(DesktopActivityOverlayMotionProgressContext);
}

function animateDesktopOverlayProgress(
    target: number,
    spec: DesktopOverlayMotionSpec,
): number {
    if (spec.kind === 'instant') {
        return withTiming(target, { duration: 0 });
    }
    if (spec.kind === 'spring') {
        return withSpring(target, {
            duration: spec.response * 1000,
            dampingRatio: spec.dampingRatio,
        });
    }
    return withTiming(target, {
        duration: spec.durationMs,
        easing: Easing.out(Easing.cubic),
    });
}

function resolveDesktopOverlayRenderProgressDurationMs(spec: DesktopOverlayMotionSpec): number {
    if (spec.kind === 'instant') return 0;
    if (spec.kind === 'spring') return spec.response * 1000;
    return spec.durationMs;
}

export function DesktopActivityOverlayMotionFrame(props: Readonly<{
    visible: boolean;
    expanded: boolean;
    edgeAnchored?: boolean;
    children: React.ReactNode;
}>): React.ReactElement {
    const reduceMotion = useReducedMotionPreference();
    const visibilityProgress = useSharedValue(props.visible ? 1 : 0);
    const openProgress = useSharedValue(props.expanded ? 1 : 0);
    const [openProgressValue, setOpenProgressValue] = React.useState(props.expanded ? 1 : 0);
    const openProgressValueRef = React.useRef(openProgressValue);
    const edgeAnchored = props.edgeAnchored === true;

    const setRenderOpenProgress = React.useCallback((progress: number) => {
        const normalizedProgress = Math.max(0, Math.min(1, progress));
        openProgressValueRef.current = normalizedProgress;
        setOpenProgressValue(normalizedProgress);
    }, []);

    React.useEffect(() => {
        const target = props.visible ? 1 : 0;
        visibilityProgress.value = animateDesktopOverlayProgress(
            target,
            resolveDesktopOverlayMotionSpec(
                target === 1 && props.expanded ? 'open' : 'close',
                reduceMotion,
            ),
        );
    }, [visibilityProgress, props.expanded, props.visible, reduceMotion]);

    React.useEffect(() => {
        const target = props.expanded ? 1 : 0;
        const spec = resolveDesktopOverlayMotionSpec(target === 1 ? 'open' : 'close', reduceMotion);
        openProgress.value = animateDesktopOverlayProgress(target, spec);

        const durationMs = resolveDesktopOverlayRenderProgressDurationMs(spec);
        const start = openProgressValueRef.current;
        if (durationMs <= 0 || start === target) {
            setRenderOpenProgress(target);
            return;
        }

        const startedAt = Date.now();
        const intervalId = setInterval(() => {
            const elapsedMs = Date.now() - startedAt;
            const progress = Math.min(1, Math.max(0, elapsedMs / durationMs));
            const next = start + ((target - start) * progress);
            setRenderOpenProgress(next);
            if (progress >= 1) {
                clearInterval(intervalId);
            }
        }, DESKTOP_ACTIVITY_OVERLAY_RENDER_PROGRESS_FRAME_MS);
        const timeoutId = setTimeout(() => {
            clearInterval(intervalId);
            setRenderOpenProgress(target);
        }, durationMs);

        return () => {
            clearInterval(intervalId);
            clearTimeout(timeoutId);
        };
    }, [openProgress, props.expanded, reduceMotion, setRenderOpenProgress]);

    const animatedStyle = useAnimatedStyle(() => {
        if (edgeAnchored) {
            return {
                opacity: visibilityProgress.value,
            };
        }

        const translateYOffset = props.expanded ? 5 : 4;
        const initialScale = props.expanded ? 0.992 : 0.994;

        return {
            opacity: visibilityProgress.value,
            transform: [
                { translateY: translateYOffset * (1 - visibilityProgress.value) },
                { scale: initialScale + ((1 - initialScale) * visibilityProgress.value) },
            ],
        };
    });

    return (
        <DesktopActivityOverlayMotionProgressContext.Provider value={openProgressValue}>
            <Animated.View
                style={[
                    styles.frame,
                    animatedStyle,
                ]}
            >
                {props.children}
            </Animated.View>
        </DesktopActivityOverlayMotionProgressContext.Provider>
    );
}

const styles = StyleSheet.create({
    frame: {
        flex: 1,
        alignSelf: 'stretch',
        width: '100%',
    },
});
