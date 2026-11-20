import * as React from 'react';
import { PixelRatio } from 'react-native';
import { BlendMode, Canvas, Picture, Skia, createPicture, useTypeface, type SkCanvas, type SkTypeface } from '@shopify/react-native-skia';
import { createPlanetScene, type PlanetScene, type PlanetSceneOptions } from '@happier-dev/brand/planet';

import { paintNativePlanetDots } from '@/components/atmosphere/planetCanvasPaintDots.native';
import { snapCanvasBox } from '@/components/ui/media/canvasBackingStore';

/** Static artwork for the public SceneArt style, fullness and digits choices. */
export function SceneArtAuthoredPlanet({ options }: Readonly<{ options: PlanetSceneOptions }>) {
    const regular = useTypeface(require('@/assets/fonts/IBMPlexMono-Regular.ttf'));
    const strong = useTypeface(require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'));
    const dpr = PixelRatio.get();
    const box = snapCanvasBox(options.view.w, options.view.h, dpr);
    const scene = React.useMemo(() => createPlanetScene({ ...options, dpr }), [dpr, options]);
    const picture = React.useMemo(() => {
        if (scene.cells.length && (!regular || !strong)) return null;
        return createPicture(canvas => paintNativeSceneArtPlanet(canvas, scene, regular, strong), { width: box.width, height: box.height });
    }, [box.height, box.width, regular, scene, strong]);
    React.useEffect(() => () => { picture?.dispose(); }, [picture]);
    return <Canvas pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: box.width, height: box.height }}>
        {picture ? <Picture picture={picture} /> : null}
    </Canvas>;
}

/** Use the loaded typefaces directly. Skia 2.4.18's getTypeface adopts and can free a borrowed reference. */
export function paintNativeSceneArtPlanet(canvas: SkCanvas, scene: PlanetScene, regular: SkTypeface | null, strong: SkTypeface | null) {
    const paint = Skia.Paint(); paint.setAntiAlias(true);
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
    canvas.saveLayer();
    paintNativePlanetDots(canvas, paint, scene.body);
    cells(true);
    canvas.restore();
    paintNativePlanetDots(canvas, paint, scene.haze);
    cells(false);
    paint.dispose();
}
