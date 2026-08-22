import * as React from 'react';
import { Platform } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useSessionLateralSwipe } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

import { resolveSessionLateralSwipeContentMotion } from './sessionLateralSwipeMotion';

/**
 * How the session content answers a lateral swipe.
 *
 * One container-level transform over the whole cockpit session tree — header,
 * transcript and composer — and nothing below it knows the gesture exists. That is
 * the point: the blast radius is this one seam, `SessionView` is untouched, and the
 * subtree is never re-created, so the transcript it wraps survives the gesture.
 *
 * While the finger travels the session RECEDES; on commit the new session mounts
 * while progress is still at its extreme and settles inward, so the ~400-500ms
 * transcript remount every session switch already pays happens behind a deliberate
 * motion instead of in front of a blank screen. Progress is owned by the band's pan
 * (`MobileBottomChromeHost`), including the arrival settle it starts once the
 * destination has painted; this component only reads it.
 *
 * It is NOT a pager: the incoming session cannot be rendered during the drag, and
 * flashing an empty placeholder over hydrated content is exactly what the app's
 * continuity rules forbid.
 */

const styles = StyleSheet.create({
    root: {
        flex: 1,
        minHeight: 0,
    },
});

/**
 * Mobile web renders the cockpit too — a narrow viewport is a "phone" — but the band's
 * pan is native-only, so progress can never move there. Stamping an identity transform
 * anyway is not free on web: it creates a containing block and defeats `backdrop-filter`
 * on every descendant, which would quietly flatten the glass surfaces that live inside
 * the session tree (the jump-to-bottom button, the selection toolbar). Same trap
 * `overlayMotion`'s `disableTransformOnWeb` exists for.
 */
const CAN_RECEDE = Platform.OS !== 'web';
const NO_MOTION = Object.freeze({});

export function SessionLateralSwipeContent(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    const { progress } = useSessionLateralSwipe();
    // Read once on the JS side so the worklet closes over a plain boolean.
    const reducedMotion = useReducedMotionPreference();

    const contentStyle = useAnimatedStyle(() => {
        if (!CAN_RECEDE) return NO_MOTION;
        const motion = resolveSessionLateralSwipeContentMotion({ progress: progress.value, reducedMotion });
        return {
            opacity: motion.opacity,
            transform: [{ translateX: motion.translateX }, { scale: motion.scale }],
        };
    }, [progress, reducedMotion]);

    return (
        <Animated.View style={[styles.root, contentStyle]} testID="session-cockpit-swipe-content">
            {props.children}
        </Animated.View>
    );
}
