import { describe, expect, it } from 'vitest';

import { resolveHorizontalChartInitialOffset } from './resolveHorizontalChartInitialOffset';

describe('resolveHorizontalChartInitialOffset', () => {
    it('returns the trailing overflow amount when content exceeds the viewport', () => {
        expect(resolveHorizontalChartInitialOffset({
            contentWidth: 920,
            viewportWidth: 640,
        })).toBe(280);
    });

    it('returns zero when the content fits within the viewport', () => {
        expect(resolveHorizontalChartInitialOffset({
            contentWidth: 520,
            viewportWidth: 640,
        })).toBe(0);
    });
});
