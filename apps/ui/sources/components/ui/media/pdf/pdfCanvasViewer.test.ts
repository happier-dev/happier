// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPdfCanvasViewer, type PdfCanvasDocument } from './pdfCanvasViewer';

describe('PDF canvas visibility and teardown', () => {
    it('allocates only intersecting canvases, cancels renders and clears them on leave/dispose', async () => {
        let observer!: IntersectionObserverCallback;
        let disconnected = false;
        const previous = globalThis.IntersectionObserver;
        // IntersectionObserver is the genuine browser boundary; rendering below it stays real.
        globalThis.IntersectionObserver = class {
            constructor(callback: IntersectionObserverCallback) { observer = callback; }
            observe() {} unobserve() {} takeRecords() { return []; }
            disconnect() { disconnected = true; }
            root = null; rootMargin = '150%'; scrollMargin = '0px'; thresholds = [0];
        };
        let cancelled = 0;
        // pdf.js is the library boundary. The proxy exposes only methods this engine consumes.
        const documentProxy = { numPages: 3, getPage: async () => ({
            getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
            render: () => ({ promise: new Promise<void>(() => {}), cancel: () => { cancelled++; } }),
        }) } as unknown as PdfCanvasDocument;
        const container = document.createElement('div');
        document.body.appendChild(container);
        try {
            const viewer = createPdfCanvasViewer({ container, document: documentProxy, scale: 1 });
            await viewer.ready;
            expect(container.querySelectorAll('canvas')).toHaveLength(0);
            const page = container.querySelector('[data-pdf-page="2"]')!;
            observer([{ target: page, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
            await vi.waitFor(() => expect(container.querySelectorAll('canvas')).toHaveLength(1));
            observer([{ target: page, isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
            expect(cancelled).toBe(1);
            expect(container.querySelectorAll('canvas')).toHaveLength(0);
            observer([{ target: page, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
            await vi.waitFor(() => expect(container.querySelectorAll('canvas')).toHaveLength(1));
            viewer.dispose();
            expect(cancelled).toBe(2);
            expect(disconnected).toBe(true);
            expect(container.children).toHaveLength(0);
        } finally { globalThis.IntersectionObserver = previous; container.remove(); }
    });
});

describe('PDF touch zoom through the canvas engine', () => {
    type Point = readonly [number, number];
    const touch = (target: HTMLElement, type: string, touches: readonly Point[], changed: readonly Point[] = touches) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        const list = (points: readonly Point[]) => points.map(([clientX, clientY], identifier) => ({ identifier, clientX, clientY }));
        Object.defineProperty(event, 'touches', { value: list(touches) });
        Object.defineProperty(event, 'changedTouches', { value: list(changed) });
        target.dispatchEvent(event);
    };
    const previousObserver = globalThis.IntersectionObserver;
    let container: HTMLDivElement;
    let rendered: number[];
    beforeEach(() => {
        vi.useFakeTimers({ now: 5_000 });
        globalThis.IntersectionObserver = class {
            constructor(public callback: IntersectionObserverCallback) { observers.push(callback); }
            observe() {} unobserve() {} takeRecords() { return []; } disconnect() {}
            root = null; rootMargin = '150%'; scrollMargin = '0px'; thresholds = [0];
        };
        observers.length = 0; rendered = [];
        container = document.createElement('div'); document.body.appendChild(container);
    });
    afterEach(() => { globalThis.IntersectionObserver = previousObserver; container.remove(); vi.useRealTimers(); });
    const observers: IntersectionObserverCallback[] = [];
    // pdf.js is the library boundary; the engine, its slots and the touch recognizer are real.
    const documentProxy = { numPages: 2, getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
        render: ({ viewport }: { viewport: { width: number } }) => { rendered.push(viewport.width); return { promise: Promise.resolve(), cancel: () => {} }; },
    }) } as unknown as PdfCanvasDocument;
    async function open(scales: number[], zooms: unknown[] = [], fit = 1) {
        const viewer = createPdfCanvasViewer({ container, document: documentProxy, scale: 1, fitScale: () => fit,
            onScaleChange: (scale, zoom) => { scales.push(scale); zooms.push(zoom); } });
        await viewer.ready;
        observers[0]!([{ target: container.querySelector('[data-pdf-page="1"]')!, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
        await vi.waitFor(() => expect(rendered).toEqual([600]));
        return viewer;
    }
    const page = () => container.querySelector<HTMLElement>('[data-pdf-page="1"]')!;

    it('transforms the visible pages while the fingers move, then re-renders once at the settled scale about the focal point', async () => {
        const scales: number[] = []; const zooms: unknown[] = [];
        await open(scales, zooms);
        touch(container, 'touchstart', [[100, 200], [200, 200]]);
        touch(container, 'touchmove', [[50, 200], [250, 200]]);
        expect(page().style.transform).toBe('scale(2)');
        expect(page().style.width).toBe('600px');
        expect(rendered).toEqual([600]);
        touch(container, 'touchend', [], [[50, 200], [250, 200]]);
        expect(scales).toEqual([2]);
        expect(zooms).toEqual([2]);
        expect(page().style.transform).toBe('');
        expect(page().style.width).toBe('1200px');
        await vi.waitFor(() => expect(rendered).toEqual([600, 1200]));
    });
    it('keeps the pinched scale inside the zoom menu range', async () => {
        const scales: number[] = [];
        await open(scales);
        touch(container, 'touchstart', [[100, 200], [110, 200]]);
        touch(container, 'touchmove', [[0, 200], [300, 200]]);
        touch(container, 'touchend', [], [[0, 200], [300, 200]]);
        expect(scales).toEqual([4]);
    });
    it('does nothing for a pinch that returns to the starting scale', async () => {
        const scales: number[] = [];
        await open(scales);
        touch(container, 'touchstart', [[100, 200], [200, 200]]);
        touch(container, 'touchmove', [[50, 200], [250, 200]]);
        touch(container, 'touchmove', [[100, 200], [200, 200]]);
        touch(container, 'touchend', [], [[100, 200], [200, 200]]);
        expect(scales).toEqual([]);
        expect(page().style.transform).toBe('');
    });
    it('toggles fit width and 200% on double tap, remembering fit as a mode', async () => {
        const scales: number[] = []; const zooms: unknown[] = [];
        await open(scales, zooms);
        const tap = () => { touch(container, 'touchstart', [[120, 300]]); touch(container, 'touchend', [], [[120, 300]]); };
        tap(); vi.advanceTimersByTime(100); tap();
        expect(page().style.width).toBe('1200px');
        vi.advanceTimersByTime(1000);
        tap(); vi.advanceTimersByTime(100); tap();
        expect(page().style.width).toBe('600px');
        expect(scales).toEqual([2, 1]);
        expect(zooms).toEqual([2, 'fit-width']);
    });
    it('keeps Ctrl+wheel zoom reporting the scale as its own zoom', async () => {
        const scales: number[] = []; const zooms: unknown[] = [];
        await open(scales, zooms);
        const wheel = new Event('wheel', { bubbles: true, cancelable: true });
        Object.assign(wheel, { ctrlKey: true, deltaY: -100, deltaMode: 0, clientX: 0, clientY: 0 });
        container.dispatchEvent(wheel);
        expect(wheel.defaultPrevented).toBe(true);
        expect(scales).toHaveLength(1);
        expect(scales[0]).toBeGreaterThan(1);
        expect(zooms).toEqual(scales);
    });
    it('drops an unfinished pinch when the viewer is disposed', async () => {
        const scales: number[] = [];
        const viewer = await open(scales);
        touch(container, 'touchstart', [[100, 200], [200, 200]]);
        viewer.dispose();
        touch(container, 'touchmove', [[50, 200], [250, 200]]);
        touch(container, 'touchend', [], [[50, 200], [250, 200]]);
        expect(scales).toEqual([]);
    });
});
