import { describe, expect, it } from 'vitest';

import { measureWindowBounds } from '../../registry/measureWindowBounds';

describe('measureWindowBounds', () => {
    it('returns measureInWindow bounds and never accepts layout-relative fallback bounds', async () => {
        expect(measureWindowBounds).toEqual(expect.any(Function));

        await expect(measureWindowBounds({
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                callback(11, 22, 333, 44);
            },
        })).resolves.toEqual({ x: 11, y: 22, width: 333, height: 44 });

        const layoutOnlyRef: {
            measureInWindow?: undefined;
            measure: (callback: (x: number, y: number, width: number, height: number) => void) => void;
        } = {
            measure: (callback: (x: number, y: number, width: number, height: number) => void) => {
                callback(1, 2, 3, 4);
            },
        };
        await expect(measureWindowBounds(layoutOnlyRef)).resolves.toBeNull();
    });
});
