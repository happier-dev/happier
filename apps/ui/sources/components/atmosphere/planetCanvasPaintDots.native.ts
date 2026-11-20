import { Skia, type SkCanvas, type SkPaint } from '@shopify/react-native-skia';
import type { PlanetMarkDot } from './planetCanvasDots';

export function paintNativePlanetDots(canvas: SkCanvas, paint: SkPaint, dots: readonly PlanetMarkDot[], ink?: string) {
    for (const dot of dots) {
        paint.setColor(ink ? Skia.Color(ink) : new Float32Array([(dot.rgb[0] | 0) / 255, (dot.rgb[1] | 0) / 255, (dot.rgb[2] | 0) / 255, 1]));
        paint.setAlphaf(dot.opacity);
        canvas.drawCircle(dot.x, dot.y, dot.r, paint);
    }
}
