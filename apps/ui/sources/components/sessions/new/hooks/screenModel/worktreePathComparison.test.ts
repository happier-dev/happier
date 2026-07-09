import { describe, expect, it } from 'vitest';

import { pathBelongsToRepo, pathsAreSameWorktree } from '@/components/sessions/new/modules/worktreePathComparison';

describe('pathsAreSameWorktree', () => {
    it('matches paths that differ only by trailing separator / mixed separators', () => {
        expect(pathsAreSameWorktree('/repo/feature', '/repo/feature/', null)).toBe(true);
        expect(pathsAreSameWorktree('C:\\repo\\feature', 'C:/repo/feature', null)).toBe(true);
    });

    it('matches macOS private temp aliases only for darwin machines', () => {
        expect(pathsAreSameWorktree('/private/tmp/repo', '/tmp/repo', null, 'darwin')).toBe(true);
        expect(pathsAreSameWorktree('/private/tmp/repo', '/tmp/repo', null, 'linux')).toBe(false);
    });

    it('does not match unrelated paths', () => {
        expect(pathsAreSameWorktree('/repo/feature', '/repo/other', null)).toBe(false);
    });
});

describe('pathBelongsToRepo', () => {
    const repoRootPath = '/repo';
    const worktreePaths = ['/repo', '/repo/.dev/worktree/feature', '/repo/.dev/worktree/fix'];

    it('treats the repo root itself as belonging to the repo', () => {
        expect(pathBelongsToRepo({ candidatePath: '/repo', repoRootPath, worktreePaths })).toBe(true);
    });

    it('treats a path within the repo root as belonging to the repo', () => {
        expect(pathBelongsToRepo({ candidatePath: '/repo/src/app', repoRootPath, worktreePaths })).toBe(true);
    });

    it('treats any of the repo worktrees as belonging to the repo (even outside the root)', () => {
        expect(pathBelongsToRepo({
            candidatePath: '/repo/.dev/worktree/feature',
            repoRootPath,
            worktreePaths,
        })).toBe(true);
        // A worktree materialized OUTSIDE the repo root still belongs to it.
        expect(pathBelongsToRepo({
            candidatePath: '/elsewhere/wt',
            repoRootPath,
            worktreePaths: ['/repo', '/elsewhere/wt'],
        })).toBe(true);
    });

    it('treats paths inside external worktrees as belonging to the repo', () => {
        expect(pathBelongsToRepo({
            candidatePath: '/elsewhere/wt/src/app',
            repoRootPath,
            worktreePaths: ['/repo', '/elsewhere/wt'],
        })).toBe(true);
    });

    it('does NOT treat a different repo as belonging (so a real repo switch still resets)', () => {
        expect(pathBelongsToRepo({ candidatePath: '/other-repo', repoRootPath, worktreePaths })).toBe(false);
    });

    it('guards against sibling-prefix collisions (e.g. /repo vs /repo-2)', () => {
        expect(pathBelongsToRepo({ candidatePath: '/repo-2/src', repoRootPath, worktreePaths })).toBe(false);
        expect(pathBelongsToRepo({
            candidatePath: '/elsewhere/wt-2/src',
            repoRootPath,
            worktreePaths: ['/repo', '/elsewhere/wt'],
        })).toBe(false);
    });

    it('canonicalizes separators + trailing slashes before comparing', () => {
        expect(pathBelongsToRepo({
            candidatePath: '/repo/.dev/worktree/feature/',
            repoRootPath,
            worktreePaths,
        })).toBe(true);
    });

    it('uses macOS private temp aliases when checking repo membership', () => {
        expect(pathBelongsToRepo({
            candidatePath: '/private/tmp/repo/worktree',
            repoRootPath: '/tmp/repo',
            worktreePaths: ['/tmp/repo', '/tmp/repo/worktree'],
            machinePlatform: 'darwin',
        })).toBe(true);
        expect(pathBelongsToRepo({
            candidatePath: '/private/tmp/repo/worktree',
            repoRootPath: '/tmp/repo',
            worktreePaths: ['/tmp/repo', '/tmp/repo/worktree'],
            machinePlatform: 'linux',
        })).toBe(false);
    });

    it('returns false for an empty candidate or missing repo info', () => {
        expect(pathBelongsToRepo({ candidatePath: '', repoRootPath, worktreePaths })).toBe(false);
        expect(pathBelongsToRepo({ candidatePath: '/repo', repoRootPath: null, worktreePaths: [] })).toBe(false);
    });
});
