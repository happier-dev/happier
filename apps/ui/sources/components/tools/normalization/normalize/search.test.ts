import { describe, expect, it } from 'vitest';

import { normalizeCodeSearchResultForRendering } from './search';

describe('normalizeCodeSearchResultForRendering', () => {
    it('normalizes grouped line search text into structured matches', () => {
        expect(normalizeCodeSearchResultForRendering([
            '2 matches',
            'sources/a.ts:',
            '  Line 12: export const value = 1;',
            'sources/b.ts:',
            '  Line 20: return value;',
        ].join('\n'))).toEqual({
            matches: [
                { filePath: 'sources/a.ts', line: 12, excerpt: 'export const value = 1;' },
                { filePath: 'sources/b.ts', line: 20, excerpt: 'return value;' },
            ],
        });
    });

    it('falls back to plain line excerpts for ungrouped search output', () => {
        expect(normalizeCodeSearchResultForRendering([
            'plain result one',
            'plain result two',
        ].join('\n'))).toEqual({
            matches: [
                { excerpt: 'plain result one' },
                { excerpt: 'plain result two' },
            ],
        });
    });
});
