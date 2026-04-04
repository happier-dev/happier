import { describe, expect, it } from 'vitest';

import { computeExpandedPathsForReveal } from './computeExpandedPathsForReveal';

describe('computeExpandedPathsForReveal', () => {
    it('adds directory ancestors for a file path', () => {
        expect(
            computeExpandedPathsForReveal({
                expandedPaths: [],
                fullPath: 'apps/ui/sources/index.ts',
            })
        ).toEqual(['apps', 'apps/ui', 'apps/ui/sources']);
    });

    it('preserves existing expanded paths and avoids duplicates', () => {
        expect(
            computeExpandedPathsForReveal({
                expandedPaths: ['apps', 'apps/ui'],
                fullPath: 'apps/ui/sources/index.ts',
            })
        ).toEqual(['apps', 'apps/ui', 'apps/ui/sources']);
    });

    it('returns existing paths unchanged for a root-level file', () => {
        expect(
            computeExpandedPathsForReveal({
                expandedPaths: ['apps'],
                fullPath: 'README.md',
            })
        ).toEqual(['apps']);
    });

    it('normalizes backslashes', () => {
        expect(
            computeExpandedPathsForReveal({
                expandedPaths: [],
                fullPath: 'apps\\ui\\sources\\index.ts',
            })
        ).toEqual(['apps', 'apps/ui', 'apps/ui/sources']);
    });
});
