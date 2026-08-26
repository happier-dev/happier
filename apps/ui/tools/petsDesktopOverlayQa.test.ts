import { describe, expect, it } from 'vitest';

import { buildOutsideSamplePoints } from '../scripts/qa/petsDesktopOverlayQa';

describe('petsDesktopOverlayQa outside sampling', () => {
    it('omits off-canvas samples instead of clamping them into edge-touching pet bounds', () => {
        const image = { width: 390, height: 844 };

        expect(buildOutsideSamplePoints(image, {
            x: 0,
            y: 0,
            width: 92,
            height: 100,
        })).toEqual([
            { x: 94, y: 50 },
            { x: 46, y: 102 },
        ]);

        expect(buildOutsideSamplePoints(image, {
            x: 298,
            y: 744,
            width: 92,
            height: 100,
        })).toEqual([
            { x: 296, y: 742 },
            { x: 296, y: 794 },
        ]);
    });
});
