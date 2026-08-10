import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withSpring,
    withTiming,
} from 'react-native-reanimated';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { describeMotionSpring, resolveMotionReducedFallback, resolveMotionSpring } from './motionSprings';
import { reanimatedMotionTokens } from './reanimatedMotionTokens';

/**
 * One mark resolving into another inside a box that never changes size.
 *
 * This is the settle behind "a spinner became a tick": a **two-layer cross-fade**, never a morph
 * and never a colour interpolation. The outgoing mark fades out where it stands while the incoming
 * one fades up and grows into place, and the row around them does not move a pixel — which is what
 * makes the moment readable in a list where several agents may finish at once.
 *
 * The component knows nothing about statuses, glyphs or tone. It takes rendered children and a key
 * that says "this is a different mark now". That is deliberate: the glyph table has exactly one
 * owner (`AgentActivityStatusSlot`), and a transition primitive that knew glyph names would be a
 * second one.
 */

const EXIT_FADE_MS = 110;
const ENTER_DELAY_MS = 40;
const ENTER_FADE_MS = 130;

/**
 * The settle is not a chosen duration: it is how long the `statusSettle` spring takes to land,
 * offset by the incoming layer's delay. Retuning the spring moves the timeline with it.
 */
const SETTLE_MS = Math.round(describeMotionSpring('statusSettle').settleMs);

export const STATUS_TRANSITION_TIMELINE = {
    /** Outgoing mark: opacity 1 -> 0, starting immediately. */
    exitFadeMs: EXIT_FADE_MS,
    /** Incoming mark waits this long, so the two are never both at full strength. */
    enterDelayMs: ENTER_DELAY_MS,
    /** Incoming mark: opacity 0 -> 1 once the delay is up. */
    enterFadeMs: ENTER_FADE_MS,
    /** When the outgoing layer is retired and the incoming one has settled. */
    totalMs: ENTER_DELAY_MS + SETTLE_MS,
} as const;

export type StatusTransitionProps = Readonly<{
    /** Changing this is what starts a transition. Same key in, no motion. */
    transitionKey: string;
    /** Side of the fixed box, in px. Both layers stack inside it, so nothing around it can move. */
    size: number;
    /**
     * Scale the incoming layer starts at.
     *
     * For an icon/spinner swap this is `ICON_CIRCLE_INK_RATIO` (`ActivitySpinner.tsx`): the glyph
     * starts at the uncorrected ink size and grows into the corrected one, so the growth is the
     * size correction becoming true rather than an invented flourish. Required rather than
     * defaulted — a caller that has not thought about it should not get a magic number.
     */
    fromScale: number;
    children: React.ReactNode;
    /** Overrides the preference store, matching the slide-transition primitives' contract. */
    reducedMotion?: boolean;
    testID?: string;
}>;

type OutgoingLayer = Readonly<{ key: string; node: React.ReactNode }>;

const stylesheet = StyleSheet.create({
    box: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    layer: {
        // Written out rather than spread from `StyleSheet.absoluteFillObject` because the stacking
        // IS the contract here: two marks occupying the same square is what keeps the transition
        // from resizing the row, and it should be visible at the place it is relied upon.
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
});

export function StatusTransition(props: StatusTransitionProps): React.ReactElement {
    const preferredReducedMotion = useReducedMotionPreference();
    const reducedMotion = props.reducedMotion ?? preferredReducedMotion;

    const [outgoing, setOutgoing] = React.useState<OutgoingLayer | null>(null);

    // The previous commit's key and children. A layout effect reads these before the passive effect
    // below overwrites them, which is how the outgoing mark is captured without keeping a second
    // copy of the current one in state.
    const lastKeyRef = React.useRef<string>(props.transitionKey);
    const lastChildrenRef = React.useRef<React.ReactNode>(props.children);
    const retireTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const exitOpacity = useSharedValue(1);
    const enterOpacity = useSharedValue(1);
    const enterScale = useSharedValue(1);

    const outgoingStyle = useAnimatedStyle(() => ({ opacity: exitOpacity.value }));
    const incomingStyle = useAnimatedStyle(() => ({
        opacity: enterOpacity.value,
        transform: [{ scale: enterScale.value }],
    }));

    React.useEffect(() => {
        lastKeyRef.current = props.transitionKey;
        lastChildrenRef.current = props.children;
    });

    React.useEffect(
        () => () => {
            if (retireTimerRef.current != null) clearTimeout(retireTimerRef.current);
        },
        [],
    );

    React.useLayoutEffect(() => {
        const previousKey = lastKeyRef.current;
        if (previousKey === props.transitionKey) return;
        const previousNode = lastChildrenRef.current;

        if (retireTimerRef.current != null) {
            clearTimeout(retireTimerRef.current);
            retireTimerRef.current = null;
        }

        // The fallback is read from the role table rather than decided here, so this component
        // cannot drift away from the rest of the vocabulary. `statusSettle` maps to `'instant'`.
        const suppressed = reducedMotion && resolveMotionReducedFallback('statusSettle') === 'instant';

        if (suppressed) {
            // The mark still changes — only its travel is removed. The elapsed clock beside it keeps
            // running, so the row has not gone quiet.
            exitOpacity.value = 1;
            enterOpacity.value = 1;
            enterScale.value = 1;
            setOutgoing(null);
            return;
        }

        setOutgoing({ key: previousKey, node: previousNode });

        exitOpacity.value = 1;
        exitOpacity.value = withTiming(0, {
            duration: EXIT_FADE_MS,
            easing: reanimatedMotionTokens.easing.standard,
        });

        enterOpacity.value = 0;
        enterOpacity.value = withDelay(
            ENTER_DELAY_MS,
            withTiming(1, { duration: ENTER_FADE_MS, easing: reanimatedMotionTokens.easing.standard }),
        );

        enterScale.value = props.fromScale;
        enterScale.value = withDelay(
            ENTER_DELAY_MS,
            withSpring(1, resolveMotionSpring('statusSettle', { reducedMotion })),
        );

        retireTimerRef.current = setTimeout(() => {
            retireTimerRef.current = null;
            setOutgoing(null);
        }, STATUS_TRANSITION_TIMELINE.totalMs);
    }, [props.transitionKey, props.fromScale, reducedMotion, exitOpacity, enterOpacity, enterScale]);

    return (
        <View
            testID={props.testID}
            pointerEvents="box-none"
            style={[stylesheet.box, { width: props.size, height: props.size }]}
        >
            {outgoing != null ? (
                <Animated.View
                    key={outgoing.key}
                    pointerEvents="none"
                    // The retiring mark is no longer true, so assistive tech must not reach it —
                    // otherwise a settling row announces its old status and its new one together.
                    // Web honours `aria-hidden`, iOS `accessibilityElementsHidden`, Android
                    // `importantForAccessibility`; RN ignores the ones a platform does not know.
                    aria-hidden={true}
                    accessibilityElementsHidden={true}
                    importantForAccessibility="no-hide-descendants"
                    style={[stylesheet.layer, outgoingStyle]}
                    testID={props.testID != null ? `${props.testID}-outgoing` : undefined}
                >
                    {outgoing.node}
                </Animated.View>
            ) : null}
            <Animated.View
                pointerEvents="box-none"
                style={[stylesheet.layer, incomingStyle]}
                testID={props.testID != null ? `${props.testID}-incoming` : undefined}
            >
                {props.children}
            </Animated.View>
        </View>
    );
}
