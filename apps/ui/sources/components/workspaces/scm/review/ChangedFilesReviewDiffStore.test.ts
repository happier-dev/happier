import { describe, expect, it, vi } from 'vitest';

import { createChangedFilesReviewDiffStateSource } from './ChangedFilesReviewDiffStore';

describe('createChangedFilesReviewDiffStateSource', () => {
    it('publishes nothing and keeps the state identity when a refetch writes an equal diff state', () => {
        const source = createChangedFilesReviewDiffStateSource();
        source.setDiffState('a.ts', { status: 'loaded', diff: '@@ -1 +1 @@\n-a\n+b\n', error: null, context: { status: 'loaded', baseText: 'a' } });
        const first = source.getDiffState('a.ts');
        const snapshot = source.getSnapshot();
        const all = vi.fn();
        const one = vi.fn();
        source.subscribeAll(all);
        source.subscribe('a.ts', one);

        source.setDiffState('a.ts', { status: 'loaded', diff: '@@ -1 +1 @@\n-a\n+b\n', error: null, context: { status: 'loaded', baseText: 'a' } });
        source.updateDiffState('a.ts', previous => ({ ...previous }));

        expect(all).not.toHaveBeenCalled();
        expect(one).not.toHaveBeenCalled();
        expect(source.getDiffState('a.ts')).toBe(first);
        expect(source.getSnapshot()).toBe(snapshot);
    });

    it('still publishes when the diff text changes', () => {
        const source = createChangedFilesReviewDiffStateSource();
        source.setDiffState('a.ts', { status: 'loaded', diff: 'one', error: null });
        const one = vi.fn();
        source.subscribe('a.ts', one);

        source.setDiffState('a.ts', { status: 'loaded', diff: 'two', error: null });

        expect(one).toHaveBeenCalledTimes(1);
        expect(source.getDiffState('a.ts').diff).toBe('two');
    });
});
