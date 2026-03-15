import { describe, expect, it } from 'vitest';

import { resolveInlineDiffVirtualization } from './resolveInlineDiffVirtualization';

describe('resolveInlineDiffVirtualization', () => {
    it('returns false when threshold is non-positive', () => {
        expect(resolveInlineDiffVirtualization({ unifiedDiff: 'a\nb\n', oldText: null, newText: null, lineThreshold: 0 })).toBe(false);
        expect(resolveInlineDiffVirtualization({ unifiedDiff: 'a\nb\n', oldText: null, newText: null, lineThreshold: -1 })).toBe(false);
    });

    it('virtualizes unified diffs above the threshold', () => {
        const unifiedDiff = ['a', 'b', 'c', 'd', 'e', ''].join('\n');
        expect(resolveInlineDiffVirtualization({ unifiedDiff, oldText: null, newText: null, lineThreshold: 4 })).toBe(true);
        expect(resolveInlineDiffVirtualization({ unifiedDiff, oldText: null, newText: null, lineThreshold: 10 })).toBe(false);
    });

    it('virtualizes unified diffs above the byte threshold even when line count is below the line threshold', () => {
        const unifiedDiff = 'a'.repeat(2_000);
        expect(resolveInlineDiffVirtualization({
            unifiedDiff,
            oldText: null,
            newText: null,
            lineThreshold: 100,
            byteThreshold: 100,
        })).toBe(true);
    });

    it('virtualizes text diffs when either side is above the threshold', () => {
        const oldText = ['1', '2', '3', '4', '5', ''].join('\n');
        const newText = ['a', ''].join('\n');
        expect(resolveInlineDiffVirtualization({ unifiedDiff: null, oldText, newText, lineThreshold: 4 })).toBe(true);
        expect(resolveInlineDiffVirtualization({ unifiedDiff: null, oldText, newText, lineThreshold: 10 })).toBe(false);
    });

    it('virtualizes text diffs above the byte threshold even when line count is below the line threshold', () => {
        const oldText = 'a'.repeat(2_000);
        const newText = 'b';
        expect(resolveInlineDiffVirtualization({
            unifiedDiff: null,
            oldText,
            newText,
            lineThreshold: 100,
            byteThreshold: 100,
        })).toBe(true);
    });
});
