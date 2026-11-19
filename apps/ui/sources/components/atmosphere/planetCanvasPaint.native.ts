import { BlendMode, Skia, type SkCanvas, type SkTypeface } from '@shopify/react-native-skia';
import type { PlanetScene } from '@happier-dev/brand/planet';

/**
 * The existing native planet composition; shared by the scene canvas and moment layers.
 * Takes the typefaces themselves: Skia 2.4.18's `SkFont.getTypeface()` adopts the font's borrowed
 * typeface without a reference, so its collected wrappers free the face under recorded pictures.
 */
export function paintNativePlanetMark(canvas: SkCanvas, scene: PlanetScene, regular: SkTypeface | null, strong: SkTypeface | null, ink?: string) {
    const paint = Skia.Paint(); paint.setAntiAlias(true);
    const dots = (list: typeof scene.body) => {
        for (const dot of list) {
            paint.setColor(ink ? Skia.Color(ink) : new Float32Array([(dot.rgb[0] | 0) / 255, (dot.rgb[1] | 0) / 255, (dot.rgb[2] | 0) / 255, 1]));
            paint.setAlphaf(dot.opacity); canvas.drawCircle(dot.x, dot.y, dot.r, paint);
        }
    };
    const cells = (over: boolean) => {
        for (const cell of scene.cells) {
            if (cell.over !== over) continue;
            const typeface = over ? strong : regular;
            if (!typeface) throw new Error('Atmosphere mono typeface is unavailable');
            const font = Skia.Font(typeface, Number(cell.fs.toFixed(2)));
            // Native Skia 2.4.18 reads a JSI number despite its shared boolean declaration.
            font.setEmbolden(Number(over && cell.cut) as unknown as boolean);
            paint.setColor(new Float32Array([Math.round(cell.rgb[0]) / 255, Math.round(cell.rgb[1]) / 255, Math.round(cell.rgb[2]) / 255, over ? Math.min(1, cell.a * (cell.cut ? 1.6 : 3.2)) : cell.a]));
            paint.setBlendMode(over && !cell.cut ? BlendMode.SrcATop : BlendMode.SrcOver);
            const metrics = font.getMetrics();
            canvas.drawText(cell.ch, cell.x - font.getGlyphWidths(font.getGlyphIDs(cell.ch))[0] / 2, cell.y - (metrics.ascent + metrics.descent) / 2, paint, font);
            font.dispose();
        }
        paint.setBlendMode(BlendMode.SrcOver);
    };
    canvas.saveLayer(); dots(scene.body); cells(true); canvas.restore(); dots(scene.haze); cells(false);
    paint.dispose();
}
