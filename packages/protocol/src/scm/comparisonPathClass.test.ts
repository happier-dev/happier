import { describe, expect, it } from 'vitest';

import { classifyScmChangePath } from './comparison.js';

describe('classifyScmChangePath', () => {
    it('names lockfiles and generated output by path, wherever they sit', () => {
        expect(classifyScmChangePath('yarn.lock')).toEqual({ generated: false, lockfile: true });
        expect(classifyScmChangePath('apps/ui/package-lock.json').lockfile).toBe(true);
        expect(classifyScmChangePath('go.sum').lockfile).toBe(true);
        expect(classifyScmChangePath('src/api.generated.ts')).toEqual({ generated: true, lockfile: false });
        expect(classifyScmChangePath('sources/generated/icons.ts').generated).toBe(true);
    });

    it('leaves ordinary source alone, including names that only contain the words', () => {
        expect(classifyScmChangePath('src/lockfileReader.ts')).toEqual({ generated: false, lockfile: false });
        expect(classifyScmChangePath('docs/regenerated-notes.md')).toEqual({ generated: false, lockfile: false });
    });
});
