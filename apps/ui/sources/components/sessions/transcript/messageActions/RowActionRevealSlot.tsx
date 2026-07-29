import * as React from 'react';
import { Animated, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { readReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

export type RowActionRevealSlotProps = Readonly<{
    revealed: boolean;
    reserveWidth?: number;
    style?: StyleProp<ViewStyle>;
    /** Notified when descendant focus enters/leaves, for hosts that mirror it. */
    onFocus?: () => void;
    onBlur?: () => void;
    testID?: string;
    children: React.ReactNode;
}>;

/**
 * The one reveal mechanism for transcript row actions (message pin/copy/fork,
 * tool-row pin, open-details icon).
 *
 * Contract:
 * - the slot reserves its footprint, so revealing never shifts the row;
 * - only opacity animates, so a reveal can never move the transcript;
 * - a hidden slot is not clickable (`pointerEvents: none`), which keeps the
 *   absolutely-positioned action row from swallowing text selection and link
 *   clicks in the corner of every message;
 * - hidden actions stay in the accessibility tree and stay focusable, and the
 *   SLOT reveals itself on descendant focus. Making that the host's job is what
 *   left invisible-but-activatable pins behind on hosts that forgot to wire it;
 *   `onFocus`/`onBlur` are now only a notification for hosts that mirror the
 *   focus into their own hover state.
 */
export function RowActionRevealSlot(props: RowActionRevealSlotProps): React.ReactElement {
    // Platform.OS is fixed for the runtime, so this selects one implementation
    // for the app's lifetime rather than branching on every render.
    return Platform.OS === 'web'
        ? <RowActionRevealSlotAnimated {...props} />
        : <RowActionRevealSlotStatic {...props} />;
}

type RowActionRevealFocus = Readonly<{
    revealed: boolean;
    onFocus: () => void;
    onBlur: () => void;
}>;

function useRowActionRevealFocus(props: RowActionRevealSlotProps): RowActionRevealFocus {
    const [focusWithin, setFocusWithin] = React.useState(false);
    return {
        revealed: props.revealed || focusWithin,
        onFocus: () => {
            setFocusWithin(true);
            props.onFocus?.();
        },
        onBlur: () => {
            setFocusWithin(false);
            props.onBlur?.();
        },
    };
}

/**
 * Off web the visibility policy is constant-true (no hover exists), so the slot
 * is a plain container: no animated value, no timing, no reduced-motion
 * subscription. Multiplied by every row of a virtualized transcript, that
 * machinery was pure overhead.
 */
function RowActionRevealSlotStatic(props: RowActionRevealSlotProps): React.ReactElement {
    const { revealed, onFocus, onBlur } = useRowActionRevealFocus(props);
    return (
        <View
            testID={props.testID}
            onFocus={onFocus}
            onBlur={onBlur}
            pointerEvents={revealed ? 'auto' : 'none'}
            style={[
                styles.slot,
                props.reserveWidth != null ? { width: props.reserveWidth } : null,
                props.style,
                { opacity: revealed ? 1 : 0 },
            ]}
        >
            {props.children}
        </View>
    );
}

/**
 * Web-only fade. Mount cost is the constraint: a virtualized transcript mounts
 * and unmounts these slots by the hundred while scrolling, so a slot subscribes
 * to nothing and animates nothing until an actual reveal happens.
 *
 * The `Animated.View` stays even while the slot is at rest: swapping it for a
 * plain `View` until the first fade would change the element type and remount
 * the actions inside, dropping focus and pressed state mid-hover.
 */
function RowActionRevealSlotAnimated(props: RowActionRevealSlotProps): React.ReactElement {
    const { revealed, onFocus, onBlur } = useRowActionRevealFocus(props);
    const target = revealed ? 1 : 0;
    const opacityRef = React.useRef<Animated.Value | null>(null);
    if (opacityRef.current == null) {
        opacityRef.current = new Animated.Value(target);
    }
    const opacity = opacityRef.current;
    // The mounted value IS the mounted target, so the first commit has nothing to
    // fade between: only a later reveal or hide is a transition.
    const settledTargetRef = React.useRef(target);

    React.useEffect(() => {
        if (settledTargetRef.current === target) return;
        settledTargetRef.current = target;
        // Read the host preference when the reveal starts rather than subscribing
        // to it: the value only matters at this instant, and one media-query
        // listener per mounted slot is what the shared watch exists to avoid.
        if (readReducedMotionPreference()) {
            opacity.setValue(target);
            return;
        }
        const animation = Animated.timing(opacity, {
            toValue: target,
            duration: motionTokens.durationMs.fast,
            easing: motionTokens.easing.standard,
            useNativeDriver: false,
        });
        // Settle on the exact target once the run completes, so a reveal that is
        // interrupted mid-fade cannot leave a half-faded action behind.
        animation.start((result?: { finished?: boolean }) => {
            if (result?.finished !== false) opacity.setValue(target);
        });
        return () => {
            animation.stop();
        };
    }, [opacity, target]);

    return (
        <Animated.View
            testID={props.testID}
            onFocus={onFocus}
            onBlur={onBlur}
            style={[
                styles.slot,
                props.reserveWidth != null ? { width: props.reserveWidth } : null,
                props.style,
                { pointerEvents: revealed ? ('auto' as const) : ('none' as const) },
                { opacity },
            ]}
        >
            {props.children}
        </Animated.View>
    );
}

const styles = StyleSheet.create(() => ({
    slot: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
    },
}));
