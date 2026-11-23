import * as React from 'react';
import { PixelRatio } from 'react-native';
import { Canvas, Picture, type SkPicture } from '@shopify/react-native-skia';
import { makeMutable, type SharedValue } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { createGlyphFrameSampler } from '@happier-dev/brand/glyph-scene';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { useGlyphClock } from '../moments/useMomentClock';
import type { GlyphSurfaceProps, GlyphSurfaceReadiness } from './glyphSurfaceTypes';
import { readGlyphLowPower } from './readGlyphLowPower.native';

type Backend = typeof import('./glyphPainter.native');
type Painter = ReturnType<Backend['createNativeGlyphPainter']>;
type Preparation = Readonly<{ createPainter: () => Painter; lowPower: boolean }> | 'still';
const defaultCell = [8, 16] as const;
export type { GlyphSurfaceProps, GlyphSurfaceReadiness, GlyphMotion } from './glyphSurfaceTypes';

function prepareGlyphs(dpr: number, cellW: number, cellH: number): Promise<Preparation> {
    const grid = { cell: [Math.round(cellW * dpr), Math.round(cellH * dpr)] as const, cols: 0, rows: 0, origin: [0, 0] as const };
    const painter = import('./glyphPainter.native').then(async backend => {
        const atlas = await backend.warmNativeGlyphAtlas(grid, dpr);
        return () => backend.createNativeGlyphPainter(grid, dpr, atlas);
    });
    return Promise.all([painter, readGlyphLowPower()]).then(
        ([createPainter, lowPower]) => ({ createPainter, lowPower }),
        () => 'still' as const,
    );
}

export function warmGlyphSurface() {
    const dpr = PixelRatio.get();
    let prepared: Preparation | null = null;
    const pending = prepareGlyphs(dpr, ...defaultCell).then(result => prepared = result);
    // The admission owns just CPU atlas bytes until a surface takes the preparation.
    return { dpr, pending, get prepared() { return prepared; } };
}

export const GlyphSurface = React.memo(function GlyphSurface({
    width, height, scene, motion = null, theme: themeOverride, cell, pixelRatio, style, testID, onReady, onPaint, composePicture, drawAtRef, warmWhenHidden, warmup, viewport, digitCadence,
}: GlyphSurfaceProps) {
    const { theme: appTheme } = useUnistyles();
    const theme = themeOverride ?? (appTheme.dark ? 'dark' : 'light');
    const dpr = pixelRatio ?? PixelRatio.get();
    const reduced = useReducedMotionPreference();
    const painterRef = React.useRef<Painter | null>(null);
    const [available, setAvailable] = React.useState<GlyphSurfaceReadiness | null>(null);
    const [picture, setPicture] = React.useState<SharedValue<SkPicture> | null>(null);
    const pictureRef = React.useRef<SharedValue<SkPicture> | null>(null);
    const previousPicture = React.useRef<SkPicture | null>(null);
    const sample = React.useMemo(createGlyphFrameSampler, []);
    const onReadyRef = React.useRef(onReady);
    onReadyRef.current = onReady;
    const [cellW, cellH] = cell ?? defaultCell;
    const dimensions = React.useRef({ width, height });
    const admission = warmup && 'pending' in warmup && warmup.dpr === dpr && cellW === defaultCell[0] && cellH === defaultCell[1] ? warmup : undefined;

    React.useLayoutEffect(() => {
        dimensions.current = { width, height };
        painterRef.current?.reserveSpriteBatch(width, height);
    }, [width, height]);

    const readiness = reduced && available ? 'still' : available;
    const paintedStatus = React.useRef<GlyphSurfaceReadiness | null>(null);
    const draw = React.useCallback((seconds: number, digitSeconds: number, status: GlyphSurfaceReadiness) => {
        if (width <= 0 || height <= 0) return;
        const layers = typeof scene === 'function' ? scene(seconds, status, digitSeconds) : scene;
        const painter = painterRef.current;
        const frame = painter && sample({ view: { w: width, h: height }, dpr, theme, layers, cell: [cellW, cellH] }, { time: seconds });
        const next = composePicture
            ? composePicture(canvas => { if (frame && painter) painter.draw(canvas, frame); }, previousPicture.current)
            : frame && painter ? painter.paint(frame) : null;
        if (next) {
            const published = pictureRef.current;
            if (published) published.value = next;
            else {
                // Skia materializes the shared value when Picture mounts.
                const initial = makeMutable(next);
                pictureRef.current = initial;
                setPicture(initial);
            }
            previousPicture.current?.dispose();
            previousPicture.current = next;
        }
        if (paintedStatus.current !== status) {
            paintedStatus.current = status;
            onReadyRef.current?.(status);
        }
        onPaint?.();
    }, [cellH, cellW, composePicture, dpr, height, onPaint, sample, scene, theme, width]);
    const drawRef = React.useRef({ draw, reduced, warmWhenHidden });
    drawRef.current = { draw, reduced, warmWhenHidden };
    const primed = React.useRef<{ draw: typeof draw; status: GlyphSurfaceReadiness } | null>(null);

    React.useLayoutEffect(() => {
        let disposed = false;
        setAvailable(null);
        setPicture(null);
        paintedStatus.current = null;
        primed.current = null;
        const prepare = (result: Preparation) => {
            if (disposed) return;
            let status: GlyphSurfaceReadiness = 'still';
            if (result !== 'still') {
                try {
                    const painter = result.createPainter();
                    painterRef.current = painter;
                    painter.reserveSpriteBatch(dimensions.current.width, dimensions.current.height);
                    if (!result.lowPower) status = 'ready';
                } catch {
                    painterRef.current?.dispose();
                    painterRef.current = null;
                }
            }
            if (admission && drawRef.current.warmWhenHidden) {
                const { draw, reduced } = drawRef.current;
                const firstStatus = reduced ? 'still' : status;
                draw(0, 0, firstStatus);
                if (paintedStatus.current === firstStatus) primed.current = { draw, status: firstStatus };
            }
            setAvailable(status);
        };
        if (admission?.prepared) prepare(admission.prepared);
        else void (admission?.pending ?? prepareGlyphs(dpr, cellW, cellH)).then(prepare);
        return () => {
            disposed = true;
            pictureRef.current = null;
            previousPicture.current?.dispose();
            previousPicture.current = null;
            painterRef.current?.dispose();
            painterRef.current = null;
        };
    }, [admission, cellH, cellW, dpr]);

    const paint = React.useCallback((seconds: number, digitSeconds = 0) => {
        const firstFrame = primed.current;
        primed.current = null;
        if (firstFrame?.draw === draw && firstFrame.status === readiness && seconds === 0 && digitSeconds === 0) return;
        if (readiness) draw(seconds, digitSeconds, readiness);
    }, [draw, readiness]);
    React.useImperativeHandle(drawAtRef, () => readiness ? paint : (() => {}), [paint, readiness]);
    useGlyphClock(motion, readiness, paint, warmWhenHidden, viewport, digitCadence);

    return <Canvas pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={testID} style={[style, { width, height }]}>
        {picture ? <Picture picture={picture} /> : null}
    </Canvas>;
});
