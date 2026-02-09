import { describe, expect, it } from 'vitest';

import { buildPatchFromSelectedDiffLines } from './gitPatchSelection';

const sampleDiff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,4 +1,4 @@',
    ' keep-1',
    '-old-line',
    '+new-line',
    ' keep-2',
].join('\n');

describe('buildPatchFromSelectedDiffLines', () => {
    it('returns null when no selected diff lines are provided', () => {
        const patch = buildPatchFromSelectedDiffLines(sampleDiff, new Set<number>());
        expect(patch).toBeNull();
    });

    it('builds a valid add-only patch hunk for selected + lines', () => {
        const patch = buildPatchFromSelectedDiffLines(sampleDiff, new Set([7]));
        expect(patch).toContain('diff --git a/src/a.ts b/src/a.ts');
        expect(patch).toContain('@@ -1,3 +1,4 @@');
        expect(patch).toContain(' old-line');
        expect(patch).toContain('+new-line');
    });

    it('builds a valid remove-only patch hunk for selected - lines', () => {
        const patch = buildPatchFromSelectedDiffLines(sampleDiff, new Set([6]));
        expect(patch).toContain('diff --git a/src/a.ts b/src/a.ts');
        expect(patch).toContain('@@ -1,3 +1,2 @@');
        expect(patch).toContain('-old-line');
    });

    it('keeps paired delete/add selection in a single coherent hunk', () => {
        const patch = buildPatchFromSelectedDiffLines(sampleDiff, new Set([6, 7]));
        expect(patch).toBeTruthy();
        expect(patch).toContain(' keep-1');
        expect(patch).toContain('-old-line');
        expect(patch).toContain('+new-line');
        expect(patch).toContain(' keep-2');

        const hunkCount = (patch?.match(/^@@/gm) ?? []).length;
        expect(hunkCount).toBe(1);
    });

    it('converts unselected deletions to context when only additions are selected', () => {
        const patch = buildPatchFromSelectedDiffLines(sampleDiff, new Set([7]));
        expect(patch).toContain('+new-line');
        expect(patch).toContain(' old-line');
        expect(patch).not.toContain('\n-old-line\n');
    });

    it('preserves no-newline markers for selected changes', () => {
        const noNewlineDiff = [
            'diff --git a/src/no-newline.txt b/src/no-newline.txt',
            '--- a/src/no-newline.txt',
            '+++ b/src/no-newline.txt',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '\\ No newline at end of file',
        ].join('\n');

        const patch = buildPatchFromSelectedDiffLines(noNewlineDiff, new Set([5]));
        expect(patch).toContain('+new');
        expect(patch).toContain('\\ No newline at end of file');
    });

    it('emits distinct hunks when selecting changes from separate hunks', () => {
        const multiHunkDiff = [
            'diff --git a/src/multi.ts b/src/multi.ts',
            'index 1111111..2222222 100644',
            '--- a/src/multi.ts',
            '+++ b/src/multi.ts',
            '@@ -1,3 +1,3 @@',
            ' keep-a',
            '-old-a',
            '+new-a',
            ' keep-b',
            '@@ -10,3 +10,3 @@',
            ' keep-c',
            '-old-c',
            '+new-c',
            ' keep-d',
        ].join('\n');

        const patch = buildPatchFromSelectedDiffLines(multiHunkDiff, new Set([7, 12]));
        expect(patch).toContain('+new-a');
        expect(patch).toContain('+new-c');
        const hunkCount = (patch?.match(/^@@/gm) ?? []).length;
        expect(hunkCount).toBe(2);
    });
});
