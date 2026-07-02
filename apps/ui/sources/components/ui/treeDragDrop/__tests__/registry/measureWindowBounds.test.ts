import { describe, expect, it } from 'vitest';

import { measureWindowBounds } from '../../registry/measureWindowBounds';

describe('measureWindowBounds', () => {
    it('reads window bounds synchronously from getBoundingClientRect when the ref exposes a DOM element', async () => {
        expect(measureWindowBounds).toEqual(expect.any(Function));

        // The web ref reads from the same DOM clock as scrollTop: no async lag.
        await expect(measureWindowBounds({
            getBoundingClientRectFn: () => ({ x: 12, y: 34, width: 320, height: 56 }),
        })).resolves.toEqual({ x: 12, y: 34, width: 320, height: 56 });
    });

    it('prefers the synchronous web path over the async measureInWindow fallback when both are present', async () => {
        let measureInWindowCalled = false;
        await expect(measureWindowBounds({
            getBoundingClientRectFn: () => ({ x: 1, y: 2, width: 3, height: 4 }),
            measureInWindow: (callback) => {
                measureInWindowCalled = true;
                callback(99, 99, 99, 99);
            },
        })).resolves.toEqual({ x: 1, y: 2, width: 3, height: 4 });
        expect(measureInWindowCalled).toBe(false);
    });

    it('falls back to the async native measureInWindow path when no DOM element is exposed', async () => {
        await expect(measureWindowBounds({
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                callback(11, 22, 333, 44);
            },
        })).resolves.toEqual({ x: 11, y: 22, width: 333, height: 44 });
    });

    it('rejects invalid bounds from the synchronous web path', async () => {
        await expect(measureWindowBounds({
            getBoundingClientRectFn: () => ({ x: Number.NaN, y: 34, width: 320, height: 56 }),
        })).resolves.toBeNull();
        await expect(measureWindowBounds({
            getBoundingClientRectFn: () => ({ x: 12, y: 34, width: -1, height: 56 }),
        })).resolves.toBeNull();
    });

    it('rejects invalid bounds from the async native path and never accepts layout-relative fallback bounds', async () => {
        await expect(measureWindowBounds({
            measureInWindow: (callback) => {
                callback(12, 34, Number.POSITIVE_INFINITY, 56);
            },
        })).resolves.toBeNull();

        const layoutOnlyRef: {
            measureInWindow?: undefined;
            measure: (callback: (x: number, y: number, width: number, height: number) => void) => void;
        } = {
            measure: (callback: (x: number, y: number, width: number, height: number) => void) => {
                callback(1, 2, 3, 4);
            },
        };
        await expect(measureWindowBounds(layoutOnlyRef)).resolves.toBeNull();
        await expect(measureWindowBounds(null)).resolves.toBeNull();
    });
});
