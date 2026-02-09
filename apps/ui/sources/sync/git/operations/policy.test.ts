import { describe, expect, it } from 'vitest';
import type { GitWorkingSnapshot } from '@happier-dev/protocol';
import { evaluateGitOperationPreflight } from './policy';

function makeSnapshot(
    overrides?: Partial<GitWorkingSnapshot>,
    totals?: Partial<GitWorkingSnapshot['totals']>
): GitWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: 1,
        repo: { isGitRepo: true, rootPath: '/repo' },
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        totals: {
            stagedFiles: 0,
            unstagedFiles: 0,
            untrackedFiles: 0,
            stagedAdded: 0,
            stagedRemoved: 0,
            unstagedAdded: 0,
            unstagedRemoved: 0,
            ...totals,
        },
        ...overrides,
    };
}

describe('evaluateGitOperationPreflight', () => {
    it('blocks write operations when experimental write flag is disabled', () => {
        const result = evaluateGitOperationPreflight({
            intent: 'commit',
            gitWriteEnabled: false,
            sessionPath: '/repo',
            snapshot: makeSnapshot(),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('write_disabled');
        }
    });

    it('blocks fetch when experimental write flag is disabled', () => {
        const result = evaluateGitOperationPreflight({
            intent: 'fetch',
            gitWriteEnabled: false,
            sessionPath: '/repo',
            snapshot: makeSnapshot(),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('write_disabled');
        }
    });

    it('blocks operations when session path is missing', () => {
        const result = evaluateGitOperationPreflight({
            intent: 'push',
            gitWriteEnabled: true,
            sessionPath: null,
            snapshot: makeSnapshot(),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('missing_session_path');
        }
    });

    it('blocks operations when repository snapshot is not a git repository', () => {
        const result = evaluateGitOperationPreflight({
            intent: 'stage',
            gitWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot({
                repo: {
                    isGitRepo: false,
                    rootPath: null,
                },
            }),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('not_git_repo');
        }
    });

    it('blocks stage when conflicts are present', () => {
        const result = evaluateGitOperationPreflight({
            intent: 'stage',
            gitWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot({ hasConflicts: true }),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('conflicts_present');
        }
    });

    it('requires staged files before creating a commit', () => {
        const result = evaluateGitOperationPreflight({
            intent: 'commit',
            gitWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot(),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('staged_changes_required');
        }
    });

    it('blocks pull while worktree is dirty', () => {
        const result = evaluateGitOperationPreflight({
            intent: 'pull',
            gitWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot(undefined, { unstagedFiles: 1 }),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('clean_worktree_required');
        }
    });

    it('requires upstream for push and pull', () => {
        const pushResult = evaluateGitOperationPreflight({
            intent: 'push',
            gitWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot({
                branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            }),
        });
        const pullResult = evaluateGitOperationPreflight({
            intent: 'pull',
            gitWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot({
                branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            }),
        });

        expect(pushResult.allowed).toBe(false);
        expect(pullResult.allowed).toBe(false);
        if (!pushResult.allowed) {
            expect(pushResult.reason).toBe('upstream_required');
        }
        if (!pullResult.allowed) {
            expect(pullResult.reason).toBe('upstream_required');
        }
    });

    it('blocks push and pull in detached HEAD state', () => {
        const detachedSnapshot = makeSnapshot({
            branch: { head: null, upstream: 'origin/main', ahead: 0, behind: 0, detached: true },
        });

        const pushResult = evaluateGitOperationPreflight({
            intent: 'push',
            gitWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: detachedSnapshot,
        });
        const pullResult = evaluateGitOperationPreflight({
            intent: 'pull',
            gitWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: detachedSnapshot,
        });

        expect(pushResult.allowed).toBe(false);
        expect(pullResult.allowed).toBe(false);
        if (!pushResult.allowed) {
            expect(pushResult.reason).toBe('detached_head');
        }
        if (!pullResult.allowed) {
            expect(pullResult.reason).toBe('detached_head');
        }
    });

    it('blocks push when local branch is behind upstream', () => {
        const result = evaluateGitOperationPreflight({
            intent: 'push',
            gitWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot({
                branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 2, detached: false },
            }),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('branch_behind_remote');
        }
    });

    it('blocks revert when worktree is not clean', () => {
        const result = evaluateGitOperationPreflight({
            intent: 'revert',
            gitWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot(undefined, { stagedFiles: 1 }),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('clean_worktree_required');
        }
    });

    it('blocks revert in detached HEAD state', () => {
        const result = evaluateGitOperationPreflight({
            intent: 'revert',
            gitWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot({
                branch: { head: null, upstream: 'origin/main', ahead: 0, behind: 0, detached: true },
            }),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('detached_head');
        }
    });
});
