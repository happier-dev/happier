import * as React from 'react';
import { drawPlanetMarkFrame } from '@happier-dev/brand/planet';
import { useAnimatedReaction } from 'react-native-reanimated';

import type { VoiceMarkCanvasProps } from './voiceMarkCanvasTypes';

/**
 * Web renderer for the Voice mark.
 *
 * The web bundle keeps `@shopify/react-native-skia` out (CanvasKit is never loaded at startup; see
 * `LiquidFill.web.tsx`), so the same frame is painted into a plain 2D canvas: the same Brand
 * geometry, the same Brand `drawPlanetMarkFrame`, the same SharedValues. Painting happens only when one of
 * those values changes, so a settled mark draws once and then idles.
 */
export const VoiceMarkCanvas = React.memo(function VoiceMarkCanvas(props: VoiceMarkCanvasProps) {
    const { to, from, morph, pose, energy, flow } = props;
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const width = to.maxX - to.minX;
    const height = to.maxY - to.minY;
    const ratio = typeof window === 'undefined' ? 2 : Math.min(3, Math.max(2, window.devicePixelRatio || 1));

    const paint = React.useCallback((m: number, p: number, e: number, f: number) => {
        const canvas = canvasRef.current;
        const context = canvas?.getContext('2d');
        if (!canvas || !context) return;
        context.setTransform(ratio, 0, 0, ratio, -to.minX * ratio, -to.minY * ratio);
        context.clearRect(to.minX, to.minY, width, height);
        drawPlanetMarkFrame(to, from, m, p, e, f, (x, y, radius, r, g, b, a) => {
            context.fillStyle = `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
            context.beginPath();
            context.arc(x, y, radius, 0, Math.PI * 2);
            context.fill();
        });
    }, [from, height, ratio, to, width]);

    // Geometry or theme changed: repaint the current values once.
    React.useLayoutEffect(() => {
        paint(morph.value, pose.value, energy.value, flow.value);
    }, [energy, flow, morph, paint, pose]);

    useAnimatedReaction(
        () => [morph.value, pose.value, energy.value, flow.value] as const,
        (next, previous) => {
            if (previous && next[0] === previous[0] && next[1] === previous[1] && next[2] === previous[2] && next[3] === previous[3]) return;
            paint(next[0], next[1], next[2], next[3]);
        },
        [paint],
    );

    return React.createElement('canvas', {
        ref: canvasRef,
        width: Math.ceil(width * ratio),
        height: Math.ceil(height * ratio),
        'aria-hidden': true,
        style: {
            position: 'absolute',
            left: to.minX,
            top: to.minY,
            width,
            height,
            pointerEvents: 'none',
        },
    });
});
