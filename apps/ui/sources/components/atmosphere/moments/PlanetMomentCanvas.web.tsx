import * as React from 'react';
import { StyleSheet } from 'react-native';
import { planetAssemblyFrame } from '@happier-dev/brand/planet';
import { getMonoFont } from '@/constants/Typography';
import { planetCanvasFonts } from '../glyph/glyphAtlas.web';
import { snapCanvasBox } from '../planetCanvasScene';
import type { PlanetMomentCanvasProps } from './planetMomentCanvas.types';
import { useCanvasBackingStoreRelease } from '@/components/ui/media/canvasBackingStore';

/**
 * The assembly's canvas painter, ported from the lab's `drawAssembly` (`mo-r4.js`): the body dots the
 * light has reached, the haze arriving last, then the digits (the cloud, the flying patches and the
 * field settling). Every value comes from the brand frame; this only puts it on the device grid.
 */
export const PlanetMomentCanvas = React.memo(function PlanetMomentCanvas(props: PlanetMomentCanvasProps) {
    const ref = React.useRef<HTMLCanvasElement>(null);
    const box = snapCanvasBox(props.width, props.height, props.dpr);
    const fonts = React.useMemo(planetCanvasFonts, []);
    useCanvasBackingStoreRelease(ref, box.pixelWidth, box.pixelHeight);
    React.useLayoutEffect(() => {
        const context = ref.current?.getContext('2d');
        if (!context) return;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, box.pixelWidth, box.pixelHeight);
        if (props.opacity <= 0) return;
        context.setTransform(props.dpr, 0, 0, props.dpr, 0, 0);
        const frame = planetAssemblyFrame(props.assembly, { ...props.frame, alpha: props.opacity * (props.frame.alpha ?? 1) });
        for (const dot of frame.body) {
            context.globalAlpha = dot.opacity;
            context.fillStyle = `rgb(${dot.rgb[0] | 0},${dot.rgb[1] | 0},${dot.rgb[2] | 0})`;
            context.beginPath(); context.arc(dot.x, dot.y, dot.r, 0, 6.2832); context.fill();
        }
        if (frame.halo > 0) {
            for (const dot of props.haze) {
                context.globalAlpha = dot.opacity * frame.halo;
                context.fillStyle = `rgb(${dot.rgb[0] | 0},${dot.rgb[1] | 0},${dot.rgb[2] | 0})`;
                context.beginPath(); context.arc(dot.x, dot.y, dot.r, 0, 6.2832); context.fill();
            }
        }
        context.globalAlpha = 1;
        context.textAlign = 'center'; context.textBaseline = 'middle';
        for (const cell of frame.cells) {
            context.font = `${cell.weight} ${cell.fs}px ${cell.weight >= 600 ? fonts.semiBold : fonts.regular}`;
            context.fillStyle = `rgba(${Math.round(cell.col[0])},${Math.round(cell.col[1])},${Math.round(cell.col[2])},${cell.a})`;
            context.fillText(cell.ch, cell.x, cell.y);
        }
    }, [box.pixelHeight, box.pixelWidth, fonts, props.assembly, props.dpr, props.frame, props.haze, props.opacity]);
    return React.createElement('canvas', {
        ref, width: box.pixelWidth, height: box.pixelHeight, 'data-testid': props.testID, 'aria-hidden': true,
        style: { ...StyleSheet.flatten(props.style), width: box.width, height: box.height, pointerEvents: 'none', display: 'block', fontFamily: getMonoFont() },
    });
});
