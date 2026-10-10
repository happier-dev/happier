import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import type { WidgetLayoutItemV1 } from '@happier-dev/protocol/widgets';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * A layout item that just changed membership in front of the viewer (lab widget-groups, motion notes):
 * `ungrouped` — a widget whose group was dissolved fans out to its own card, in order;
 * `grouped` — cards merged into a new group, which arrives as one card.
 */
export type WidgetGroupMembershipArrival = Readonly<{ kind: 'ungrouped' | 'grouped'; order: number }>;

const NONE: ReadonlyMap<string, WidgetGroupMembershipArrival> = new Map();

/**
 * Which items of `next` arrived by Ungroup or Group with, read from the layout owner's own transition.
 * A first load, a reorder, one widget moving in or out, and items added from Add are not arrivals here.
 */
export function resolveWidgetGroupMembershipArrivals(
    previous: readonly WidgetLayoutItemV1[] | null,
    next: readonly WidgetLayoutItemV1[],
): ReadonlyMap<string, WidgetGroupMembershipArrival> {
    if (!previous || previous === next) return NONE;
    const parentBefore = new Map<string, string | null>();
    for (const item of previous) {
        if (item.kind === 'widget') parentBefore.set(item.instance.id, null);
        else for (const child of item.children) parentBefore.set(child.instance.id, item.id);
    }
    const groupsBefore = new Set(previous.flatMap(item => (item.kind === 'group' ? [item.id] : [])));
    const groupsAfter = new Set(next.flatMap(item => (item.kind === 'group' ? [item.id] : [])));
    const arrivals = new Map<string, WidgetGroupMembershipArrival>();
    const fannedOut = new Map<string, number>();
    for (const item of next) {
        if (item.kind === 'widget') {
            // Its group is gone and it stands on its own: Ungroup (a last child leaving also dissolves its group).
            const parent = parentBefore.get(item.instance.id);
            if (!parent || groupsAfter.has(parent)) continue;
            const order = fannedOut.get(parent) ?? 0;
            fannedOut.set(parent, order + 1);
            arrivals.set(item.instance.id, { kind: 'ungrouped', order });
        } else if (!groupsBefore.has(item.id) && item.children.length > 0
            && item.children.every(child => parentBefore.get(child.instance.id) === null)) {
            // A new group made only of cards that stood on their own: Group with.
            arrivals.set(item.id, { kind: 'grouped', order: 0 });
        }
    }
    return arrivals.size > 0 ? arrivals : NONE;
}

/** The arrivals of the layout transition this host is rendering; empty on first load and once the layout changes again. */
export function useWidgetGroupMembershipArrivals(
    items: readonly WidgetLayoutItemV1[] | null,
): ReadonlyMap<string, WidgetGroupMembershipArrival> {
    const state = React.useRef<Readonly<{ items: readonly WidgetLayoutItemV1[] | null; arrivals: ReadonlyMap<string, WidgetGroupMembershipArrival> }>>({ items, arrivals: NONE });
    if (state.current.items !== items) {
        state.current = { items, arrivals: items ? resolveWidgetGroupMembershipArrivals(state.current.items, items) : NONE };
    }
    return state.current.arrivals;
}

/** Each card of an ungrouped group starts a beat after the one before it, so they read as fanning out. */
const FAN_OUT_STAGGER_MS = motionTokens.durationMs.base / 2;
/** The settle is small: a card keeps its place, only its own edge arrives. */
const FROM_SCALE = motionTokens.overlay.popover.fromScale;

/**
 * Plays an item's membership arrival once, when it mounts with one: its card fades in and settles from a
 * hair smaller (a fanned-out card a beat after its predecessor). Reduced motion: a cross-fade alone.
 * Without an arrival it is a plain wrapper and nothing moves.
 */
export function WidgetGroupMembershipArrivalView(props: Readonly<{
    arrival: WidgetGroupMembershipArrival | undefined;
    style?: StyleProp<ViewStyle>;
    children: React.ReactNode;
}>) {
    const reducedMotion = useReducedMotionPreference();
    // Only the arrival this element mounted with plays; a later one belongs to a later mount.
    const [arrival] = React.useState(props.arrival);
    // Once it has settled the wrapper carries no transform, so it is no stacking context for its card.
    const [settled, setSettled] = React.useState(arrival === undefined);
    const progress = useSharedValue(arrival ? 0 : 1);
    React.useEffect(() => {
        if (!arrival) return;
        const finish = () => setSettled(true);
        const onEnd = (finished?: boolean) => {
            'worklet';
            if (finished) scheduleOnRN(finish);
        };
        progress.value = reducedMotion
            ? withTiming(1, { duration: motionTokens.successMoment.reducedCrossFadeMs }, onEnd)
            : withDelay(arrival.order * FAN_OUT_STAGGER_MS, withTiming(1, {
                duration: reanimatedMotionTokens.durationMs.base, easing: reanimatedMotionTokens.easing.standard }, onEnd));
        return () => cancelAnimation(progress);
    }, [arrival, progress, reducedMotion]);
    const animated = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ scale: reducedMotion ? 1 : FROM_SCALE + (1 - FROM_SCALE) * progress.value }],
    }), [reducedMotion]);
    return <Animated.View style={[props.style, settled ? null : animated]}>{props.children}</Animated.View>;
}
