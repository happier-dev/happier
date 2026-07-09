import {
    SCM_OPERATION_ERROR_CODES,
    type ScmWorkingSnapshot,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { evaluateScmRemoteMutationPreconditions } from './remoteMutationPreconditions.js';

function makeSnapshot(overrides?: Partial<ScmWorkingSnapshot>): ScmWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: Date.now(),
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', worktrees: [], remotes: [] },
        capabilities: {
            capabilityScope: 'local-backend',
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
            worktreeCreate: true,
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

describe('evaluateScmRemoteMutationPreconditions', () => {
    it('normalizes snapshots and maps policy failures through the caller-owned error mapper', () => {
        const result = evaluateScmRemoteMutationPreconditions({
            kind: 'push',
            snapshot: makeSnapshot({
                branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 1, detached: false },
            }),
            hasExplicitTarget: true,
            policy: {
                requireUpstreamWhenNoExplicitTarget: true,
                requireActiveHead: false,
                blockPushOnConflicts: true,
                blockPushWhenBehind: true,
                requireCleanPull: true,
            },
            mapReasonToError: (kind, reason) => ({
                ok: false,
                errorCode: reason === 'branch_behind_remote'
                    ? SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD
                    : SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: `${kind}:${reason}`,
            }),
        });

        expect(result).toEqual({
            ok: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
            error: 'push:branch_behind_remote',
        });
    });
});
