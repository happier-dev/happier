import { describe, expect, it } from 'vitest';

import { resolveModalCardDimensions } from './useModalCardDimensions';

describe('resolveModalCardDimensions', () => {
    it('falls back to a non-zero width when window dimensions are not yet available', () => {
        const dimensions = resolveModalCardDimensions(
            { width: 0, height: 0 },
            { size: 'md', width: 500 },
        );

        expect(dimensions.width).toBe(500);
        expect(dimensions.maxHeight).toBeGreaterThan(0);
    });

    it('supports tighter viewport margins for mobile-sized modal cards', () => {
        const dimensions = resolveModalCardDimensions(
            { width: 441, height: 956 },
            {
                size: 'lg',
                width: 560,
                maxHeightRatio: 0.96,
                viewportMargin: { horizontal: 12, vertical: 12 },
            },
        );

        expect(dimensions).toEqual({
            width: 417,
            maxHeight: 860,
        });
    });
});
