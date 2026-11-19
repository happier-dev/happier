import { ClipOp, Skia, type SkCanvas, type SkImage } from '@shopify/react-native-skia';
import type { createThemeHorizonGlyphSampler } from '@happier-dev/brand/planet-moments';
import { paintNativeMomentCommands, type NativeMomentEnvironment } from '@/components/atmosphere/momentPaint.native';

/** The old screenshot is the complement of Brand's incoming clip. */
export function paintNativeThemeHorizon(canvas: SkCanvas, image: SkImage, frame: ReturnType<ReturnType<typeof createThemeHorizonGlyphSampler>>, env: NativeMomentEnvironment): void {
    if (frame.clipPath !== 'none') {
        canvas.save();
        if (frame.visibility !== 'hidden') {
            const match = /^circle\(([-\d.e+]+)px at ([-\d.e+]+)px ([-\d.e+]+)px\)$/.exec(frame.clipPath);
            if (!match) throw new Error('Atmosphere Horizon clip is invalid');
            const [, radius, x, y] = match;
            const path = Skia.Path.Make();
            try { path.addCircle(Number(x), Number(y), Number(radius)); canvas.clipPath(path, ClipOp.Difference, true); }
            finally { path.dispose(); }
        }
        const paint = Skia.Paint();
        try { canvas.drawImageRect(image, Skia.XYWHRect(0, 0, image.width(), image.height()), Skia.XYWHRect(0, 0, env.w, env.h), paint); }
        finally { paint.dispose(); }
        canvas.restore();
    }
    paintNativeMomentCommands(canvas, frame.commands, env);
}
