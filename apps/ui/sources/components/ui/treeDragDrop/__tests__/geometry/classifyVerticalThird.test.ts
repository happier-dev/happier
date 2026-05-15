import { describe, expect, it } from 'vitest';

import { classifyVerticalThird } from '../../geometry/classifyVerticalThird';

describe('classifyVerticalThird', () => {
    it('classifies exact one-third boundaries deterministically', async () => {
        expect(classifyVerticalThird).toEqual(expect.any(Function));

        const bounds = { x: 0, y: 90, width: 100, height: 30 };

        expect(classifyVerticalThird(bounds, { x: 10, y: 99.99 })).toBe('top');
        expect(classifyVerticalThird(bounds, { x: 10, y: 100 })).toBe('middle');
        expect(classifyVerticalThird(bounds, { x: 10, y: 109.99 })).toBe('middle');
        expect(classifyVerticalThird(bounds, { x: 10, y: 110 })).toBe('bottom');
    });
});
