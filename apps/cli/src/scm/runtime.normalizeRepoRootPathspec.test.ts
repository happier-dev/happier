import { describe, expect, it } from 'vitest';

import { normalizeRepoRootPathspec } from './runtime';

describe('normalizeRepoRootPathspec', () => {
    it('anchors repo-root-relative paths using git pathspec magic', () => {
        const result = normalizeRepoRootPathspec('src/a.ts');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.pathspec).toBe(':(top)src/a.ts');
    });

    it('rejects pathspec magic injection', () => {
        const result = normalizeRepoRootPathspec(':(exclude)a.ts');
        expect(result.ok).toBe(false);
    });

    it('rejects .. segments', () => {
        const result = normalizeRepoRootPathspec('../a.ts');
        expect(result.ok).toBe(false);
    });
});

