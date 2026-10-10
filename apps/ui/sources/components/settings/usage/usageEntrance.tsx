import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withSpring,
    withTiming,
} from 'react-native-reanimated';

import {
    INSTRUMENT_SPRINGS,
    staggerDelayForIndex,
    useMotionPreferences,
} from '@/components/instrument';

/**
 * Entrance-once wrapper for a dashboard section. Composes the kit motion grammar
 * (`useMotionPreferences` chokepoint + `INSTRUMENT_SPRINGS`) — it is an L6-local
 * composition of kit primitives, not a new motion vocabulary.
 *
 * Day-to-day rule: the section fades/travels in ONCE, then is fully static. On a
 * revisit (remount) it does NOT replay — a module-level per-id guard records
 * which sections have already entered this app session, so warm-cache revisits
 * render instantly. At `minimal` level (or OS reduce-motion) the travel is
 * dropped for a 150ms crossfade; when entrance is skipped the child renders in
 * its final, static state with zero animation machinery.
 */

const playedEntranceIds = new Set<string>();

/** Test-only: forget which entrances have played so each test starts fresh. */
export function resetPlayedEntrancesForTests(): void {
    playedEntranceIds.clear();
}

/**
 * The ONE guard source for "did this section's entrance already play this
 * session" (R-L6 F1). EntranceView provides it; inner kit-consuming components
 * (bar grow-ins, width springs, line draw-ins, ripple grids) consume it and
 * render their final state immediately on a revisit remount. Outside any
 * EntranceView the default is `true` — surfaces without the entrance-once
 * contract (e.g. the settings-home strip) keep their per-mount entrances.
 */
const EntranceContext = React.createContext<boolean>(true);

/** True while the surrounding section's entrance is playing its one-and-only run this session. */
export function useEntrancesEnabled(): boolean {
    return React.useContext(EntranceContext);
}

export type EntranceViewProps = Readonly<{
    /** Stable id — an entrance plays at most once per id per app session. */
    entranceId: string;
    /** Position among staggered siblings (0-based); adds a capped delay. */
    index?: number;
    /** Vertical travel distance for the `full`/`subtle` entrance (px). */
    travel?: number;
    style?: StyleProp<ViewStyle>;
    children: React.ReactNode;
    testID?: string;
}>;

const DEFAULT_TRAVEL = 14;

export const EntranceView = React.memo(function EntranceView(props: EntranceViewProps) {
    const motion = useMotionPreferences();
    // Only the very first mount of a given id, this session, animates. The
    // decision is frozen per instance so a mid-entrance re-render (the mount
    // effect records the id) can neither snap the wrapper to its static branch
    // nor flip the context under descendants mid-flight.
    const shouldPlayRef = React.useRef<boolean | null>(null);
    if (shouldPlayRef.current === null) {
        shouldPlayRef.current = !playedEntranceIds.has(props.entranceId);
    }
    const shouldPlay = shouldPlayRef.current;

    const opacity = useSharedValue(shouldPlay ? 0 : 1);
    const translateY = useSharedValue(shouldPlay && motion.entrance.kind === 'travel' ? (props.travel ?? DEFAULT_TRAVEL) : 0);

    React.useEffect(() => {
        if (!shouldPlay) return;
        playedEntranceIds.add(props.entranceId);
        const delay = staggerDelayForIndex(props.index ?? 0);
        opacity.value = withDelay(delay, withTiming(1, { duration: motion.entrance.durationMs }));
        if (motion.entrance.kind === 'travel') {
            translateY.value = withDelay(delay, withSpring(0, INSTRUMENT_SPRINGS.standard));
        }
        // Mount-only: entrance plays once; deps intentionally frozen to first mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const animatedStyle = useAnimatedStyle(() => ({
        opacity: opacity.value,
        transform: [{ translateY: translateY.value }],
    }));

    if (!shouldPlay) {
        return (
            <View testID={props.testID} style={props.style}>
                <EntranceContext.Provider value={false}>
                    {props.children}
                </EntranceContext.Provider>
            </View>
        );
    }

    return (
        <Animated.View testID={props.testID} style={[props.style, animatedStyle]}>
            <EntranceContext.Provider value={true}>
                {props.children}
            </EntranceContext.Provider>
        </Animated.View>
    );
});
