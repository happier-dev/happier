/**
 * Discrete adapter for the unified slide transition primitives.
 *
 * Drives `SlideTransitionFrame` from a `contentKey`. When the key changes, snapshots
 * the previously-rendered children as the OUTGOING layer and renders the new children
 * as the INCOMING (`next` for forward, `previous` for backward) layer; the spring
 * animates `progress` from 0 to ±1 and on settle commits the new key + children to the
 * `current` slot.
 *
 * State machine rules — see plan §1572–§1693:
 *   - Sync rule (no transition active): keep `displayedChildren` synchronized with the
 *     latest `children` so the next transition's outgoing snapshot is fresh. The
 *     rendered `current` slot uses `children` directly while not transitioning so
 *     same-key dynamic updates appear immediately.
 *   - Transition trigger: on `contentKey` mismatch, route through `useLayoutEffect` to
 *     set up the spring before the next paint. Replace direction OR reduced motion
 *     committed synchronously without a spring.
 *   - Interrupt rule: a new key arriving mid-flight cancels the current spring and
 *     snap-commits to its intended target; the next render naturally re-enters and
 *     starts a fresh spring for the latest key.
 *   - Incoming-update rule: same-key children updates while a spring is in flight
 *     refresh the in-flight target without cancelling the spring.
 *   - No React nodes through `runOnJS` — they live on the JS side in `inFlightTargetRef`.
 */

import * as React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import {
    cancelAnimation,
    runOnJS,
    useSharedValue,
    withSpring,
} from 'react-native-reanimated';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { SlideTransitionFrame } from './SlideTransitionFrame';
import { slideTransitionTokens, type SlideTransitionPreset } from './slideTransitionTokens';
import type { SlideTransitionDirection, SlideTransitionSwitchProps } from './_types';

type InFlightTarget = Readonly<{
    children: React.ReactNode;
    key: string | number;
    direction: SlideTransitionDirection;
}>;

export function SlideTransitionSwitch(props: SlideTransitionSwitchProps): React.ReactElement {
    const preferredReducedMotion = useReducedMotionPreference();
    const effectiveReducedMotion = props.reducedMotion ?? preferredReducedMotion;
    const resolvedPreset: SlideTransitionPreset = props.preset ?? 'compact';
    const resolvedBlur = props.blur ?? false;
    const presetTokens = slideTransitionTokens[resolvedPreset];

    const [displayedChildren, setDisplayedChildren] = React.useState<React.ReactNode>(props.children);
    const [displayedKey, setDisplayedKey] = React.useState<string | number>(props.contentKey);
    const [activeDirection, setActiveDirection] = React.useState<SlideTransitionDirection>(props.direction);
    const progress = useSharedValue(0);
    const inFlightTargetRef = React.useRef<InFlightTarget | null>(null);

    // F13.2 — unmount cancellation. The spring callback uses runOnJS to call
    // commitInFlightTarget which performs setState on this component. If we
    // unmount mid-transition (modal dismissed, popover closed) the callback
    // can still fire later; cancelling the spring on unmount stops the
    // callback fast-path and the mounted ref makes the late JS callback a
    // no-op so React never sees a setState on an unmounted component.
    const isMountedRef = React.useRef<boolean>(true);
    React.useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            cancelAnimation(progress);
        };
    }, [progress]);

    const isTransitioning = displayedKey !== props.contentKey;

    const commitDisplayed = React.useCallback(
        (nextChildren: React.ReactNode, nextKey: string | number) => {
            setDisplayedChildren(() => nextChildren);
            setDisplayedKey(nextKey);
            inFlightTargetRef.current = null;
        },
        [],
    );

    const commitInFlightTarget = React.useCallback(() => {
        // F13.2 — late spring callback after unmount: do nothing. Without this
        // guard `commitDisplayed` would call `setDisplayedChildren` /
        // `setDisplayedKey` on an unmounted component and React would log a
        // state-on-unmounted warning.
        if (!isMountedRef.current) return;
        const target = inFlightTargetRef.current;
        if (target == null) return;
        commitDisplayed(target.children, target.key);
    }, [commitDisplayed]);

    // SYNC RULE: while not transitioning, keep `displayedChildren` ready for the
    // NEXT transition's outgoing snapshot. The render path uses plain `children`
    // for the current slot when not transitioning, so same-key dynamic updates
    // appear without a frame lag.
    React.useEffect(() => {
        if (isTransitioning) return;
        if (inFlightTargetRef.current !== null) return;
        setDisplayedChildren(() => props.children);
    }, [props.children, isTransitioning]);

    // NO-FLASH INVARIANT: after the spring callback commits the new
    // `displayedKey` on the JS thread, React paints the new committed tree.
    // Only THEN (in this layout effect, which runs after the paint commit
    // for `displayedKey`) is it safe to snap `progress.value = 0`. Resetting
    // from inside the spring worklet would land before React paints and
    // flash stale content at the centered position for one frame.
    React.useLayoutEffect(() => {
        if (isTransitioning) return;
        progress.value = 0;
    }, [displayedKey, isTransitioning, progress]);

    // TRANSITION TRIGGER + INTERRUPT + INCOMING-UPDATE RULES.
    // useLayoutEffect avoids a painted frame with mismatched layers before the
    // spring/cancel/instant-commit logic runs.
    React.useLayoutEffect(() => {
        if (displayedKey === props.contentKey) return;

        // Replace OR reduced-motion: instant commit, no spring, single layer.
        if (props.direction === 'replace' || effectiveReducedMotion) {
            if (inFlightTargetRef.current !== null) {
                cancelAnimation(progress);
            }
            commitDisplayed(props.children, props.contentKey);
            progress.value = 0;
            return;
        }

        // Incoming-update rule: same target key in flight with new children -> refresh
        // the target ref and let the existing spring continue.
        if (inFlightTargetRef.current?.key === props.contentKey) {
            inFlightTargetRef.current = {
                children: props.children,
                key: props.contentKey,
                direction: inFlightTargetRef.current.direction,
            };
            return;
        }

        // Interrupt rule: a different key was already in flight; snap-commit it and
        // re-enter on the next render to start a fresh spring for the new key.
        if (inFlightTargetRef.current !== null) {
            cancelAnimation(progress);
            const target = inFlightTargetRef.current;
            commitDisplayed(target.children, target.key);
            progress.value = 0;
            return;
        }

        // Fresh transition.
        setActiveDirection(props.direction);
        inFlightTargetRef.current = {
            children: props.children,
            key: props.contentKey,
            direction: props.direction,
        };
        const target = props.direction === 'forward' ? -1 : +1;
        progress.value = withSpring(target, presetTokens.spring, (finished) => {
            'worklet';
            if (!finished) return;
            // React nodes live in inFlightTargetRef; the JS callback reads them there.
            // IMPORTANT: do NOT reset `progress.value = 0` from inside this worklet.
            // `runOnJS` is async — resetting progress here can land BEFORE React
            // commits the new displayedKey, flashing stale content for one frame.
            // The reset is the JS side's job, in a useLayoutEffect keyed on the
            // committed `displayedKey` (runs AFTER React paints the new tree).
            runOnJS(commitInFlightTarget)();
        });
    }, [
        props.contentKey,
        props.direction,
        props.children,
        displayedKey,
        effectiveReducedMotion,
        commitDisplayed,
        commitInFlightTarget,
        presetTokens.spring,
        progress,
    ]);

    const containerStyle: StyleProp<ViewStyle> | undefined = props.style;
    const currentSlot = isTransitioning ? displayedChildren : props.children;
    const incomingSlotForward = isTransitioning && activeDirection === 'forward' ? props.children : undefined;
    const incomingSlotBackward = isTransitioning && activeDirection === 'backward' ? props.children : undefined;

    return (
        <SlideTransitionFrame
            current={currentSlot}
            next={incomingSlotForward}
            previous={incomingSlotBackward}
            progress={progress}
            blur={resolvedBlur}
            preset={resolvedPreset}
            reducedMotion={effectiveReducedMotion}
            style={containerStyle}
            testID={props.testID}
        />
    );
}
