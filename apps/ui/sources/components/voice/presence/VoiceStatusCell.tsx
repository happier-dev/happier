import * as React from 'react';
import { View } from 'react-native';
import Animated, {
    cancelAnimation,
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { createPlanetStatusCell, type PlanetStatusCellKind } from '@happier-dev/brand/planet';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

export type VoiceStatusCellKind = Extract<PlanetStatusCellKind, 'thinking' | 'working' | 'needs_you'>;

/** One band trip, in the CLI Braille spinner's cadence (Daybreak `db-orbit` 1.04 s, `db-rise` 1.6 s). */
const CYCLE_MS: Readonly<Record<VoiceStatusCellKind, number | null>> = {
    working: 1040,
    thinking: 1600,
    needs_you: null,
};
const STEPS = 8;

/**
 * The 2×4 dot cell (VE-01): thinking, working or needs you, drawn from Brand's cell poses.
 *
 * Status while true: a working or thinking cell steps through Brand's poses for as long as that is
 * the fact, on the UI thread, and stops while the app or its presentation is hidden. Needs you is a still pose — it
 * asks for attention by shape and colour, not by motion. Reduced motion holds every cell still.
 */
export const VoiceStatusCell = React.memo(function VoiceStatusCell(props: Readonly<{
    kind: VoiceStatusCellKind;
    /** Cell height in points; the cell is half as wide. */
    size?: number;
    theme?: 'light' | 'dark';
    still?: boolean;
    /** A caller may narrow the enclosing host's presentation, never reactivate it. */
    presented?: boolean;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const reduced = useReducedMotionPreference();
    const viewed = useHostActivelyViewed();
    const presented = useLayoutPresentationActive();
    const size = props.size ?? 14;
    const planetTheme = props.theme ?? (theme.dark ? 'dark' : 'light');
    const cycle = CYCLE_MS[props.kind];
    const animated = cycle !== null && !reduced && !props.still && viewed && presented && props.presented !== false;

    const poses = React.useMemo(() => {
        const steps = animated ? STEPS : 1;
        return Array.from({ length: steps }, (_, step) => createPlanetStatusCell({
            kind: props.kind,
            size,
            theme: planetTheme,
            ...(animated ? { progress: step / STEPS } : {}),
        }));
    }, [animated, planetTheme, props.kind, size]);
    const base = poses[0];
    const opacities = React.useMemo(() => poses.map((pose) => pose.map((dot) => dot.opacity)), [poses]);

    const progress = useSharedValue(0);
    React.useEffect(() => {
        if (!animated || cycle === null) {
            cancelAnimation(progress);
            progress.value = 0;
            return;
        }
        progress.value = 0;
        progress.value = withRepeat(withTiming(1, { duration: cycle, easing: Easing.linear }), -1, false);
        return () => cancelAnimation(progress);
    }, [animated, cycle, progress]);

    return (
        <View
            testID={props.testID}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ width: size / 2, height: size }}
        >
            {base.map((dot) => (
                <VoiceStatusCellDot
                    key={dot.id}
                    index={dot.id}
                    x={dot.x}
                    y={dot.y}
                    radius={dot.radius}
                    color={`rgb(${dot.rgb[0]},${dot.rgb[1]},${dot.rgb[2]})`}
                    opacities={opacities}
                    progress={progress}
                />
            ))}
        </View>
    );
});

const VoiceStatusCellDot = React.memo(function VoiceStatusCellDot(props: Readonly<{
    index: number;
    x: number;
    y: number;
    radius: number;
    color: string;
    opacities: readonly (readonly number[])[];
    progress: SharedValue<number>;
}>) {
    const { index, opacities, progress } = props;
    const style = useAnimatedStyle(() => {
        const raw = Math.floor(progress.value * opacities.length);
        const step = Number.isFinite(raw) ? Math.max(0, Math.min(opacities.length - 1, raw)) : 0;
        return { opacity: opacities[step]?.[index] ?? 0 };
    }, [index, opacities]);
    const diameter = props.radius * 2;
    return (
        <Animated.View
            style={[
                {
                    position: 'absolute',
                    left: props.x - props.radius,
                    top: props.y - props.radius,
                    width: diameter,
                    height: diameter,
                    borderRadius: props.radius,
                    backgroundColor: props.color,
                },
                style,
            ]}
        />
    );
});
