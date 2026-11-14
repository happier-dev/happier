import * as React from 'react';
import { Canvas, Picture, Skia, createPicture, useTypeface, type SkFont } from '@shopify/react-native-skia';
import { planetAssemblyFrame } from '@happier-dev/brand/planet';
import { snapCanvasBox } from '../planetCanvasScene';
import type { PlanetMomentCanvasProps } from './planetMomentCanvas.types';

/**
 * The assembly painter on Skia: the same brand frame as the web canvas (body, haze arriving last,
 * digits), recorded into one picture per frame on the JS runtime, never on the UI thread.
 */
export const PlanetMomentCanvas = React.memo(function PlanetMomentCanvas(props: PlanetMomentCanvasProps) {
    // Typefaces, not fonts: see paintNativePlanetScene on Skia's borrowed `getTypeface()`.
    const regular = useTypeface(require('@/assets/fonts/IBMPlexMono-Regular.ttf'));
    const strong = useTypeface(require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'));
    const box = snapCanvasBox(props.width, props.height, props.dpr);
    const picture = React.useMemo(() => {
        if (!regular || !strong || props.opacity <= 0) return null;
        const frame = planetAssemblyFrame(props.assembly, { ...props.frame, alpha: props.opacity * (props.frame.alpha ?? 1) });
        return createPicture(canvas => {
            const paint = Skia.Paint(); paint.setAntiAlias(true);
            const dot = (d: Readonly<{ x: number; y: number; r: number; rgb: readonly number[] }>, alpha: number) => {
                paint.setColor(new Float32Array([(d.rgb[0] | 0) / 255, (d.rgb[1] | 0) / 255, (d.rgb[2] | 0) / 255, 1]));
                paint.setAlphaf(alpha); canvas.drawCircle(d.x, d.y, d.r, paint);
            };
            for (const d of frame.body) dot(d, d.opacity);
            if (frame.halo > 0) for (const d of props.haze) dot(d, d.opacity * frame.halo);
            // One font per size and face for the frame: the cloud repeats a handful of sizes.
            const fonts = new Map<string, SkFont>();
            for (const cell of frame.cells) {
                const face = cell.weight >= 600 ? strong : regular;
                const key = `${cell.weight >= 600 ? 's' : 'r'}${cell.fs}`;
                let font = fonts.get(key);
                if (!font) { font = Skia.Font(face, cell.fs); fonts.set(key, font); }
                paint.setColor(new Float32Array([Math.round(cell.col[0]) / 255, Math.round(cell.col[1]) / 255, Math.round(cell.col[2]) / 255, cell.a]));
                const metrics = font.getMetrics();
                canvas.drawText(cell.ch, cell.x - font.getGlyphWidths(font.getGlyphIDs(cell.ch))[0] / 2, cell.y - (metrics.ascent + metrics.descent) / 2, paint, font);
            }
            fonts.forEach(font => font.dispose());
            paint.dispose();
        }, { width: box.width, height: box.height });
    }, [box.height, box.width, props.assembly, props.frame, props.haze, props.opacity, regular, strong]);
    React.useEffect(() => () => { picture?.dispose(); }, [picture]);
    return <Canvas pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={props.testID} style={[props.style, { width: box.width, height: box.height }]}>
        {picture ? <Picture picture={picture} /> : null}
    </Canvas>;
});
