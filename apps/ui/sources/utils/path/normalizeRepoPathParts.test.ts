import { describe, expect, it } from 'vitest';

describe('normalizeRepoPathParts', () => {
    it('normalizes leading/trailing slashes and returns dir null for root files', async () => {
        const { normalizeRepoPathParts } = await import('./normalizeRepoPathParts');

        expect(normalizeRepoPathParts({ fileName: '/README.md', filePath: '' })).toEqual({
            dir: null,
            name: 'README.md',
        });

        expect(normalizeRepoPathParts({ fileName: 'a.ts', filePath: '/src/' })).toEqual({
            dir: 'src',
            name: 'a.ts',
        });
    });

    it('falls back to fullPath when fileName is missing', async () => {
        const { normalizeRepoPathParts } = await import('./normalizeRepoPathParts');

        expect(normalizeRepoPathParts({ fullPath: 'docs/guide.md', filePath: 'docs' })).toEqual({
            dir: 'docs',
            name: 'guide.md',
        });
    });

    it('handles directory-like paths without duplicating dir/name', async () => {
        const { normalizeRepoPathParts } = await import('./normalizeRepoPathParts');

        expect(normalizeRepoPathParts({
            fileName: '.dev/worktree/eager-harbor/',
            filePath: '.dev/worktree/eager-harbor/',
            fullPath: '.dev/worktree/eager-harbor/',
        })).toEqual({
            dir: '.dev/worktree',
            name: 'eager-harbor',
        });
    });
});
