import { describe, expect, it } from 'vitest';

import { buildCommitSelectionPathHints, countCommitSelectionItems } from './commitSelectionHints';

describe('commitSelectionHints', () => {
    it('dedupes and normalizes paths from selections and patches', () => {
        const hints = buildCommitSelectionPathHints({
            commitSelectionPaths: [' a.txt', 'a.txt', '', '  '],
            commitSelectionPatches: [
                { path: 'b.txt', patch: '...' },
                { path: ' b.txt ', patch: '...' },
                { path: '', patch: '...' },
            ],
        });

        expect(hints).toEqual(['a.txt', 'b.txt']);
    });

    it('counts unique selection items', () => {
        expect(
            countCommitSelectionItems({
                commitSelectionPaths: ['a.txt', ' a.txt ', ''],
                commitSelectionPatches: [
                    { path: 'b.txt', patch: '...' },
                    { path: 'b.txt', patch: '...' },
                ],
            })
        ).toBe(2);
    });
});
