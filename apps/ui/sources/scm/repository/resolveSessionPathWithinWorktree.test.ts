import { describe, expect, it } from 'vitest';

import { resolveSessionPathWithinWorktree } from './resolveSessionPathWithinWorktree';

describe('resolveSessionPathWithinWorktree', () => {
    it('preserves a valid UNC root while rebasing a selected subdirectory case-insensitively', () => {
        expect(resolveSessionPathWithinWorktree({
            selectedPath: String.raw`\\Server\Share\Repo\Packages\App`,
            sourceRootPath: String.raw`\\server\share\repo`,
            worktreePath: String.raw`\\Server\Share\Repo-worktree`,
        })).toBe('//server/share/repo-worktree/packages/app');
    });

    it('does not rebase a sibling-prefix path', () => {
        const worktreePath = String.raw`\\Server\Share\Repo-worktree`;
        expect(resolveSessionPathWithinWorktree({
            selectedPath: String.raw`\\Server\Share\Repo-other\Packages\App`,
            sourceRootPath: String.raw`\\Server\Share\Repo`,
            worktreePath,
        })).toBe(worktreePath);
    });
});
