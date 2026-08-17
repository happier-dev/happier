/**
 * RUX-14 — animate the popover container height during step transitions.
 *
 * Problem: SlideTransitionSwitch keeps both the OUTGOING and INCOMING step
 * layers mounted while the spring runs, with the incoming layer ABSOLUTELY
 * positioned over the current layer. The container's natural height during a
 * transition is therefore the OUTGOING layer's height (the absolute layer
 * doesn't contribute). When the spring settles and the outgoing layer
 * unmounts, the container snaps to the incoming layer's height — visually a
 * hard jump at the END of an otherwise smooth slide.
 *
 * Fix: this component wraps any keyed `children` in an Animated.View and
 * animates its height toward the INCOMING step's natural height, which the
 * orchestrator supplies through `measuredContentHeight`. The visible
 * wrapper's own onLayout reports the actual rendered/clamped height, used as
 * the "from" snapshot before each transition AND as the upper bound on the
 * animation target so it never overshoots what the popover surface would
 * actually paint.
 *
 * R1 — this component does NOT measure. It used to render its own hidden
 * mirror of the incoming body to read that natural height, while
 * `SelectionList` rendered a second hidden mirror of the SAME subtree for
 * `useSelectionListMeasuredPopoverHeight`. Two owners of one question meant
 * every row of the list mounted THREE times per open on the native popover
 * path (two of them invisible) — all of it in front of the user, because the
 * container stays `opacity: 0` until the first measurement lands. The
 * measurement now has a single owner (`SelectionList`'s measure host) and is
 * passed here as a number.
 *
 * When `stepKey` changes:
 *
 *  1. Snapshot the just-prior wrapper-rendered height as the "from" value.
 *  2. Pin the container's height to that "from" value (a number).
 *  3. Once a NEW `measuredContentHeight` arrives for the incoming step,
 *     animate via `withTiming` to the (clamped) target, using a duration
 *     tuned to feel synchronized with the SlideTransitionSwitch
 *     compact-preset spring.
 *  4. On animation completion, flip the React-side `pinned` flag back off so
 *     the container's height returns to `auto` — subsequent natural layout
 *     reflows (e.g. dynamic-section row count changes) flow without being
 *     constrained by a stale numeric height.
 *
 * Reduced motion: skip the timing animation; snap directly to incoming.
 *
 * Interrupt safety: when a second stepKey change arrives mid-animation, the
 * effect re-pins from the latest measured height and re-runs `withTiming` to
 * the new target. The previous animation's settle callback is gated on a
 * generation counter so a stale callback can never release the pin
 * prematurely while a fresh animation is in flight.
 *
 * Why can't we measure the visible `children`? They are wrapped in a
 * SlideTransitionSwitch which keeps both layers mounted during the swap, with
 * the incoming layer absolutely positioned — that container's natural height
 * tracks the OUTGOING content, not the incoming. The destination height can
 * only be read from a subtree that renders the incoming body at its natural
 * size, which is exactly what the orchestrator's offscreen measure host does.
 *
 * Why clamp the incoming height to the wrapper's last-measured height? Long
 * step bodies (e.g. a 100-row path picker) have a NATURAL height that vastly
 * exceeds the popover surface's `maxHeight`. Animating to that natural
 * height would balloon the popover well past its cap. Clamping to the
 * wrapper's most recent settled height keeps targets within the range the
 * popover surface will actually paint. The clamp is an UPPER bound — when
 * the incoming step is shorter than the cap, the smaller natural height is
 * used verbatim (that's the case the user reported: 480 → 280).
 */

import * as React from 'react';
import { type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
    cancelAnimation,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
    type WithTimingConfig,
} from 'react-native-reanimated';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * Duration tuned to feel locked-in with the SlideTransitionSwitch `compact`
 * preset spring (`damping: 24, stiffness: 220, mass: 0.7`). The spring takes
 * ~220ms to look settled visually; matching the height timing keeps the
 * outer container shrinking/growing in the SAME time window the inner
 * content is sliding.
 */
const HEIGHT_ANIMATION_DURATION_MS = 220;

const TIMING_CONFIG: WithTimingConfig = {
    duration: HEIGHT_ANIMATION_DURATION_MS,
};

/**
 * Buffer between the height-animation completion and the pin release.
 * Tuned to cover the SlideTransitionSwitch compact-preset spring's settle
 * time PLUS one or two extra frames so any popover-surface measurement
 * polling lands on the new (smaller) natural height before we hand control
 * back to flex distribution.
 */
const RELEASE_BUFFER_MS = 280;

export type SelectionListAnimatedHeightProps = Readonly<{
    /**
     * Identifier for the visible "step" — when this changes, the wrapper
     * pins height and runs a height animation in parallel with whatever
     * inner slide animation `children` renders.
     */
    stepKey: string | number;
    /**
     * Visible content (typically a SlideTransitionSwitch wrapping the step
     * body). This is what users see; we never measure it directly because
     * the SlideTransitionSwitch's container tracks the OUTGOING layer's
     * height during transitions.
     */
    children: React.ReactNode;
    /**
     * The natural height of the body for the step identified by `stepKey`,
     * measured by the single measurement owner (`SelectionList`'s offscreen
     * measure host).
     *
     * `undefined` means "not measured for THIS step yet" — the owner
     * withholds a height it took for a different step rather than letting a
     * transition resolve against the step it is leaving.
     *
     * A number rather than a subtree: this component does not own a measure
     * host, because `SelectionList` already renders one for
     * `useSelectionListMeasuredPopoverHeight` over the SAME body, and a
     * second mirror is a second mount of every row (see the R1 note in the
     * file header).
     */
    measuredContentHeight?: number;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    /** Override; defaults via `useReducedMotionPreference()`. */
    reducedMotion?: boolean;
}>;

export function SelectionListAnimatedHeight(
    props: SelectionListAnimatedHeightProps,
): React.ReactElement {
    const detectedReducedMotion = useReducedMotionPreference();
    const reducedMotion = props.reducedMotion ?? detectedReducedMotion;

    const animatedHeight = useSharedValue<number>(0);
    /**
     * Tracks the wrapper's most recent rendered height (when not pinned).
     * This is the value used both as the "from" snapshot when a transition
     * starts AND as the upper bound on the animation target so it never
     * exceeds the visible cap.
     */
    const lastWrapperHeightRef = React.useRef<number>(0);
    const pendingTargetHeightRef = React.useRef<number | null>(null);
    const lastStepKeyRef = React.useRef<string | number>(props.stepKey);
    /**
     * Generation counter — only the LATEST animation's settle callback may
     * unpin the container. Stale callbacks (from animations interrupted by a
     * newer stepKey change) are dropped.
     */
    const animationGenRef = React.useRef<number>(0);
    const [pinned, setPinned] = React.useState<boolean>(false);

    /**
     * RV-8 / FRESH-2 — unmount safety. The `withTiming` completion callback
     * schedules `runOnJS(scheduleDeferredRelease)`, which then calls
     * `setPinned(false)` after the release buffer. If the wrapper unmounts
     * mid-animation (popover closed, modal dismissed, parent re-rendered the
     * subtree away) the late JS callback would land on an unmounted component
     * and React would log a state-on-unmounted warning. Mirror the
     * SlideTransitionSwitch RV-4 pattern: cancel the in-flight animation in
     * unmount cleanup AND check `isMountedRef.current` before any setState
     * call originating from a Reanimated callback.
     */
    const isMountedRef = React.useRef<boolean>(true);

    const releasePin = React.useCallback((generation: number) => {
        if (!isMountedRef.current) return;
        if (generation !== animationGenRef.current) return;
        setPinned(false);
    }, []);

    const handleWrapperLayout = React.useCallback((event: LayoutChangeEvent) => {
        const measured = event.nativeEvent.layout.height;
        if (measured <= 0) return;
        // Only update the cap when the wrapper is in its natural (unpinned)
        // state — otherwise we'd record a pinned mid-animation height as the
        // cap and freeze the popover at that intermediate value.
        if (pinned) return;
        lastWrapperHeightRef.current = measured;
    }, [pinned]);

    // When stepKey changes: snapshot the prior natural height as the "from"
    // value, pin to it, and clear any pending target. The incoming target is
    // resolved once `measuredContentHeight` carries a measurement for the new
    // key (see the measurement effect below).
    React.useLayoutEffect(() => {
        if (lastStepKeyRef.current === props.stepKey) return;
        lastStepKeyRef.current = props.stepKey;

        const fromHeight = lastWrapperHeightRef.current;
        if (fromHeight <= 0) {
            // Nothing measured yet — no smooth animation to play. Leave the
            // wrapper unpinned so the natural-height path renders.
            return;
        }

        animationGenRef.current += 1;
        animatedHeight.value = fromHeight;
        pendingTargetHeightRef.current = null;
        setPinned(true);
    }, [props.stepKey, animatedHeight]);

    const deferredReleaseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    /**
     * Defer the pin release by `RELEASE_BUFFER_MS` so the SlideTransitionSwitch's
     * own spring (compact-preset, ~250ms settle) AND the popover surface's
     * height measurement both catch up to the new target. Without this buffer
     * the wrapper unpins while the popover surface is still oversized, and
     * `flex: 1` snaps the wrapper back to the surface's stale available
     * space for one frame before the surface itself shrinks.
     */
    const scheduleDeferredRelease = React.useCallback((generation: number) => {
        if (!isMountedRef.current) return;
        if (generation !== animationGenRef.current) return;
        if (deferredReleaseTimerRef.current !== null) {
            clearTimeout(deferredReleaseTimerRef.current);
        }
        deferredReleaseTimerRef.current = setTimeout(() => {
            deferredReleaseTimerRef.current = null;
            releasePin(generation);
        }, RELEASE_BUFFER_MS);
    }, [releasePin]);

    /**
     * RV-8 / FRESH-2 — unmount cleanup. We must:
     *   1. Clear the deferred-release setTimeout so it cannot fire after the
     *      component unmounts (was already in place).
     *   2. Cancel the in-flight `withTiming` on `animatedHeight` so the
     *      Reanimated callback (which calls `runOnJS(scheduleDeferredRelease)`)
     *      does NOT fire post-unmount.
     *   3. Flip `isMountedRef.current = false` so any late JS callback that
     *      slips past the `cancelAnimation` (different threading) becomes a
     *      no-op (`releasePin` / `scheduleDeferredRelease` early-return).
     */
    React.useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            cancelAnimation(animatedHeight);
            if (deferredReleaseTimerRef.current !== null) {
                clearTimeout(deferredReleaseTimerRef.current);
                deferredReleaseTimerRef.current = null;
            }
        };
    }, [animatedHeight]);

    const incomingContentHeight = normalizeContentHeight(props.measuredContentHeight);

    // The measurement for the step now on screen resolves the transition
    // target. It arrives from the orchestrator's single measure host, whose
    // `onLayout` used to be wired directly to a second, locally-owned mirror
    // of the same subtree. The orchestrator publishes `undefined` until the
    // measurement it holds belongs to THIS `stepKey`, so a pin can never
    // resolve against the outgoing step's height.
    React.useEffect(() => {
        if (!pinned) return;
        if (incomingContentHeight === undefined) return;

        // Upper-bound the target by the wrapper's last natural height so a
        // naturally-tall incoming body cannot balloon the popover past what
        // its surface will paint. Before the first wrapper layout there is no
        // bound to apply.
        const cap = lastWrapperHeightRef.current;
        const target = cap > 0 ? Math.min(incomingContentHeight, cap) : incomingContentHeight;

        if (pendingTargetHeightRef.current === target) return;
        pendingTargetHeightRef.current = target;

        if (reducedMotion) {
            animatedHeight.value = target;
            releasePin(animationGenRef.current);
            return;
        }

        const generation = animationGenRef.current;
        animatedHeight.value = withTiming(target, TIMING_CONFIG, (finished) => {
            'worklet';
            if (!finished) return;
            // Defer the unpin until the SlideTransitionSwitch's own
            // spring + popover-surface measurement catch up to our
            // pinned target. Without the buffer, the wrapper unpins
            // while the popover surface is still oversized — `flex: 1`
            // immediately re-stretches the wrapper to the surface's
            // current available space, producing a one-frame jump UP
            // before the surface eventually shrinks (a visible bounce).
            // The buffer keeps the pin held for the full slide-spring
            // duration; by then both the SlideTransitionSwitch's layer
            // commit AND the popover surface's natural-height
            // measurement have caught up to the new step body's
            // natural height, so unpinning is a no-op visually.
            runOnJS(scheduleDeferredRelease)(generation);
        });
    }, [
        animatedHeight,
        incomingContentHeight,
        pinned,
        reducedMotion,
        releasePin,
        scheduleDeferredRelease,
    ]);

    const animatedStyle = useAnimatedStyle(() => {
        if (!pinned) return {};
        return { height: animatedHeight.value };
    }, [pinned]);

    // When pinned, also flatten flex grow/shrink so the explicit height is
    // not overridden by the parent's flex space distribution (see comment on
    // `pinnedFlexOverride`).
    const pinnedOverrideStyle: ViewStyle | undefined = pinned ? pinnedFlexOverride : undefined;

    return (
        <Animated.View
            testID={props.testID}
            onLayout={handleWrapperLayout}
            style={[wrapperBaseStyle, props.style, pinnedOverrideStyle, animatedStyle]}
        >
            {props.children}
        </Animated.View>
    );
}

function normalizeContentHeight(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    return value;
}

/**
 * The wrapper participates in the flex chain (`flex: 1` + `minHeight: 0`)
 * during natural layout so the inner SlideTransitionFrame's `flex: 1` is
 * bounded by the popover surface's `maxHeight`. When the wrapper is pinned
 * (mid-transition), the animated `height` style is paired with
 * `flexBasis: 'auto'` and `flexGrow/flexShrink: 0` (via `pinnedFlexOverride`
 * below) so the explicit height isn't overridden by flex distribution.
 * Without that override the inline `height: <pinned>px` would be ignored on
 * web because `flex: 1 1 0%` forces flex-basis to 0 and the flex container
 * distributes the SAME available space regardless of the explicit height.
 */
const wrapperBaseStyle: ViewStyle = {
    flex: 1,
    minHeight: 0,
    flexDirection: 'column',
    position: 'relative',
};

const pinnedFlexOverride: ViewStyle = {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
};
