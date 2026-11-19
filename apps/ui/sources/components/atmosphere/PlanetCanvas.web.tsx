import * as React from 'react';
import { StyleSheet } from 'react-native';
import { getMonoFont } from '@/constants/Typography';
import { createPlanetCanvasSceneCache, snapCanvasBox } from './planetCanvasScene';
import { paintPlanetMark } from './planetCanvasPaint.web';
import type { PlanetCanvasProps } from './planetCanvas.types';
import { useCanvasBackingStoreRelease } from '@/components/ui/media/canvasBackingStore';

import { planetCanvasFonts } from './glyph/glyphAtlas.web';


export const PlanetCanvas = React.memo(function PlanetCanvas(props: PlanetCanvasProps) {
    const ref = React.useRef<HTMLCanvasElement>(null);
    const ready = React.useRef(props.onReady); ready.current = props.onReady;
    const failed = React.useRef(props.onError); failed.current = props.onError;
    const dpr = props.options?.dpr ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    const box = snapCanvasBox(props.width, props.height, dpr);
    const resolve = React.useMemo(createPlanetCanvasSceneCache, []);
    const scene = resolve(props, dpr);
    const scale = props.mark ? props.width / (props.mark.size ?? 24) : 1;
    const ink = props.mark?.ink ?? props.ink;
    useCanvasBackingStoreRelease(ref, box.pixelWidth, box.pixelHeight);

    React.useLayoutEffect(() => {
        let active = true;
        const draw = async () => {
            const fonts = planetCanvasFonts();
            if (scene.cells.length) {
                const faces = [`12px ${fonts.regular}`, `600 12px ${fonts.semiBold}`];
                if (!faces.every(face => document.fonts.check(face))) await Promise.all(faces.map(face => document.fonts.load(face)));
            }
            const context = active ? ref.current?.getContext('2d') : null;
            if (!context) return;
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.clearRect(0, 0, box.pixelWidth, box.pixelHeight);
            context.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
            paintPlanetMark(context, scene, fonts, ink);
            ready.current?.();
        };
        void draw().catch(error => { if (active) failed.current?.(error instanceof Error ? error : new Error(String(error))); });
        return () => { active = false; };
    }, [box.pixelHeight, box.pixelWidth, dpr, ink, scale, scene]);

    return React.createElement('canvas', {
        ref, width: box.pixelWidth, height: box.pixelHeight, 'data-testid': props.testID, 'aria-hidden': true,
        style: { ...StyleSheet.flatten(props.style), width: box.width, height: box.height, pointerEvents: 'none', display: 'block', fontFamily: getMonoFont() },
    });
});
