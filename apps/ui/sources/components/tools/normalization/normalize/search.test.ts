import { describe, expect, it } from 'vitest';

import {
    normalizeCodeSearchResultForRendering,
    normalizeGrepResultForRendering,
} from './search';

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

    it('upgrades only the exact cli-v0.2.1 CodeSearch aggregate shape', () => {
        // Immutable provenance:
        // cli-v0.2.1@b1d15a8a9c241737d1ca9b167459901e6259173a
        // normalizeCodeSearchResult preserved aggregate fields and always added matches: [].
        expect(normalizeCodeSearchResultForRendering({
            matches: [],
            totalMatches: 4,
            truncated: false,
        })).toEqual({
            matches: [],
            totalMatches: 4,
            truncated: false,
            detailsUnavailable: true,
        });
        expect(normalizeCodeSearchResultForRendering({ matches: [], totalMatches: 0 })).toBeNull();
        expect(normalizeCodeSearchResultForRendering({ totalMatches: 4 })).toBeNull();
        expect(normalizeGrepResultForRendering({ matches: [], totalMatches: 4 })).toBeNull();
    });
});
