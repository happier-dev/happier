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
type Painter = Awaited<ReturnType<Backend['createNativeGlyphPainter']>>;
export type { GlyphSurfaceProps, GlyphSurfaceReadiness, GlyphMotion } from './glyphSurfaceTypes';

export function warmGlyphSurface(): undefined {
    void import('./glyphPainter.native').catch(() => {});
    return undefined;
}

export const GlyphSurface = React.memo(function GlyphSurface({
    width, height, scene, motion = null, theme: themeOverride, cell, pixelRatio, style, testID, onReady, onPaint, composePicture, drawAtRef, warmWhenHidden, viewport, digitCadence,
}: GlyphSurfaceProps) {
    const { theme: appTheme } = useUnistyles();
    const theme = themeOverride ?? (appTheme.dark ? 'dark' : 'light');
    const dpr = pixelRatio ?? PixelRatio.get();
    const reduced = useReducedMotionPreference();
    const painterRef = React.useRef<Painter | null>(null);
    const [prepared, setPrepared] = React.useState(false);
    const [lowPower, setLowPower] = React.useState<boolean | null>(null);
    const [picture, setPicture] = React.useState<SharedValue<SkPicture> | null>(null);
    const pictureRef = React.useRef<SharedValue<SkPicture> | null>(null);
    const previousPicture = React.useRef<SkPicture | null>(null);
    const sample = React.useMemo(createGlyphFrameSampler, []);
    const onReadyRef = React.useRef(onReady);
    onReadyRef.current = onReady;
    const cellW = cell?.[0] ?? 8, cellH = cell?.[1] ?? 16;
    const dimensions = React.useRef({ width, height });

    React.useLayoutEffect(() => {
        dimensions.current = { width, height };
        painterRef.current?.reserveSpriteBatch(width, height);
    }, [width, height]);

    React.useEffect(() => {
        let disposed = false;
        setPrepared(false);
        setPicture(null);
        paintedStatus.current = null;
        const grid = { cell: [Math.round(cellW * dpr), Math.round(cellH * dpr)] as const, cols: 0, rows: 0, origin: [0, 0] as const };
        void import('./glyphPainter.native').then(backend => backend.createNativeGlyphPainter(grid, dpr)).then((painter) => {
            if (disposed) { painter.dispose(); return; }
            painter.reserveSpriteBatch(dimensions.current.width, dimensions.current.height);
            painterRef.current = painter;
            setPrepared(true);
        }, () => {
            if (!disposed) setPrepared(true);
        });
        return () => {
            disposed = true;
            pictureRef.current = null;
            previousPicture.current?.dispose();
            previousPicture.current = null;
            painterRef.current?.dispose();
            painterRef.current = null;
        };
    }, [cellH, cellW, dpr]);

    React.useEffect(() => {
        let active = true;
        void readGlyphLowPower().then(value => { if (active) setLowPower(value); });
        return () => { active = false; };
    }, []);
    const readiness = prepared && lowPower !== null ? reduced || lowPower || !painterRef.current ? 'still' as const : 'ready' as const : null;
    const paintedStatus = React.useRef<GlyphSurfaceReadiness | null>(null);
    const paint = React.useCallback((seconds: number, digitSeconds = 0) => {
        if (width <= 0 || height <= 0) return;
        const layers = typeof scene === 'function' ? scene(seconds, readiness ?? undefined, digitSeconds) : scene;
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
        if (readiness && paintedStatus.current !== readiness) {
            paintedStatus.current = readiness;
            onReadyRef.current?.(readiness);
        }
        onPaint?.();
    }, [cellH, cellW, composePicture, dpr, height, onPaint, readiness, sample, scene, theme, width]);
    React.useImperativeHandle(drawAtRef, () => readiness ? paint : (() => {}), [paint, readiness]);
    useGlyphClock(motion, readiness, paint, warmWhenHidden, viewport, digitCadence);

    return <Canvas pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={testID} style={[style, { width, height }]}>
        {picture ? <Picture picture={picture} /> : null}
    </Canvas>;
});
