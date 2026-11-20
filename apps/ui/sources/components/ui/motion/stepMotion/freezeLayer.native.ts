import { AlphaType, ColorType, FilterMode, MipmapMode, Skia, makeImageFromView, type SkImage } from '@shopify/react-native-skia';
import type { View } from 'react-native';
import { stepInkCoverage, stepInkGrid, stepInkSampleScale } from './stepInk';
import type { StepAnchor, StepFreeze, StepGrid, StepMotionLayerHandle } from './stepMotionTypes';

/** One in-memory capture of the given native subtree. Its caller owns disposal. */
export async function captureNativeLayer(view: View): Promise<SkImage | null> {
    try {
        return await makeImageFromView({ current: view });
    } catch {
        return null;
    }
}

export async function freezeStepLayer(
    layer: StepMotionLayerHandle,
    grid: StepGrid,
    _anchor?: StepAnchor | null,
): Promise<StepFreeze | null> {
    const view = layer.nativeElement();
    const rect = view?.getBoundingClientRect?.();
    if (!view || !rect || rect.width <= 0 || rect.height <= 0) return null;
    const image = await captureNativeLayer(view);
    if (!image) return null;
    return {
        rect,
        image,
        get ink() {
            try { return sampleRegion(image, rect, grid); }
            catch { return undefined; }
        },
        release: () => image.dispose(),
    };
}

function sampleRegion(image: SkImage, rect: StepFreeze['rect'], grid: StepGrid) {
    const { width, height } = stepInkGrid(grid);
    const surface = Skia.Surface.Make(width, height);
    if (!surface) return undefined;
    try {
        surface.getCanvas().drawImageRectOptions(image,
            Skia.XYWHRect(0, 0, image.width(), image.height()),
            Skia.XYWHRect(rect.x * stepInkSampleScale, rect.y * stepInkSampleScale,
                rect.width * stepInkSampleScale, rect.height * stepInkSampleScale),
            FilterMode.Linear, MipmapMode.None);
        const small = surface.makeImageSnapshot();
        try {
            const pixels = small.readPixels(0, 0, { width, height, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul });
            if (!(pixels instanceof Uint8Array)) return undefined;
            // The edge of the capture is not a painted border. Compare pixels inside the captured region only.
            const left = Math.max(0, Math.ceil(rect.x * stepInkSampleScale));
            const top = Math.max(0, Math.ceil(rect.y * stepInkSampleScale));
            const right = Math.min(width - 1, Math.ceil((rect.x + rect.width) * stepInkSampleScale) - 1);
            const bottom = Math.min(height - 1, Math.ceil((rect.y + rect.height) * stepInkSampleScale) - 1);
            const difference = (a: number, b: number) => {
                const alphaA = pixels[a + 3];
                const alphaB = pixels[b + 3];
                return Math.max(Math.abs(alphaA - alphaB),
                    Math.abs(pixels[a] * alphaA - pixels[b] * alphaB) / 255,
                    Math.abs(pixels[a + 1] * alphaA - pixels[b + 1] * alphaB) / 255,
                    Math.abs(pixels[a + 2] * alphaA - pixels[b + 2] * alphaB) / 255);
            };
            return stepInkCoverage(grid, (x, y) => {
                if (x < left || x > right || y < top || y > bottom) return 0;
                const i = (y * width + x) * 4;
                const horizontal = (y * width + (x < right ? x + 1 : x)) * 4;
                const vertical = ((y < bottom ? y + 1 : y) * width + x) * 4;
                return Math.max(difference(i, horizontal), difference(i, vertical));
            });
        } finally {
            small.dispose();
        }
    } finally {
        surface.dispose();
    }
}
