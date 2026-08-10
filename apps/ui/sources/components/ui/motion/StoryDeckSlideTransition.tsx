/**
 * Carousel adapter for the unified slide transition primitives.
 *
 * Owns the pan gesture, the `progress: SharedValue<number>`, and the spring driver
 * for both gesture-release commits AND Continue/Back button-driven commits. Both
 * trigger the same animation pipeline so the user sees identical motion regardless
 * of input source.
 *
 * Bounds are first-class:
 *   - At first card (`activeIndex === 0`): right-drag toward previous clamped to 0.
 *   - At last card (`activeIndex === itemCount - 1`): left-drag toward next clamped to 0.
 * The frame never fades toward an undefined `previous`/`next` slot.
 *
 * Spring config comes from the shared `slideTransitionTokens` preset (`'soft'` by
 * default for the StoryDeck premium feel). Stable identity via the token lookup —
 * no inline allocations.
 */

import * as React from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
    cancelAnimation,
    runOnJS,
    useSharedValue,
    withSpring,
} from 'react-native-reanimated';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { SlideTransitionFrame } from './SlideTransitionFrame';
import { resolveSlideTransitionSpring, type SlideTransitionPreset } from './slideTransitionTokens';
import type { StoryDeckSlideTransitionProps } from './_types';

const DEFAULT_GESTURE_THRESHOLD_RATIO = 0.4;
const FALLBACK_PAGE_WIDTH = 1; // avoid divide-by-zero before first layout
// Pan-gesture activation bounds: the swipe activates only after a clear
// horizontal intent (>= 10px), and FAILS on a vertical drag (>= 10px) so
// nested vertical gesture systems (sheets, scrollviews) own that interaction.
const HORIZONTAL_ACTIVATION_OFFSET_PX = 10;
const VERTICAL_FAILURE_OFFSET_PX = 10;

/**
 * Imperative handle exposed via `React.forwardRef`. Continue/Back buttons (or any
 * caller) can call these to drive the SAME spring as a swipe-release commit, so
 * the visual outcome is identical regardless of input source.
 */
export type StoryDeckSlideTransitionHandle = Readonly<{
    commitNext: () => void;
    commitPrevious: () => void;
}>;

const stylesheet = StyleSheet.create({
    root: {
        flex: 1,
        minHeight: 0,
    },
    detector: {
        flex: 1,
        minHeight: 0,
    },
});

export const StoryDeckSlideTransition = React.forwardRef<
    StoryDeckSlideTransitionHandle,
    StoryDeckSlideTransitionProps
>(function StoryDeckSlideTransition(props, ref): React.ReactElement {
    const preferredReducedMotion = useReducedMotionPreference();
    const effectiveReducedMotion = props.reducedMotion ?? preferredReducedMotion;
    const resolvedPreset: SlideTransitionPreset = props.preset ?? 'soft';
    const resolvedBlur = props.blur ?? true;
    const thresholdRatio = props.gestureThresholdRatio ?? DEFAULT_GESTURE_THRESHOLD_RATIO;
    const spring = resolveSlideTransitionSpring(resolvedPreset, { reducedMotion: effectiveReducedMotion });

    const progress = useSharedValue(0);
    const pageWidth = useSharedValue(FALLBACK_PAGE_WIDTH);
    const canGoPreviousSV = useSharedValue(props.activeIndex > 0);
    const canGoNextSV = useSharedValue(props.activeIndex < props.itemCount - 1);
    const thresholdRatioSV = useSharedValue(thresholdRatio);

    // F13.1 — single-flight guard. While a commit spring is in flight we
    // ignore re-entrant commit requests (gesture release + imperative call +
    // rapid button taps). We use a SharedValue as the single source of truth
    // — both the worklet (`onEnd`) and JS-side imperative handle can read /
    // write `.value` consistently, so the gesture and the buttons cannot
    // race against each other and double-commit.
    const isInFlightSV = useSharedValue<boolean>(false);

    // F13.2 — unmount cancellation. Cancel the in-flight spring on unmount
    // and ensure any late `runOnJS(...)` callback that still fires after the
    // unmount becomes a no-op (no parent commit, no React state warnings).
    const isMountedRef = React.useRef<boolean>(true);
    React.useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            cancelAnimation(progress);
        };
    }, [progress]);

    React.useEffect(() => {
        canGoPreviousSV.value = props.activeIndex > 0;
        canGoNextSV.value = props.activeIndex < props.itemCount - 1;
    }, [props.activeIndex, props.itemCount, canGoPreviousSV, canGoNextSV]);

    React.useEffect(() => {
        thresholdRatioSV.value = thresholdRatio;
    }, [thresholdRatio, thresholdRatioSV]);

    // NO-FLASH INVARIANT: when activeIndex changes (committed by the parent
    // after a swipe / imperative call), React paints the new tree. Only THEN
    // is it safe to snap `progress.value = 0`. Resetting from inside the
    // spring worklet would land before React paints and flash stale content.
    React.useLayoutEffect(() => {
        progress.value = 0;
    }, [props.activeIndex, progress]);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const w = event.nativeEvent.layout.width;
        if (w > 0) pageWidth.value = w;
    }, [pageWidth]);

    const onCommitNext = props.onCommitNext;
    const onCommitPrevious = props.onCommitPrevious;

    // JS-side safe shims invoked via runOnJS from the spring callback. They
    // (a) clear the in-flight flag BEFORE calling the parent commit handler so
    // a follow-up tap can start a fresh spring as soon as the parent's
    // setState commits, and (b) no-op if the component has unmounted between
    // spring start and callback fire (F13.2).
    const clearInFlight = React.useCallback(() => {
        isInFlightSV.value = false;
    }, [isInFlightSV]);
    const safeCommitNext = React.useCallback(() => {
        clearInFlight();
        if (!isMountedRef.current) return;
        onCommitNext();
    }, [clearInFlight, onCommitNext]);
    const safeCommitPrevious = React.useCallback(() => {
        clearInFlight();
        if (!isMountedRef.current) return;
        onCommitPrevious();
    }, [clearInFlight, onCommitPrevious]);

    const gesture = React.useMemo(() => {
        return Gesture.Pan()
            // Activate only on clear horizontal intent. Vertical drags (e.g.
            // dismissing a sheet, scrolling content) must propagate to the
            // nested gesture system instead of firing a horizontal swipe.
            .activeOffsetX([-HORIZONTAL_ACTIVATION_OFFSET_PX, HORIZONTAL_ACTIVATION_OFFSET_PX])
            .failOffsetY([-VERTICAL_FAILURE_OFFSET_PX, VERTICAL_FAILURE_OFFSET_PX])
            .onUpdate((event: { translationX?: number }) => {
                'worklet';
                if (effectiveReducedMotion) return;
                if (isInFlightSV.value) return;
                const tx = typeof event.translationX === 'number' ? event.translationX : 0;
                const raw = tx / pageWidth.value;
                const clamped = raw > 1 ? 1 : raw < -1 ? -1 : raw;
                let bounded = clamped;
                if (bounded > 0 && !canGoPreviousSV.value) bounded = 0;
                if (bounded < 0 && !canGoNextSV.value) bounded = 0;
                progress.value = bounded;
            })
            .onEnd((event: { translationX?: number }) => {
                'worklet';
                const tx = typeof event.translationX === 'number' ? event.translationX : 0;
                const raw = tx / pageWidth.value;
                const clamped = raw > 1 ? 1 : raw < -1 ? -1 : raw;
                let bounded = clamped;
                if (bounded > 0 && !canGoPreviousSV.value) bounded = 0;
                if (bounded < 0 && !canGoNextSV.value) bounded = 0;

                const absBounded = bounded < 0 ? -bounded : bounded;
                const passedThreshold = absBounded >= thresholdRatioSV.value;

                // Reduced motion: snap-commit (no animation) but STILL advance.
                // Otherwise users with reduced motion enabled lose all swipe
                // navigation, which is worse than no animation.
                if (effectiveReducedMotion) {
                    if (passedThreshold) {
                        if (bounded > 0) runOnJS(safeCommitPrevious)();
                        else if (bounded < 0) runOnJS(safeCommitNext)();
                    }
                    return;
                }

                // A commit spring is already moving toward previous/next.
                // Ignore every gesture release, including below-threshold
                // snap-backs, so a harmless pan end cannot replace the
                // commit spring with a center snap and strand the guard.
                if (isInFlightSV.value) return;

                const target = passedThreshold
                    ? (bounded > 0 ? 1 : -1)
                    : 0;

                // F13.1 — single-flight: ignore re-entrant commits while a
                // spring is already animating a commit.
                if (target !== 0) {
                    isInFlightSV.value = true;
                }

                progress.value = withSpring(target, spring, (finished) => {
                    'worklet';
                    if (!finished) return;
                    // Do NOT reset progress.value here. The reset belongs to the
                    // JS-side useLayoutEffect keyed on `activeIndex` so it lands
                    // AFTER React paints the new committed tree (otherwise stale
                    // content flashes for one frame at center).
                    if (target > 0) runOnJS(safeCommitPrevious)();
                    else if (target < 0) runOnJS(safeCommitNext)();
                });
            });
    }, [
        effectiveReducedMotion,
        pageWidth,
        canGoPreviousSV,
        canGoNextSV,
        thresholdRatioSV,
        isInFlightSV,
        progress,
        spring,
        safeCommitNext,
        safeCommitPrevious,
    ]);

    // Imperative API for Continue/Back buttons. Drives the SAME spring as the
    // swipe-release commit so the perceived motion is identical regardless of
    // input source. Bounds are honored — calls at first/last card are no-ops.
    React.useImperativeHandle(ref, () => ({
        commitNext: () => {
            if (props.activeIndex >= props.itemCount - 1) return;
            // F13.1 — ignore re-entrant commits while a spring is in flight.
            // The SharedValue is the single source of truth shared with the
            // gesture worklet, so a swipe in flight also blocks an imperative
            // commit (and vice versa).
            if (isInFlightSV.value) return;
            if (effectiveReducedMotion) {
                safeCommitNext();
                return;
            }
            isInFlightSV.value = true;
            progress.value = withSpring(-1, spring, (finished) => {
                'worklet';
                if (!finished) return;
                runOnJS(safeCommitNext)();
            });
        },
        commitPrevious: () => {
            if (props.activeIndex <= 0) return;
            if (isInFlightSV.value) return;
            if (effectiveReducedMotion) {
                safeCommitPrevious();
                return;
            }
            isInFlightSV.value = true;
            progress.value = withSpring(+1, spring, (finished) => {
                'worklet';
                if (!finished) return;
                runOnJS(safeCommitPrevious)();
            });
        },
    }), [
        props.activeIndex,
        props.itemCount,
        effectiveReducedMotion,
        safeCommitNext,
        safeCommitPrevious,
        isInFlightSV,
        progress,
        spring,
    ]);

    const previousNode = props.activeIndex > 0
        ? props.renderItem(props.activeIndex - 1, 'previous')
        : undefined;
    const currentNode = props.renderItem(props.activeIndex, 'current');
    const nextNode = props.activeIndex < props.itemCount - 1
        ? props.renderItem(props.activeIndex + 1, 'next')
        : undefined;

    return (
        <View
            style={[stylesheet.root, props.style]}
            onLayout={handleLayout}
            testID={props.testID ? `${props.testID}-root` : undefined}
        >
            {/*
                GestureDetector's typed props omit `testID`, but the Vitest stub at
                `apps/ui/sources/dev/reactNativeGestureHandlerStub.ts` renders it as a host
                element and surfaces all props (including the gesture chain) to tests. The
                spread below preserves the `testID` for `StoryDeckSlideTransition.gesture.test.tsx`
                and `StoryDeckSurface.test.tsx`'s drag assertion without weakening the
                production typing of `gesture`.
            */}
            <GestureDetector
                gesture={gesture}
                {...(props.testID ? { testID: `${props.testID}-gesture-detector` } as Record<string, string> : {})}
            >
                <View style={stylesheet.detector}>
                    <SlideTransitionFrame
                        previous={previousNode}
                        current={currentNode}
                        next={nextNode}
                        progress={progress}
                        blur={resolvedBlur}
                        preset={resolvedPreset}
                        reducedMotion={effectiveReducedMotion}
                        testID={props.testID}
                    />
                </View>
            </GestureDetector>
        </View>
    );
});
