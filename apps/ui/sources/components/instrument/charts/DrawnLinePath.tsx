import * as React from 'react';
import { Canvas, Path as SkiaPath, Skia } from '@shopify/react-native-skia';
import { useDerivedValue, useSharedValue, withTiming, Easing } from 'react-native-reanimated';

import { INSTRUMENT_DURATIONS } from '../motion/motionTokens';
import { useMotionPreferences } from '../motion/useMotionPreferences';
import { LineFade } from './LineFade';

/**
 * Draw-in line for L6 charts (native build). Tier 1 (`full` effects): Skia
 * path-trim — the stroke draws itself in once on mount. Tier 2 (subtle /
 * minimal / unsupported): opacity fade via `LineFade`. Web builds resolve
 * `DrawnLinePath.web.tsx` (fade only; no Skia in the web bundle).
 */

export type DrawnLinePathProps = Readonly<{
    /** SVG path string (e.g. from an existing chart's path builder). */
    path: string;
    width: number;
    height: number;
    color: string;
    strokeWidth?: number;
    /**
     * False → render the finished stroke immediately (no draw-in). Additive,
     * default `true`; consumers with an entrance-once contract pass their
     * played-state guard here so a revisit remount does not replay.
     */
    animateOnMount?: boolean;
    testID?: string;
}>;

export const DrawnLinePath = React.memo(function DrawnLinePath(props: DrawnLinePathProps) {
    const motion = useMotionPreferences();
    const animateOnMount = props.animateOnMount ?? true;

    const skPath = React.useMemo(
        () => (motion.effectsEnabled ? Skia?.Path?.MakeFromSVGString?.(props.path) ?? null : null),
        [motion.effectsEnabled, props.path],
    );

    const end = useSharedValue(animateOnMount ? 0 : 1);
    const trim = useDerivedValue(() => end.value);
    const useTrim = skPath !== null;
    React.useEffect(() => {
        if (!useTrim || !animateOnMount) return;
        end.value = withTiming(1, {
            duration: INSTRUMENT_DURATIONS.entranceEmphasis,
            easing: Easing.bezier(0.2, 0, 0, 1),
        });
        // Entrance plays at most ONCE per mount by design.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [useTrim]);

    if (!useTrim) {
        return (
            <LineFade
                path={props.path}
                width={props.width}
                height={props.height}
                color={props.color}
                strokeWidth={props.strokeWidth}
                animateEntrance={motion.level !== 'minimal' && animateOnMount}
                durationMs={motion.entrance.durationMs}
                testID={props.testID}
            />
        );
    }

    return (
        <Canvas testID={props.testID} style={{ width: props.width, height: props.height }}>
            <SkiaPath
                path={skPath}
                style="stroke"
                strokeWidth={props.strokeWidth ?? 1.5}
                strokeCap="round"
                strokeJoin="round"
                color={props.color}
                start={0}
                end={trim}
            />
        </Canvas>
    );
});
