import { useMemo } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { GlyphRect } from '@happier-dev/brand/glyph-scene';

import { GlyphSurface, type GlyphSurfaceReadiness } from '@/components/atmosphere/glyph/GlyphSurface';
import type { GlyphSurfaceWarmup } from '@/components/atmosphere/glyph/glyphSurfaceTypes';
import { FIRST_RUN_WORKFLOW_LAYER } from '@/components/ui/motion/stepMotion/StepMotionLayer';
import { playBuild, skipStepMotion, useOpeningBuildGlyphs } from '@/components/ui/motion/stepMotion/StepMotionStage';

import { createOpeningTimeline, openingClimbSeconds, openingSceneSeconds } from './openingTimeline';

const heldFrame = { kind: 'elapsed', durationS: 0, paused: true } as const;

export type FirstOpenPlacement = Readonly<{
    overlayFrame: GlyphRect;
    windowRect: GlyphRect;
    cursor: readonly [number, number] | null;
}>;

export function FirstOpenScene(props: Readonly<{
    epoch: number | null;
    holding?: boolean;
    warmup?: GlyphSurfaceWarmup;
    placement?: FirstOpenPlacement;
    onReady: (status: GlyphSurfaceReadiness) => void;
}>) {
    const viewport = useWindowDimensions();
    const { width, height } = props.placement?.overlayFrame ?? viewport;
    const { theme } = useUnistyles();
    const appearance = theme.dark ? 'dark' : 'light';
    const opening = useMemo(() => createOpeningTimeline({
        width, height, theme: appearance,
        windowRect: props.placement?.windowRect,
        cursor: props.placement?.cursor ? { x: props.placement.cursor[0], y: props.placement.cursor[1] } : undefined,
    }), [width, height, appearance, props.placement]);
    const build = useOpeningBuildGlyphs();
    const { epoch, holding } = props;
    const buildStartS = build && epoch !== null ? (build.animation.epoch - epoch) / 1000 : 0;
    const scene = useMemo(() => {
        if (!build) return opening;
        return (seconds: number, readiness?: GlyphSurfaceReadiness) => {
            const sky = opening(seconds);
            if (seconds < buildStartS) return sky;
            const reveal = typeof build.scene === 'function' ? build.scene(seconds - buildStartS, readiness) : build.scene;
            return [...sky, ...reveal];
        };
    }, [build, buildStartS, opening]);
    const motion = useMemo(() => holding ? heldFrame : epoch === null ? null : ({
        kind: 'transition' as const, epoch,
        durationS: build ? buildStartS + build.duration : openingSceneSeconds,
        onSettled: build?.finish,
    }), [build, buildStartS, epoch, holding]);
    return <GlyphSurface width={width} height={height} scene={scene} motion={motion} onReady={props.onReady}
        warmWhenHidden warmup={props.warmup} style={StyleSheet.absoluteFillObject} testID="first-open.scene" />;
}

export function buildFirstOpenDestination(epoch: number, options?: Readonly<{ interactive: boolean }>) {
    return playBuild({
        layer: FIRST_RUN_WORKFLOW_LAYER, choreography: 'opening', epoch,
        leadSeconds: openingClimbSeconds, interactive: options?.interactive,
    });
}

export { skipStepMotion as skipFirstOpenDestination };
