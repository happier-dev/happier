import * as React from 'react';
import { Platform } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useSessionSwitcherState } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

import { resolveSessionSwitcherContentMotion } from './sessionSwitcherMotion';

/**
 * How the session answers the switcher: it steps back while the switcher is open.
 *
 * One container-level transform over the whole cockpit session tree — header, transcript and
 * composer — and nothing below it knows the switcher exists. The subtree is never re-created, so
 * the transcript it wraps survives the gesture; the incoming session cannot be rendered during the
 * drag, so this is a recede, never a pager. The veil itself is the switcher's scrim.
 */

const styles = StyleSheet.create({
    root: {
        flex: 1,
        minHeight: 0,
    },
});

/**
 * Mobile web renders the cockpit too, but the bar's gesture is native-only, so the switcher never
 * opens there. Leave the web session's existing containing-block geometry untouched rather than
 * installing an unused transform for a native-only gesture.
 */
const CAN_RECEDE = Platform.OS !== 'web';
const NO_MOTION = Object.freeze({});

export function SessionSwitcherContent(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    const { open } = useSessionSwitcherState();
    const reducedMotion = useReducedMotionPreference();

    const contentStyle = useAnimatedStyle(() => {
        if (!CAN_RECEDE) return NO_MOTION;
        const motion = resolveSessionSwitcherContentMotion(open.value, reducedMotion);
        return { transform: [{ translateY: motion.translateY }, { scale: motion.scale }] };
    }, [open, reducedMotion]);

    return (
        <Animated.View style={[styles.root, contentStyle]} testID="session-cockpit-swipe-content">
            {props.children}
        </Animated.View>
    );
}
