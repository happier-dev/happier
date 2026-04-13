import { describe, expect, it } from 'vitest';

import { resolveCardMasonryColumns } from './resolveCardMasonryColumns';

describe('resolveCardMasonryColumns', () => {
    it('balances taller cards across columns while preserving item order within each column', () => {
        const columns = resolveCardMasonryColumns(
            [
                { key: 'hero', weight: 4 },
                { key: 'summary-a', weight: 2 },
                { key: 'summary-b', weight: 2 },
                { key: 'poster', weight: 4 },
                { key: 'trend', weight: 3 },
                { key: 'leader', weight: 3 },
            ],
            3,
        );

        expect(columns).toEqual([
            ['hero', 'leader'],
            ['summary-a', 'poster'],
            ['summary-b', 'trend'],
        ]);
    });

    it('falls back to a single stacked column when only one column is active', () => {
        const columns = resolveCardMasonryColumns(
            [
                { key: 'one', weight: 2 },
                { key: 'two', weight: 3 },
                { key: 'three', weight: 1 },
            ],
            1,
        );

        expect(columns).toEqual([['one', 'two', 'three']]);
    });
});
