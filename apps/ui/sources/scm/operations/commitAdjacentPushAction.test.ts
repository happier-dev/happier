import { describe, expect, it } from 'vitest';

import type { ScmOperationPreflightResult } from '@/scm/core/operationPolicy';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { resolveCommitAdjacentPushActionState } from './commitAdjacentPushAction';

function makeSnapshot(
    branch: Partial<ScmWorkingSnapshot['branch']> = {},
    repo: Partial<ScmWorkingSnapshot['repo']> = {},
): ScmWorkingSnapshot {
    return {
        projectKey: 'project',
        fetchedAt: 1,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            remotes: [{ name: 'origin', fetchUrl: 'git@example.com:repo.git', pushUrl: 'git@example.com:repo.git' }],
            ...repo,
        },
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
            worktreeCreate: true,
        },
        branch: {
            head: 'main',
            upstream: 'origin/main',
            ahead: 1,
            behind: 0,
            detached: false,
            ...branch,
        },
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
    };
}

const allowedPush: ScmOperationPreflightResult = { allowed: true };

function resolve(input?: Partial<Parameters<typeof resolveCommitAdjacentPushActionState>[0]>) {
    return resolveCommitAdjacentPushActionState({
        snapshot: makeSnapshot(),
        pushPreflight: allowedPush,
        scmWriteEnabled: true,
        sessionPath: '/repo',
        scmOperationBusy: false,
        hasGlobalOperationInFlight: false,
        isLockedByOtherSession: false,
        ...(input ?? {}),
    });
}

describe('resolveCommitAdjacentPushActionState', () => {
    it('shows an enabled shortcut for an ahead branch with a configured upstream remote', () => {
        expect(resolve()).toEqual({
            visible: true,
            disabled: false,
            busy: false,
            target: { remote: 'origin', branch: 'main' },
        });
    });

    it('hides the shortcut when the branch has no local commits ahead of upstream', () => {
        expect(resolve({ snapshot: makeSnapshot({ ahead: 0 }) })).toEqual({ visible: false });
    });

    it('hides the shortcut when the repository has no configured remotes', () => {
        expect(resolve({ snapshot: makeSnapshot({}, { remotes: [] }) })).toEqual({ visible: false });
    });

    it('hides the shortcut when the branch has no upstream', () => {
        expect(resolve({ snapshot: makeSnapshot({ upstream: null }) })).toEqual({ visible: false });
    });

    it('hides the shortcut when push preflight blocks the operation', () => {
        expect(resolve({
            pushPreflight: {
                allowed: false,
                reason: 'branch_behind_remote',
                message: 'Pull remote changes before pushing local commits.',
            },
        })).toEqual({ visible: false });
    });

    it('keeps the shortcut visible but disabled while another source-control operation is running', () => {
        expect(resolve({ hasGlobalOperationInFlight: true })).toEqual({
            visible: true,
            disabled: true,
            busy: true,
            target: { remote: 'origin', branch: 'main' },
        });
    });
});
