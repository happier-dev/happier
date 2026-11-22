/** @vitest-environment jsdom */
import { expect, it, vi } from 'vitest';

import { paintStepInk } from './paintStepInk.web';

it('samples nested QR ink without resolving CSS for the SVG modules', () => {
    const step = document.createElement('div');
    step.innerHTML = '<svg data-qr-ink><rect width="24" height="24"/><path d="M1 1h1v1Z"/><path d="M2 2h1v1Z"/></svg>';
    const qr = step.querySelector('svg')!;
    // jsdom implements the SVG tree but has no view-box geometry or 2D canvas renderer.
    Object.defineProperty(qr, 'viewBox', { value: { baseVal: { x: 0, y: 0, width: 24, height: 24 } } });
    const canvas = {
        fill: vi.fn(), save: vi.fn(), restore: vi.fn(), scale: vi.fn(), translate: vi.fn(),
        getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4 * 8 * 4).fill(40) })),
    };
    vi.stubGlobal('CanvasRenderingContext2D', class {});
    vi.stubGlobal('Path2D', class {});
    const canvasPrototype: { getContext(contextId: '2d'): CanvasRenderingContext2D | null } =
        HTMLCanvasElement.prototype;
    const context = vi.spyOn(canvasPrototype, 'getContext').mockReturnValue(
        canvas as unknown as CanvasRenderingContext2D,
    );
    const style = vi.spyOn(window, 'getComputedStyle');
    const measure = vi.fn(() => ({ x: 0, y: 0, width: 8, height: 16 }));
    try {
        const ink = paintStepInk([...step.querySelectorAll<HTMLElement>('*')], measure,
            { width: 8, height: 16, cols: 1, rows: 1, cell: [8, 16] });

        expect(style.mock.calls.map(([element]) => element)).toEqual([qr]);
        expect(measure).toHaveBeenCalledExactlyOnceWith(qr);
        expect(canvas.fill).toHaveBeenCalledTimes(2);
        expect(canvas.getImageData).toHaveBeenCalledExactlyOnceWith(0, 0, 4, 8);
        expect(ink?.rgba).toEqual(Uint8Array.of(0, 0, 0, 120));
    } finally {
        style.mockRestore();
        context.mockRestore();
        vi.unstubAllGlobals();
    }
});
