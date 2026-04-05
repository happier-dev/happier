import { describe, expect, it } from 'vitest';

import { resolveRepoWorktreeSelection } from './resolveRepoWorktreeSelection';

describe('resolveRepoWorktreeSelection', () => {
    it('preserves the selected worktree when it still exists in the repo worktree list', () => {
        expect(resolveRepoWorktreeSelection({
            requestedRootPath: '/Users/test/repo/.worktrees/feature-auth',
            defaultRootPath: '/Users/test/repo',
            availableWorktrees: [
                { id: 'gitwt_main', path: '/Users/test/repo' },
                { id: 'gitwt_feature', path: '/Users/test/repo/.worktrees/feature-auth' },
            ],
        })).toEqual({
            requestedRootPath: '/Users/test/repo/.worktrees/feature-auth',
            requestedWorktreeId: null,
            resolvedRootPath: '/Users/test/repo/.worktrees/feature-auth',
            resolvedWorktreeId: 'gitwt_feature',
            didRecoverMissingWorktree: false,
        });
    });

    it('resolves a worktree selection by id even when the requested root path is still the project root', () => {
        expect(resolveRepoWorktreeSelection({
            requestedRootPath: '/Users/test/repo',
            requestedWorktreeId: 'gitwt_feature',
            defaultRootPath: '/Users/test/repo',
            availableWorktrees: [
                { id: 'gitwt_main', path: '/Users/test/repo' },
                { id: 'gitwt_feature', path: '/Users/test/repo/.worktrees/feature-auth' },
            ],
        })).toEqual({
            requestedRootPath: '/Users/test/repo',
            requestedWorktreeId: 'gitwt_feature',
            resolvedRootPath: '/Users/test/repo/.worktrees/feature-auth',
            resolvedWorktreeId: 'gitwt_feature',
            didRecoverMissingWorktree: false,
        });
    });

    it('reports recovery when an explicit worktree id no longer resolves from the live repo worktree list', () => {
        expect(resolveRepoWorktreeSelection({
            requestedRootPath: '/Users/test/repo',
            requestedWorktreeId: 'gitwt_deleted',
            defaultRootPath: '/Users/test/repo',
            availableWorktrees: [
                { id: 'gitwt_main', path: '/Users/test/repo' },
                { id: 'gitwt_feature', path: '/Users/test/repo/.worktrees/feature-auth' },
            ],
        })).toEqual({
            requestedRootPath: '/Users/test/repo',
            requestedWorktreeId: 'gitwt_deleted',
            resolvedRootPath: '/Users/test/repo',
            resolvedWorktreeId: null,
            didRecoverMissingWorktree: true,
        });
    });

    it('falls back to the project root and reports recovery when the selected worktree no longer exists', () => {
        expect(resolveRepoWorktreeSelection({
            requestedRootPath: '/Users/test/repo/.worktrees/deleted-worktree',
            defaultRootPath: '/Users/test/repo',
            availableWorktrees: [
                { id: 'gitwt_main', path: '/Users/test/repo' },
                { id: 'gitwt_feature', path: '/Users/test/repo/.worktrees/feature-auth' },
            ],
        })).toEqual({
            requestedRootPath: '/Users/test/repo/.worktrees/deleted-worktree',
            requestedWorktreeId: null,
            resolvedRootPath: '/Users/test/repo',
            resolvedWorktreeId: null,
            didRecoverMissingWorktree: true,
        });
    });

    it('treats prunable worktrees as missing so broken selections recover to the project root', () => {
        expect(resolveRepoWorktreeSelection({
            requestedRootPath: '/Users/test/repo/.worktrees/deleted-worktree',
            defaultRootPath: '/Users/test/repo',
            availableWorktrees: [
                { id: 'gitwt_main', path: '/Users/test/repo' },
                { id: 'gitwt_deleted', path: '/Users/test/repo/.worktrees/deleted-worktree', isPrunable: true },
            ],
        })).toEqual({
            requestedRootPath: '/Users/test/repo/.worktrees/deleted-worktree',
            requestedWorktreeId: null,
            resolvedRootPath: '/Users/test/repo',
            resolvedWorktreeId: null,
            didRecoverMissingWorktree: true,
        });
    });
});
