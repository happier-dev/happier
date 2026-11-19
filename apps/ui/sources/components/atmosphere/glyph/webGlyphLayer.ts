import { createGlyphFrameSampler, type GlyphScene } from '@happier-dev/brand/glyph-scene';

import { releaseCanvasBackingStore } from '@/components/ui/media/canvasBackingStore';

import { createWebGlyphPainter, paintWebStill, warmWebGlyphAtlas } from './glyphPainter.web';

/** For composited moments with an existing clock. Its two canvases occupy the same visual layer. */
export function prepareWebGlyphLayer(
    canvas: HTMLCanvasElement,
    still: HTMLCanvasElement,
    dpr: number,
    cell: NonNullable<GlyphScene['cell']>,
    onContextChange?: () => void,
) {
    const sample = createGlyphFrameSampler();
    const painter = createWebGlyphPainter(canvas, () => onContextChange?.(), () => onContextChange?.());
    let active = true;
    let atlas: Awaited<ReturnType<typeof warmWebGlyphAtlas>> | undefined;
    const grid = { cell: [Math.round(cell[0] * dpr), Math.round(cell[1] * dpr)] as const, cols: 0, rows: 0, origin: [0, 0] as const };
    const ready = warmWebGlyphAtlas(grid, dpr).then(value => { if (active) atlas = value; });
    return {
        ready,
        get animated() { return painter.ready; },
        paint(scene: Omit<GlyphScene, 'dpr' | 'cell'>, seconds: number): HTMLCanvasElement | null {
            if (!atlas || !active) return null;
            const hasContent = scene.layers.length > 0;
            const target = painter.ready ? canvas : still;
            canvas.style.visibility = hasContent && target === canvas ? 'visible' : 'hidden';
            still.style.visibility = hasContent && target === still ? 'visible' : 'hidden';
            if (!hasContent) return null;
            const frame = sample({ ...scene, dpr, cell }, { time: seconds });
            if (target.width !== frame.width) target.width = frame.width;
            if (target.height !== frame.height) target.height = frame.height;
            if (painter.ready) painter.paint(frame, atlas);
            else paintWebStill(target, frame, atlas);
            return target;
        },
        dispose() {
            active = false;
            painter.dispose(() => !canvas.isConnected);
            releaseCanvasBackingStore(still);
        },
    };
}
