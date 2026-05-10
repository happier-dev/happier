import { describe, expect, it } from 'vitest';

import { deriveGitWorktreeId } from './deriveGitWorktreeId.js';
import { parseGitWorktreeListPorcelain } from './worktreeListParser.js';

describe('parseGitWorktreeListPorcelain', () => {
    it('marks prunable worktrees so callers can filter deleted entries', () => {
        expect(parseGitWorktreeListPorcelain({
            worktreesOutput:
                'worktree /repo\n' +
                'HEAD 1111111111111111111111111111111111111111\n' +
                'branch refs/heads/main\n' +
                '\n' +
                'worktree /repo/.worktrees/deleted\n' +
                'HEAD 1111111111111111111111111111111111111111\n' +
                'branch refs/heads/deleted\n' +
                'prunable gitdir file points to non-existent location\n',
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
});
