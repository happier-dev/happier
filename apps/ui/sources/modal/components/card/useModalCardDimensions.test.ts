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
});
