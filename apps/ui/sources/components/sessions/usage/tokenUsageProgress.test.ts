import { describe, expect, it } from 'vitest';

import { resolveTokenUsageProgressRatio } from './tokenUsageProgress';

describe('token usage progress', () => {
    it('clamps progress ratios while preserving numeric display responsibility for callers', () => {
        expect(resolveTokenUsageProgressRatio({ used: 125, limit: 100 })).toBe(1);
        expect(resolveTokenUsageProgressRatio({ used: -10, limit: 100 })).toBe(0);
        expect(resolveTokenUsageProgressRatio({ used: 50, limit: 0 })).toBe(0);
        expect(resolveTokenUsageProgressRatio({ used: 50, limit: null })).toBe(0);
    });
});
