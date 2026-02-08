import { describe, expect, it } from 'vitest';
import type { GitWorkingSnapshot } from '@happier-dev/protocol';
import { GIT_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { evaluateRemoteMutationPreconditions } from './remoteGuards';

function makeSnapshot(overrides?: Partial<GitWorkingSnapshot>): GitWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: Date.now(),
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
        },
        ...overrides,
    };
}

describe('evaluateRemoteMutationPreconditions', () => {
    it('blocks push when HEAD is detached', () => {
        const result = evaluateRemoteMutationPreconditions({
            kind: 'push',
            snapshot: makeSnapshot({
                branch: { head: null, upstream: 'origin/main', ahead: 0, behind: 0, detached: true },
            }),
            hasExplicitRemoteOrBranch: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
        }
    });

    it('blocks push when branch is behind upstream', () => {
        const result = evaluateRemoteMutationPreconditions({
            kind: 'push',
            snapshot: makeSnapshot({
                branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 1, detached: false },
            }),
            hasExplicitRemoteOrBranch: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errorCode).toBe(GIT_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD);
        }
    });

    it('blocks pull when there are local worktree changes', () => {
        const result = evaluateRemoteMutationPreconditions({
            kind: 'pull',
            snapshot: makeSnapshot({
                entries: [
                    {
                        path: 'a.txt',
                        previousPath: null,
                        kind: 'modified',
                        indexStatus: '.',
                        worktreeStatus: 'M',
                        hasStagedDelta: false,
                        hasUnstagedDelta: true,
                        stats: {
                            stagedAdded: 0,
                            stagedRemoved: 0,
                            unstagedAdded: 1,
                            unstagedRemoved: 0,
                            isBinary: false,
                        },
                    },
                ],
                totals: {
                    stagedFiles: 0,
                    unstagedFiles: 1,
                    untrackedFiles: 0,
                    stagedAdded: 0,
                    stagedRemoved: 0,
                    unstagedAdded: 1,
                    unstagedRemoved: 0,
                },
            }),
            hasExplicitRemoteOrBranch: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errorCode).toBe(GIT_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
        }
    });

    it('requires upstream for push/pull when no explicit target is provided', () => {
        const snapshotWithoutUpstream = makeSnapshot({
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        });

        const pushResult = evaluateRemoteMutationPreconditions({
            kind: 'push',
            snapshot: snapshotWithoutUpstream,
            hasExplicitRemoteOrBranch: false,
        });
        const pullResult = evaluateRemoteMutationPreconditions({
            kind: 'pull',
            snapshot: snapshotWithoutUpstream,
            hasExplicitRemoteOrBranch: false,
        });

        expect(pushResult.ok).toBe(false);
        expect(pullResult.ok).toBe(false);
        if (!pushResult.ok) {
            expect(pushResult.errorCode).toBe(GIT_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
        }
        if (!pullResult.ok) {
            expect(pullResult.errorCode).toBe(GIT_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
        }
    });

    it('allows explicit remote/branch even when upstream is missing', () => {
        const snapshotWithoutUpstream = makeSnapshot({
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        });

        const pushResult = evaluateRemoteMutationPreconditions({
            kind: 'push',
            snapshot: snapshotWithoutUpstream,
            hasExplicitRemoteOrBranch: true,
        });
        const pullResult = evaluateRemoteMutationPreconditions({
            kind: 'pull',
            snapshot: snapshotWithoutUpstream,
            hasExplicitRemoteOrBranch: true,
        });

        expect(pushResult).toEqual({ ok: true });
        expect(pullResult).toEqual({ ok: true });
    });

    it('blocks push on conflicts before evaluating upstream requirement', () => {
        const result = evaluateRemoteMutationPreconditions({
            kind: 'push',
            snapshot: makeSnapshot({
                hasConflicts: true,
                branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            }),
            hasExplicitRemoteOrBranch: false,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errorCode).toBe(GIT_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
        }
    });

    it('allows push/pull when repository state is safe', () => {
        const pushResult = evaluateRemoteMutationPreconditions({
            kind: 'push',
            snapshot: makeSnapshot(),
            hasExplicitRemoteOrBranch: true,
        });
        const pullResult = evaluateRemoteMutationPreconditions({
            kind: 'pull',
            snapshot: makeSnapshot(),
            hasExplicitRemoteOrBranch: true,
        });

        expect(pushResult).toEqual({ ok: true });
        expect(pullResult).toEqual({ ok: true });
    });
});
