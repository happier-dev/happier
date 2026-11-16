import * as React from 'react';

type CanvasSurface = { width: number; height: number };

/**
 * Frees a canvas's pixel buffer now. A dropped canvas keeps its buffer until a garbage collection, and on
 * WebKit (desktop) that buffer is a GPU-process surface the JS heap never feels, so the collection does not
 * come: every remount left its full-size buffers behind. Zero size is the platform's own release.
 */
export function releaseCanvasBackingStore(canvas: CanvasSurface | null | undefined): void {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
}

/**
 * Releases the mounted canvas's pixel buffer whenever its owner's effects go away: unmount, and also a
 * hidden `<Activity>` (or StrictMode's rehearsal), after which the size is given back before the owner's
 * later drawing effects repaint. Declare it before those drawing effects.
 */
export function useCanvasBackingStoreRelease(ref: React.RefObject<CanvasSurface | null>, pixelWidth: number, pixelHeight: number): void {
    React.useLayoutEffect(() => {
        const canvas = ref.current;
        if (canvas && (canvas.width !== pixelWidth || canvas.height !== pixelHeight)) {
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
        }
        return () => releaseCanvasBackingStore(canvas);
    }, [ref, pixelWidth, pixelHeight]);
}
