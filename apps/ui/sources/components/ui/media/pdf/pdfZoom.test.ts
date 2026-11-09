import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePdfScale, resolvePdfCanvasSize, anchorPdfZoom, readPdfViewport, resolvePdfDoubleTapZoom, clampPdfScale } from './pdfZoom';

describe('PDF zoom', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('resolves fit modes and presets while applying canvas bounds only to raster density', () => {
        const geometry = { pageWidth: 600, pageHeight: 800, viewportWidth: 1200, viewportHeight: 600 };
        expect(resolvePdfScale('fit-width', geometry)).toBe(1.6);
        expect(resolvePdfScale('fit-page', geometry)).toBe(0.75);
        expect(resolvePdfScale(0.1, geometry)).toBe(0.1);
        expect(resolvePdfScale(6, geometry)).toBe(6);
        const canvas = resolvePdfCanvasSize({ width: 3000, height: 6000, devicePixelRatio: 3 });
        expect(canvas.width * canvas.height).toBeLessThanOrEqual(2 ** 25);
        expect(canvas.width * canvas.height).toBeGreaterThan((2 ** 25) * 0.999);
    });
    it.each([
        { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 },
        { userAgent: 'Mozilla/5.0 (Linux; Android 15)', platform: 'Linux armv8l', maxTouchPoints: 5 },
        { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel', maxTouchPoints: 5 },
    ])('keeps a phone/tablet portrait page at zoom 4 within pdf.js’s mobile pixel budget: $platform', navigator => {
        vi.stubGlobal('navigator', navigator);
        const canvas = resolvePdfCanvasSize({ width: 612 * 4, height: 792 * 4, devicePixelRatio: 3 });
        expect(canvas.width * canvas.height).toBeLessThanOrEqual(5_242_880);
        expect(canvas.width * canvas.height).toBeGreaterThan(5_242_880 * 0.999);
    });
    it('uses the desktop pixel budget at zoom 4 and preserves available high-DPR detail below it', () => {
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64', maxTouchPoints: 0 });
        const canvas = resolvePdfCanvasSize({ width: 612 * 4, height: 792 * 4, devicePixelRatio: 3 });
        expect(canvas.width * canvas.height).toBeLessThanOrEqual(2 ** 25);
        expect(canvas.width * canvas.height).toBeGreaterThan((2 ** 25) * 0.999);
        expect(resolvePdfCanvasSize({ width: 612, height: 792, devicePixelRatio: 3 })).toEqual({ width: 1836, height: 2376, outputScale: 3 });
        expect(resolvePdfCanvasSize({ width: 40_000, height: 1, devicePixelRatio: 1 }).width).toBe(32767);
    });
    it('fits pages inside the padded scroll column, leaving the well visible around them', () => {
        const padding = { paddingLeft: '16px', paddingRight: '16px', paddingTop: '16px', paddingBottom: '16px' };
        const column = { clientWidth: 600, clientHeight: 754, ownerDocument: { defaultView: { getComputedStyle: () => padding } } };
        const scale = resolvePdfScale('fit-width', { pageWidth: 612, pageHeight: 792, ...readPdfViewport(column) });
        expect(612 * scale).toBe(568);
    });
    it('keeps the page point under the pointer when the pages grow past their fixed padding', () => {
        const flush = { left: 0, top: 0 };
        expect(anchorPdfZoom({ scrollLeft: 100, scrollTop: 300, pointerX: 50, pointerY: 75, ratio: 2, before: flush, after: flush }))
            .toEqual({ left: 250, top: 675 });
        // The first page starts 16px in and stays 16px in: a point 20px into it stays 20px into it, 40px at double scale.
        expect(anchorPdfZoom({ scrollLeft: 0, scrollTop: 0, pointerX: 36, pointerY: 36, ratio: 2, before: { left: 16, top: 16 }, after: { left: 16, top: 16 } }))
            .toEqual({ left: 20, top: 20 });
    });
    it('clamps a pinched scale to the zoom menu range, widened only when the fit scale is smaller', () => {
        expect(clampPdfScale(9, 0.6)).toBe(4);
        expect(clampPdfScale(0.1, 0.6)).toBe(0.5);
        expect(clampPdfScale(0.1, 0.3)).toBe(0.3);
        expect(clampPdfScale(1.7, 0.6)).toBe(1.7);
    });
    it('toggles a double tap between fit width and 200%', () => {
        expect(resolvePdfDoubleTapZoom(0.585, 0.585)).toBe(2);
        expect(resolvePdfDoubleTapZoom(0.5852, 0.585)).toBe(2);
        expect(resolvePdfDoubleTapZoom(2, 0.585)).toBe('fit-width');
        expect(resolvePdfDoubleTapZoom(1.25, 0.585)).toBe('fit-width');
    });
});
