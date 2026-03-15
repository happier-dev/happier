import { describe, expect, it } from 'vitest';

import { extractUnifiedDiffForSingleFile } from './extractUnifiedDiffForSingleFile';

describe('extractUnifiedDiffForSingleFile', () => {
    it('returns only the matching file segment when patch contains multiple diffs', () => {
        const patch = [
            'diff --git a/src/a.txt b/src/a.txt',
            'index 1111111..2222222 100644',
            '--- a/src/a.txt',
            '+++ b/src/a.txt',
            '@@ -1,1 +1,1 @@',
            '-old',
            '+new',
            'diff --git a/src/b.txt b/src/b.txt',
            'index 3333333..4444444 100644',
            '--- a/src/b.txt',
            '+++ b/src/b.txt',
            '@@ -1,1 +1,1 @@',
            '-before',
            '+after',
            '',
        ].join('\n');

        const extracted = extractUnifiedDiffForSingleFile({ patch, path: 'src/b.txt' });
        expect(extracted).toContain('diff --git a/src/b.txt b/src/b.txt');
        expect(extracted).not.toContain('diff --git a/src/a.txt b/src/a.txt');
        expect((extracted.match(/^diff --git /gm) ?? []).length).toBe(1);
    });

    it('returns original patch when it cannot find the requested file', () => {
        const patch = [
            'diff --git a/src/a.txt b/src/a.txt',
            'index 1111111..2222222 100644',
            '--- a/src/a.txt',
            '+++ b/src/a.txt',
            '@@ -1,1 +1,1 @@',
            '-old',
            '+new',
            '',
        ].join('\n');

        expect(extractUnifiedDiffForSingleFile({ patch, path: 'src/missing.txt' })).toBe(patch);
    });

    it('returns original patch when patch already contains a single diff', () => {
        const patch = [
            'diff --git a/src/a.txt b/src/a.txt',
            'index 1111111..2222222 100644',
            '--- a/src/a.txt',
            '+++ b/src/a.txt',
            '@@ -1,1 +1,1 @@',
            '-old',
            '+new',
            '',
        ].join('\n');

        expect(extractUnifiedDiffForSingleFile({ patch, path: 'src/a.txt' })).toBe(patch);
    });
});
