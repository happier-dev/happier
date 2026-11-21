import { describe, expect, it } from 'vitest';

import { selectPullRequestReviewPaths } from './pullRequestReviewRules.js';

describe('review rule ignore paths', () => {
    it('matches a single segment with *', () => {
        expect(selectPullRequestReviewPaths([
            'docs/readme.md', 'docs/internal/notes.md', 'docs/readme.txt', 'src/readme.md',
        ], ['docs/*.md'])).toEqual(['docs/internal/notes.md', 'docs/readme.txt', 'src/readme.md']);
    });

    it('matches zero or more nested directories with **', () => {
        expect(selectPullRequestReviewPaths([
            'generated.ts', 'packages/generated.ts', 'packages/ui/generated.ts', 'src/generated.tsx',
        ], ['**/generated.ts'])).toEqual(['src/generated.tsx']);
        expect(selectPullRequestReviewPaths([
            'dist/index.js', 'dist/js/index.js', 'dist-old/index.js',
        ], ['dist/**'])).toEqual(['dist-old/index.js']);
    });

    it('matches one character with ? and treats regular expression punctuation literally', () => {
        expect(selectPullRequestReviewPaths([
            'pkg(v1).ts', 'pkg(v20).ts', 'pkg(v/).ts', 'pkg(v2)Xts',
        ], ['pkg(v?).ts'])).toEqual(['pkg(v20).ts', 'pkg(v/).ts', 'pkg(v2)Xts']);
    });
});
