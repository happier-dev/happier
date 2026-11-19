import { AlphaType, ColorType, FilterMode, MipmapMode, Skia, makeImageFromView, type SkImage } from '@shopify/react-native-skia';
import type { View } from 'react-native';
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
    const [cellWidth, cellHeight] = grid.cell;
    const { cols: width, rows: height } = grid;
    const surface = Skia.Surface.Make(width, height);
    if (!surface) return undefined;
    try {
        surface.getCanvas().drawImageRectOptions(image,
            Skia.XYWHRect(0, 0, image.width(), image.height()),
            Skia.XYWHRect(rect.x / cellWidth, rect.y / cellHeight,
                rect.width / cellWidth, rect.height / cellHeight),
            FilterMode.Linear, MipmapMode.None);
        const small = surface.makeImageSnapshot();
        try {
            const pixels = small.readPixels(0, 0, { width, height, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul });
            return pixels instanceof Uint8Array ? { rgba: pixels, cols: width, rows: height } : undefined;
        } finally {
            small.dispose();
        }
    } finally {
        surface.dispose();
    }
}
