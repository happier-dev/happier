import { describe, expect, it } from 'vitest';

import { resolveShowDiffToggle } from './resolveShowDiffToggle';

describe('resolveShowDiffToggle', () => {
    it('returns true when file has pending or included deltas', () => {
        expect(resolveShowDiffToggle({ diffContent: null, hasPendingDelta: true, hasIncludedDelta: false, fileIsBinary: false })).toBe(true);
        expect(resolveShowDiffToggle({ diffContent: null, hasPendingDelta: false, hasIncludedDelta: true, fileIsBinary: false })).toBe(true);
    });

    it('falls back to diff markers when SCM metadata is missing', () => {
        expect(resolveShowDiffToggle({ diffContent: 'diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n', hasPendingDelta: false, hasIncludedDelta: false, fileIsBinary: false })).toBe(true);
        expect(resolveShowDiffToggle({ diffContent: '@@ -1 +1 @@\n-old\n+new\n', hasPendingDelta: false, hasIncludedDelta: false, fileIsBinary: false })).toBe(true);
    });

    it('returns false when there are no changes', () => {
        expect(resolveShowDiffToggle({ diffContent: null, hasPendingDelta: false, hasIncludedDelta: false, fileIsBinary: false })).toBe(false);
        expect(resolveShowDiffToggle({ diffContent: '', hasPendingDelta: false, hasIncludedDelta: false, fileIsBinary: false })).toBe(false);
        expect(resolveShowDiffToggle({ diffContent: 'No changes', hasPendingDelta: false, hasIncludedDelta: false, fileIsBinary: false })).toBe(false);
    });

    it('returns false for binary files when no renderable unified diff is available', () => {
        expect(resolveShowDiffToggle({ diffContent: null, hasPendingDelta: true, hasIncludedDelta: false, fileIsBinary: true })).toBe(false);
        expect(resolveShowDiffToggle({ diffContent: null, hasPendingDelta: false, hasIncludedDelta: true, fileIsBinary: true })).toBe(false);
    });
});
