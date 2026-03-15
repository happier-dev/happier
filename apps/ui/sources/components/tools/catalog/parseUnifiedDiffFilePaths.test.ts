import { describe, expect, it } from 'vitest';

import { parseUnifiedDiffFilePaths } from './parseUnifiedDiffFilePaths';

describe('parseUnifiedDiffFilePaths', () => {
    it('extracts file paths from diff --git headers', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
        ].join('\n');

        expect(parseUnifiedDiffFilePaths(diff)).toEqual(['src/a.ts']);
    });

    it('supports quoted paths containing spaces in diff --git headers', () => {
        const diff = [
            'diff --git \"a/src/hello world.ts\" \"b/src/hello world.ts\"',
            '--- \"a/src/hello world.ts\"',
            '+++ \"b/src/hello world.ts\"',
        ].join('\n');

        expect(parseUnifiedDiffFilePaths(diff)).toEqual(['src/hello world.ts']);
    });

    it('supports escaped spaces in diff --git headers', () => {
        const diff = [
            'diff --git a/src/hello\\ world.ts b/src/hello\\ world.ts',
        ].join('\n');

        expect(parseUnifiedDiffFilePaths(diff)).toEqual(['src/hello world.ts']);
    });
});
