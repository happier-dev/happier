import { describe, expect, it } from 'vitest';
import type { ScmWorkingSnapshot } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { evaluateRemoteMutationPreconditions } from './remoteGuards';

function makeSnapshot(overrides?: Partial<ScmWorkingSnapshot>): ScmWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: Date.now(),
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        capabilities: {
            readStatus: true,
            readDiffFile: true,
            readDiffCommit: true,
            readLog: true,
            writeInclude: true,
            writeExclude: true,
            writeCommit: true,
            writeCommitPathSelection: true,
            writeCommitLineSelection: true,
            writeBackout: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            workspaceWorktreeCreate: true,
            changeSetModel: 'index',
            supportedDiffAreas: ['included', 'pending', 'both'],
        },
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
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
            expect(result.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
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
            expect(result.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD);
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
                        includeStatus: '.',
                        pendingStatus: 'M',
                        hasIncludedDelta: false,
                        hasPendingDelta: true,
                        stats: {
                            includedAdded: 0,
                            includedRemoved: 0,
                            pendingAdded: 1,
                            pendingRemoved: 0,
                            isBinary: false,
                        },
                    },
                ],
                totals: {
                    includedFiles: 0,
                    pendingFiles: 1,
                    untrackedFiles: 0,
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 1,
                    pendingRemoved: 0,
                },
            }),
            hasExplicitRemoteOrBranch: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
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
            expect(pushResult.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
        }
        if (!pullResult.ok) {
            expect(pullResult.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
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
});
