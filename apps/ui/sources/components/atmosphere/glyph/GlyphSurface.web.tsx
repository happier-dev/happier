import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { createGlyphFrameSampler } from '@happier-dev/brand/glyph-scene';

import { releaseCanvasBackingStore } from '@/components/ui/media/canvasBackingStore';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { useGlyphClock } from '../moments/useMomentClock';
import type { GlyphSurfaceProps, GlyphSurfaceReadiness } from './glyphSurfaceTypes';

type Backend = typeof import('./glyphPainter.web');
type Prepared = {
    backend: Backend;
    painter: ReturnType<Backend['createWebGlyphPainter']>;
    atlas: Awaited<ReturnType<Backend['warmWebGlyphAtlas']>>;
};

export type { GlyphSurfaceProps, GlyphSurfaceReadiness, GlyphMotion } from './glyphSurfaceTypes';

export const GlyphSurface = React.memo(function GlyphSurface({
    width, height, scene, motion = null, theme: themeOverride, cell, style, testID, onReady, onPaint, drawAtRef, warmWhenHidden,
}: GlyphSurfaceProps) {
    const { theme: appTheme } = useUnistyles();
    const theme = themeOverride ?? (appTheme.dark ? 'dark' : 'light');
    const reduced = useReducedMotionPreference();
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * dpr), pixelHeight = Math.round(height * dpr);
    const cellW = cell?.[0] ?? 8, cellH = cell?.[1] ?? 16;
    const webgl = React.useRef<HTMLCanvasElement>(null);
    const still = React.useRef<HTMLCanvasElement>(null);
    const prepared = React.useRef<Prepared | null>(null);
    const currentCanvas = React.useRef<HTMLCanvasElement>(null);
    const [ready, setReady] = React.useState<GlyphSurfaceReadiness | null>(null);
    const sample = React.useMemo(createGlyphFrameSampler, []);
    const onReadyRef = React.useRef(onReady);
    onReadyRef.current = onReady;

    React.useEffect(() => {
        const canvas = webgl.current;
        if (!canvas) return;
        currentCanvas.current = canvas;
        let disposed = false;
        let painter: Prepared['painter'] | undefined;
        const stillCanvas = still.current;
        setReady(null);
        paintedStatus.current = null;
        void import('./glyphPainter.web').then(async backend => {
            if (disposed) return;
            painter = backend.createWebGlyphPainter(canvas, () => {
                canvas.dataset.glyphContextLost = String(painter?.lost ?? 0);
                setReady('still');
            }, (restored) => {
                canvas.dataset.glyphLinked = String(restored);
                setReady(restored ? 'ready' : 'still');
            });
            const grid = { cell: [Math.round(cellW * dpr), Math.round(cellH * dpr)] as const, cols: 0, rows: 0, origin: [0, 0] as const };
            const atlas = await backend.warmWebGlyphAtlas(grid, dpr);
            if (disposed) return;
            canvas.dataset.glyphRenderer = painter.renderer ?? 'unavailable';
            canvas.dataset.glyphLinked = String(painter.ready);
            prepared.current = { backend, painter, atlas };
            setReady(painter.ready ? 'ready' : 'still');
        });
        return () => {
            disposed = true;
            currentCanvas.current = null;
            prepared.current = null;
            painter?.dispose(() => currentCanvas.current !== canvas);
            releaseCanvasBackingStore(stillCanvas);
        };
    }, [cellW, cellH, dpr]);

    const readiness = reduced && ready ? 'still' : ready;
    const paintedStatus = React.useRef<GlyphSurfaceReadiness | null>(null);
    const paint = React.useCallback((seconds: number) => {
        const state = prepared.current;
        const canvas = webgl.current;
        const staticCanvas = still.current;
        if (!state || !canvas || !staticCanvas || pixelWidth <= 0 || pixelHeight <= 0) return;
        const layers = typeof scene === 'function' ? scene(seconds, readiness ?? undefined) : scene;
        const start = performance.now();
        const frame = sample({ view: { w: width, h: height }, dpr, theme, layers, cell: [cellW, cellH] }, { time: seconds });
        const target = state.painter.ready ? canvas : staticCanvas;
        if (target.width !== pixelWidth) target.width = pixelWidth;
        if (target.height !== pixelHeight) target.height = pixelHeight;
        if (state.painter.ready) state.painter.paint(frame, state.atlas);
        else state.backend.paintWebStill(target, frame, state.atlas);
        canvas.style.visibility = target === canvas ? 'visible' : 'hidden';
        staticCanvas.style.visibility = target === staticCanvas ? 'visible' : 'hidden';
        if (readiness && paintedStatus.current !== readiness) {
            paintedStatus.current = readiness;
            canvas.dataset.glyphFirstDrawMs = String(performance.now() - start);
            onReadyRef.current?.(readiness);
        }
        onPaint?.();
    }, [cellH, cellW, dpr, height, onPaint, pixelHeight, pixelWidth, readiness, sample, scene, theme, width]);
    React.useImperativeHandle(drawAtRef, () => readiness ? paint : (() => {}), [paint, readiness]);
    useGlyphClock(motion, readiness, paint, warmWhenHidden);

    return <View pointerEvents="none" testID={testID} style={[style, { width, height }]}>
        <canvas key={`gl-${dpr}-${cellW}-${cellH}`} ref={webgl} aria-hidden style={{ ...StyleSheet.absoluteFillObject, width, height, visibility: 'hidden' }} />
        <canvas key={`still-${dpr}-${cellW}-${cellH}`} ref={still} aria-hidden style={{ ...StyleSheet.absoluteFillObject, width, height, visibility: 'hidden' }} />
    </View>;
});
