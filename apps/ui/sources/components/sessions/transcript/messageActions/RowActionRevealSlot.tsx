import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { MOTION_STANDARD_BEZIER, motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

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

const WEB_REVEAL_TRANSITION_STYLE = {
    transitionProperty: 'opacity',
    transitionDuration: `${motionTokens.durationMs.fast}ms`,
    transitionTimingFunction: `cubic-bezier(${MOTION_STANDARD_BEZIER.join(', ')})`,
} as unknown as ViewStyle;

const WEB_REVEAL_REDUCED_MOTION_STYLE = {
    transitionDuration: '0ms',
} as unknown as ViewStyle;

/**
 * The fade is a CSS transition: `Animated` on web runs on the JS driver, one timing per slot of every
 * mounted row (on mount too, towards the value it already held), re-rendering each through React per
 * frame while a session switch was waiting on the same thread (issue #864).
 */
function RowActionRevealSlotAnimated(props: RowActionRevealSlotProps): React.ReactElement {
    const { revealed, onFocus, onBlur } = useRowActionRevealFocus(props);
    const reducedMotion = useReducedMotionPreference();
    const pointerEvents = revealed ? ('auto' as const) : ('none' as const);
    // Latched so the icons stay through the fade-out instead of vanishing as it starts.
    const [iconsMounted, setIconsMounted] = React.useState(revealed);
    if (revealed && !iconsMounted) setIconsMounted(true);

    return (
        <View
            testID={props.testID}
            onFocus={onFocus}
            onBlur={onBlur}
            style={[
                styles.slot,
                props.reserveWidth != null ? { width: props.reserveWidth } : null,
                props.style,
                { pointerEvents },
                WEB_REVEAL_TRANSITION_STYLE,
                reducedMotion ? WEB_REVEAL_REDUCED_MOTION_STYLE : null,
                { opacity: revealed ? 1 : 0 },
            ]}
        >
            <RowActionIconsMountedContext.Provider value={iconsMounted}>
                {props.children}
            </RowActionIconsMountedContext.Provider>
        </View>
    );
}

const RowActionIconsMountedContext = React.createContext(true);

/**
 * An action's icon, mounted once its slot has been revealed. The action itself stays mounted, labelled
 * and focusable while hidden (the slot's contract); only the pixels nobody can see yet wait, in a box
 * of the icon's size so revealing never shifts the row. The icons were 44 of a message row's ~160
 * fibers on every row of every session switch (issue #864).
 */
export function RowActionDeferredIcon(props: Readonly<{ size: number; children: React.ReactNode }>): React.ReactElement {
    const iconsMounted = React.useContext(RowActionIconsMountedContext);
    if (iconsMounted) return <>{props.children}</>;
    return <View testID="row-action-deferred-icon" style={{ width: props.size, height: props.size }} />;
}

const styles = StyleSheet.create(() => ({
    slot: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
    },
}));
