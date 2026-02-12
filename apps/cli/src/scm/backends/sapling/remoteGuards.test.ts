import { describe, expect, it } from 'vitest';
import type { ScmWorkingSnapshot } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { evaluateSaplingRemoteMutationPreconditions } from './remoteGuards';

function makeSnapshot(overrides?: Partial<ScmWorkingSnapshot>): ScmWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: Date.now(),
        repo: { isRepo: true, rootPath: '/repo', backendId: 'sapling', mode: '.sl' },
        capabilities: {
            readStatus: true,
            readDiffFile: true,
            readDiffCommit: true,
            readLog: true,
            writeInclude: false,
            writeExclude: false,
            writeCommit: true,
            writeCommitPathSelection: true,
            writeCommitLineSelection: false,
            writeBackout: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            workspaceWorktreeCreate: false,
            changeSetModel: 'working-copy',
            supportedDiffAreas: ['pending'],
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

describe('evaluateSaplingRemoteMutationPreconditions', () => {
    it('requires an active checkout for push and pull', () => {
        const inactiveHead = makeSnapshot({
            branch: { head: null, upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        });

        const push = evaluateSaplingRemoteMutationPreconditions({
            kind: 'push',
            snapshot: inactiveHead,
            hasExplicitBranch: true,
        });
        const pull = evaluateSaplingRemoteMutationPreconditions({
            kind: 'pull',
            snapshot: inactiveHead,
            hasExplicitBranch: true,
        });

        expect(push.ok).toBe(false);
        expect(pull.ok).toBe(false);
        if (!push.ok) {
            expect(push.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
        }
        if (!pull.ok) {
            expect(pull.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
        }
    });

    it('requires an upstream target when no explicit branch is provided', () => {
        const missingUpstream = makeSnapshot({
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        });

        const result = evaluateSaplingRemoteMutationPreconditions({
            kind: 'push',
            snapshot: missingUpstream,
            hasExplicitBranch: false,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
        }
    });

    it('allows explicit branch target without configured upstream', () => {
        const missingUpstream = makeSnapshot({
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        });

        const result = evaluateSaplingRemoteMutationPreconditions({
            kind: 'push',
            snapshot: missingUpstream,
            hasExplicitBranch: true,
        });

        expect(result).toEqual({ ok: true });
    });

    it('does not block push when branch is behind upstream', () => {
        const result = evaluateSaplingRemoteMutationPreconditions({
            kind: 'push',
            snapshot: makeSnapshot({
                branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 2, detached: false },
            }),
            hasExplicitBranch: true,
        });

        expect(result).toEqual({ ok: true });
    });

    it('blocks pull when the working tree is dirty', () => {
        const result = evaluateSaplingRemoteMutationPreconditions({
            kind: 'pull',
            snapshot: makeSnapshot({
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
            hasExplicitBranch: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
        }
    });
});
