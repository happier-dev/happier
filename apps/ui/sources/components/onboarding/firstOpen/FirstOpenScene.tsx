import { useMemo } from 'react';
import { Platform, StyleSheet, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { GlyphRect } from '@happier-dev/brand/glyph-scene';

import { GlyphSurface, type GlyphSurfaceReadiness } from '@/components/atmosphere/glyph/GlyphSurface';
import { playBuild, skipStepMotion } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { useIsTablet } from '@/utils/platform/responsive';

import { createOpeningTimeline, openingClimbSeconds, openingSceneSeconds } from './openingTimeline';

export type FirstOpenPlacement = Readonly<{
    overlayFrame: GlyphRect;
    windowRect: GlyphRect;
    cursor: readonly [number, number] | null;
}>;

export function FirstOpenScene(props: Readonly<{
    epoch: number | null;
    placement?: FirstOpenPlacement;
    onReady: (status: GlyphSurfaceReadiness) => void;
}>) {
    const viewport = useWindowDimensions();
    const { width, height } = props.placement?.overlayFrame ?? viewport;
    const { theme } = useUnistyles();
    const appearance = theme.dark ? 'dark' : 'light';
    const phone = !useIsTablet() && Platform.OS !== 'web';
    const scene = useMemo(() => createOpeningTimeline({
        width, height, phone, theme: appearance,
        windowRect: props.placement?.windowRect,
        cursor: props.placement?.cursor ? { x: props.placement.cursor[0], y: props.placement.cursor[1] } : undefined,
    }), [width, height, phone, appearance, props.placement]);
    const motion = useMemo(() => props.epoch === null ? null : ({
        kind: 'transition' as const, epoch: props.epoch, durationS: openingSceneSeconds,
    }), [props.epoch]);
    return <GlyphSurface width={width} height={height} scene={scene} motion={motion} onReady={props.onReady}
        warmWhenHidden style={StyleSheet.absoluteFillObject} testID="first-open.scene" />;
}

export function buildFirstOpenDestination(epoch: number) {
    return playBuild({ layer: 'workflow', choreography: 'opening', epoch, leadSeconds: openingClimbSeconds });
}

export { skipStepMotion as skipFirstOpenDestination };
