import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withSpring,
    withTiming,
} from 'react-native-reanimated';

import { INSTRUMENT_DURATIONS, INSTRUMENT_SPRINGS, INSTRUMENT_STAGGER } from '../motion/motionTokens';
import { useMotionPreferences } from '../motion/useMotionPreferences';

/**
 * Heatmap-cell entrance choreography for L6: cells ripple in radially from the
 * top-left of the grid — scale 0.6→1 + fade, one 40ms wavefront step per grid
 * ring, playing ONCE per mount. The wavefront delay is capped (stagger cap) so
 * large heatmaps never accumulate an unbounded wait. `minimal` level (or OS
 * reduce-motion) renders a plain 150ms crossfade without scale; cells are laid
 * out in a wrapping row of `columns`.
 */

export type RippleGridProps = Readonly<{
    columns: number;
    /** Cells in row-major order. Keep elements memoized — the grid is dumb. */
    children: ReadonlyArray<React.ReactNode>;
    /** Cell square edge (each child is centered in it). */
    cellSize: number;
    /** Gap between cells. */
    gap?: number;
    /**
     * False → cells render in their final state immediately (no ripple).
     * Additive, default `true`; consumers with an entrance-once contract pass
     * their played-state guard here so a revisit remount does not replay.
     */
    animateOnMount?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;

const RIPPLE_STEP_MS = 40;

export function rippleDelayMs(index: number, columns: number): number {
    const row = Math.floor(index / Math.max(1, columns));
    const col = index % Math.max(1, columns);
    // Radial wavefront from the top-left, measured in grid rings (Chebyshev
    // distance), capped by the shared stagger budget.
    const ring = Math.min(Math.max(row, col), INSTRUMENT_STAGGER.maxItems - 1);
    return ring * RIPPLE_STEP_MS;
}

type RippleCellProps = Readonly<{
    delayMs: number;
    animate: boolean;
    /** True = scale+fade travel; false = crossfade only. */
    travel: boolean;
    size: number;
    children: React.ReactNode;
}>;

const RippleCell = React.memo(function RippleCell(props: RippleCellProps) {
    const progress = useSharedValue(props.animate ? 0 : 1);

    React.useEffect(() => {
        if (!props.animate) return;
        progress.value = props.travel
            ? withDelay(props.delayMs, withSpring(1, INSTRUMENT_SPRINGS.standard))
            : withTiming(1, { duration: INSTRUMENT_DURATIONS.crossfadeMinimal });
        // Entrance plays ONCE per mount by design.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const travel = props.travel;
    const style = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ scale: travel ? 0.6 + 0.4 * progress.value : 1 }],
    }));

    return (
        <Animated.View style={[{ width: props.size, height: props.size }, styles.cell, style]}>
            {props.children}
        </Animated.View>
    );
});

export const RippleGrid = React.memo(function RippleGrid(props: RippleGridProps) {
    const motion = useMotionPreferences();
    const gap = props.gap ?? 2;
    const travel = motion.entrance.kind === 'travel';
    // At minimal we still crossfade in (150ms) — never a hard pop unless the
    // reduce-motion crossfade itself is the entrance. `animateOnMount === false`
    // (an entrance-once consumer on a revisit remount) skips even that.
    const animate = props.animateOnMount ?? true;

    return (
        <View
            testID={props.testID}
            style={[
                styles.grid,
                { width: props.columns * (props.cellSize + gap) - gap, gap },
                props.style,
            ]}
        >
            {props.children.map((child, index) => (
                <RippleCell
                    key={index}
                    delayMs={travel ? rippleDelayMs(index, props.columns) : 0}
                    animate={animate}
                    travel={travel}
                    size={props.cellSize}
                >
                    {child}
                </RippleCell>
            ))}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    grid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
    },
    cell: {
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
