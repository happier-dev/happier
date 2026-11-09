import { describe, expect, it } from 'vitest';

import { summarizeScmChanges } from './changeCounting.js';

describe('summarizeScmChanges', () => {
    it('counts one file per changed path without directory rows and leaves media lines out of the totals', () => {
        const summary = summarizeScmChanges([
            { path: 'src/a.ts', hasIncludedDelta: true, hasPendingDelta: true, stats: { includedAdded: 2, pendingAdded: 3, pendingRemoved: 1 } },
            { path: 'docs/guide.PDF', hasPendingDelta: true, stats: { pendingAdded: 40, pendingRemoved: 10 } },
            { path: 'build\\', hasPendingDelta: true },
            { path: 'scratch/', hasPendingDelta: true },
            { path: 'logo.png', hasPendingDelta: true, stats: { isBinary: true } },
            { path: 'clean.txt' },
        ], { includedAdded: 2, includedRemoved: 0, pendingAdded: 43, pendingRemoved: 11 });
        expect(summary).toEqual({ changedFiles: 3, includedAdded: 2, includedRemoved: 0, pendingAdded: 3, pendingRemoved: 1 });
    });
});
