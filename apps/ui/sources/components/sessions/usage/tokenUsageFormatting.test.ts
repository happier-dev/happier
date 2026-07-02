import { describe, expect, it } from 'vitest';

import {
    formatTokenUsageCount,
    resolveTokenUsageProgressRatio,
} from './tokenUsageFormatting';

describe('token usage formatting', () => {
    it('formats token counts for compact usage displays', () => {
        expect(formatTokenUsageCount(999)).toBe('999');
        expect(formatTokenUsageCount(1_250)).toBe('1.3k');
        expect(formatTokenUsageCount(125_000)).toBe('125k');
        expect(formatTokenUsageCount(1_250_000)).toBe('1.3M');
    });

    it('clamps progress ratios while preserving numeric display responsibility for callers', () => {
        expect(resolveTokenUsageProgressRatio({ used: 125, limit: 100 })).toBe(1);
        expect(resolveTokenUsageProgressRatio({ used: -10, limit: 100 })).toBe(0);
        expect(resolveTokenUsageProgressRatio({ used: 50, limit: 0 })).toBe(0);
        expect(resolveTokenUsageProgressRatio({ used: 50, limit: null })).toBe(0);
    });
});
