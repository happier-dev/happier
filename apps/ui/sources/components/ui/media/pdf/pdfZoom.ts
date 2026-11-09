export const PDF_ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export type PdfZoom = 'fit-width' | 'fit-page' | number;

/** Pinch stays inside the zoom menu's range; a page fitted smaller than the lowest preset may still be pinched back to its fit. */
export const PDF_ZOOM_MIN = PDF_ZOOM_PRESETS[0];
export const PDF_ZOOM_MAX = PDF_ZOOM_PRESETS[PDF_ZOOM_PRESETS.length - 1]!;
/** Double tap alternates between the fit and this scale (P2 §3.7). */
export const PDF_DOUBLE_TAP_SCALE = 2;
type Geometry = Readonly<{ pageWidth: number; pageHeight: number; viewportWidth: number; viewportHeight: number }>;

// pdfjs-dist 6.4.299, web/pdf_viewer.mjs AppOptions: maxCanvasPixels and
// maxCanvasDim are private, not exported. Keep its defaults and iOS/Android
// detection here; these bound raster backing, never page layout or text.
const PDF_CANVAS_MAX_DIM = 32767;
export const PDF_FIT_WIDTH_MAX = 960;

export function resolvePdfScale(zoom: PdfZoom, geometry: Geometry): number {
    if (typeof zoom === 'number') return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const widthScale = Math.min(PDF_FIT_WIDTH_MAX, geometry.viewportWidth) / geometry.pageWidth;
    return zoom === 'fit-width' ? widthScale : Math.min(widthScale, geometry.viewportHeight / geometry.pageHeight);
}

type PdfScrollColumn = Readonly<{
    clientWidth: number;
    clientHeight: number;
    ownerDocument?: Readonly<{ defaultView?: Readonly<{ getComputedStyle: (element: never) => Readonly<Record<'paddingLeft' | 'paddingRight' | 'paddingTop' | 'paddingBottom', string>> }> | null }> | null;
}>;

/** The room pages have in the scroll column: its client box minus the padding that shows the well around them. */
export function readPdfViewport(column: PdfScrollColumn): Readonly<{ viewportWidth: number; viewportHeight: number }> {
    const style = column.ownerDocument?.defaultView?.getComputedStyle(column as never);
    const px = (value: string | undefined) => Number.parseFloat(value ?? '') || 0;
    return {
        viewportWidth: Math.max(1, column.clientWidth - px(style?.paddingLeft) - px(style?.paddingRight)),
        viewportHeight: Math.max(1, column.clientHeight - px(style?.paddingTop) - px(style?.paddingBottom)),
    };
}

export function resolvePdfCanvasSize(input: Readonly<{ width: number; height: number; devicePixelRatio: number }>) {
    const platform = globalThis.navigator;
    const mobile = /Android/.test(platform?.userAgent ?? '')
        || /\b(?:iPad|iPhone|iPod)(?=;)/.test(platform?.userAgent ?? '')
        || (platform?.platform === 'MacIntel' && platform.maxTouchPoints > 1);
    const maxCanvasPixels = mobile ? 5_242_880 : 2 ** 25;
    const outputScale = Math.min(input.devicePixelRatio,
        Math.sqrt(maxCanvasPixels / (input.width * input.height)),
        PDF_CANVAS_MAX_DIM / Math.max(input.width, input.height));
    return { width: Math.max(1, Math.floor(input.width * outputScale)), height: Math.max(1, Math.floor(input.height * outputScale)), outputScale };
}

/**
 * Keeps the page point under the pointer fixed across a re-layout. Page edges sit at a fixed offset (the well's padding, the gap
 * between pages) that does not scale, so the anchor is the page under the pointer: its offset before and after the resize, not the origin.
 */
export function anchorPdfZoom(input: Readonly<{
    scrollLeft: number; scrollTop: number; pointerX: number; pointerY: number; ratio: number;
    before: Readonly<{ left: number; top: number }>; after: Readonly<{ left: number; top: number }>;
}>) {
    return {
        left: (input.scrollLeft + input.pointerX - input.before.left) * input.ratio + input.after.left - input.pointerX,
        top: (input.scrollTop + input.pointerY - input.before.top) * input.ratio + input.after.top - input.pointerY,
    };
}

export function clampPdfScale(scale: number, fitScale: number): number {
    return Math.min(PDF_ZOOM_MAX, Math.max(Math.min(PDF_ZOOM_MIN, fitScale), scale));
}

/** From the fit a double tap zooms in; from anywhere else it returns to the fit width, which stays a mode that follows the column. */
export function resolvePdfDoubleTapZoom(scale: number, fitScale: number): 'fit-width' | typeof PDF_DOUBLE_TAP_SCALE {
    return Math.abs(scale - fitScale) <= fitScale * 0.01 ? PDF_DOUBLE_TAP_SCALE : 'fit-width';
}
