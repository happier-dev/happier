import * as React from 'react';
import { StyleSheet } from 'react-native';
import { snapCanvasBox, useCanvasBackingStoreRelease } from '@/components/ui/media/canvasBackingStore';
import { createPlanetCanvasDotsCache } from './planetCanvasDots';
import { paintPlanetDots } from './planetCanvasPaintDots.web';
import type { PlanetCanvasProps } from './planetCanvas.types';

export const PlanetCanvas = React.memo(function PlanetCanvas(props: PlanetCanvasProps) {
    const ref = React.useRef<HTMLCanvasElement>(null);
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const box = snapCanvasBox(props.width, props.height, dpr);
    const resolve = React.useMemo(createPlanetCanvasDotsCache, []);
    const dots = props.mark ? resolve(props.mark) : props.dots;
    const scale = props.mark ? props.width / (props.mark.size ?? 24) : 1;
    const ink = props.mark?.ink ?? props.ink;
    useCanvasBackingStoreRelease(ref, box.pixelWidth, box.pixelHeight);

    React.useLayoutEffect(() => {
        const context = ref.current?.getContext('2d');
        if (!context) return;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, box.pixelWidth, box.pixelHeight);
        context.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
        paintPlanetDots(context, dots, ink);
    }, [box.pixelHeight, box.pixelWidth, dots, dpr, ink, scale]);

    return React.createElement('canvas', {
        ref, width: box.pixelWidth, height: box.pixelHeight, 'data-testid': props.testID, 'aria-hidden': true,
        style: { ...StyleSheet.flatten(props.style), width: box.width, height: box.height, pointerEvents: 'none', display: 'block' },
    });
});
