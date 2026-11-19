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
        get ink() { return sampleRegion(image, rect, grid); },
        release: () => image.dispose(),
    };
}

function sampleRegion(image: SkImage, rect: StepFreeze['rect'], grid: StepGrid) {
    const [cellWidth, cellHeight] = grid.cell;
    const left = Math.floor(rect.x / cellWidth);
    const top = Math.floor(rect.y / cellHeight);
    const width = Math.ceil((rect.x + rect.width) / cellWidth) - left;
    const height = Math.ceil((rect.y + rect.height) / cellHeight) - top;
    const surface = Skia.Surface.Make(width, height);
    if (!surface) return undefined;
    try {
        surface.getCanvas().drawImageRectOptions(image,
            Skia.XYWHRect(0, 0, image.width(), image.height()),
            Skia.XYWHRect(rect.x / cellWidth - left, rect.y / cellHeight - top,
                rect.width / cellWidth, rect.height / cellHeight),
            FilterMode.Linear, MipmapMode.None);
        const small = surface.makeImageSnapshot();
        try {
            const pixels = small.readPixels(0, 0, { width, height, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul });
            if (!(pixels instanceof Uint8Array)) return undefined;
            const rgba = new Uint8Array(grid.cols * grid.rows * 4);
            for (let row = Math.max(0, -top); row < Math.min(height, grid.rows - top); row++) {
                const start = Math.max(0, -left);
                const end = Math.min(width, grid.cols - left);
                if (start >= end) continue;
                rgba.set(pixels.subarray((row * width + start) * 4, (row * width + end) * 4),
                    ((row + top) * grid.cols + left + start) * 4);
            }
            return { rgba, cols: grid.cols, rows: grid.rows };
        } finally {
            small.dispose();
        }
    } finally {
        surface.dispose();
    }
}
