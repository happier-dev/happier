import { describe, expect, it } from 'vitest';

import { deriveGitWorktreeId } from './deriveGitWorktreeId.js';
import { parseGitWorktreeListPorcelain } from './worktreeListParser.js';

describe('parseGitWorktreeListPorcelain', () => {
    it('parses NUL-delimited worktrees while preserving dev worktree fields', () => {
        expect(parseGitWorktreeListPorcelain({
            worktreesOutput: [
                'worktree',
                '/repo',
                'HEAD 1111111111111111111111111111111111111111',
                'branch refs/heads/main',
                '',
                'worktree',
                '/repo/.worktrees/deleted',
                'HEAD 1111111111111111111111111111111111111111',
                'branch refs/heads/deleted',
                'prunable gitdir file points to non-existent location',
                '',
            ].join('\0'),
            currentWorktreePath: '/repo',
            mainWorktreePath: '/repo',
        })).toEqual([
            {
                id: deriveGitWorktreeId('/repo'),
                path: '/repo',
                branch: 'main',
                isCurrent: true,
                isMain: true,
            },
            {
                id: deriveGitWorktreeId('/repo/.worktrees/deleted'),
                path: '/repo/.worktrees/deleted',
                branch: 'deleted',
                isCurrent: false,
                isMain: false,
                isPrunable: true,
            },
        ]);
    });

    it('preserves worktree path tokens that contain embedded newlines and trailing spaces', () => {
        const newlinePath = '/repo/.worktrees/line\nbreak';
        const trailingSpacePath = '/repo/.worktrees/trailing  ';

        const parsed = parseGitWorktreeListPorcelain({
            worktreesOutput: [
                'worktree',
                newlinePath,
                'HEAD 1111111111111111111111111111111111111111',
                'branch refs/heads/line-break',
                '',
                'worktree',
                trailingSpacePath,
                'HEAD 2222222222222222222222222222222222222222',
                'branch refs/heads/trailing-space',
                '',
            ].join('\0'),
            currentWorktreePath: newlinePath,
            mainWorktreePath: trailingSpacePath,
        });

        expect(parsed).toContainEqual({
            id: deriveGitWorktreeId(newlinePath),
            path: newlinePath,
            branch: 'line-break',
            isCurrent: true,
            isMain: false,
        });
        expect(parsed).toContainEqual({
            id: deriveGitWorktreeId(trailingSpacePath),
            path: trailingSpacePath,
            branch: 'trailing-space',
            isCurrent: false,
            isMain: true,
        });
    });
});
