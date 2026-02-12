import { describe, expect, it } from 'vitest';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { inferRemoteTargetFromSnapshot } from './remoteTarget';

function makeSnapshot(partial?: Partial<ScmWorkingSnapshot['branch']>): ScmWorkingSnapshot {
    return {
        projectKey: 'p',
        fetchedAt: 1,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
        },
        branch: {
            head: 'main',
            upstream: 'origin/main',
            ahead: 0,
            behind: 0,
            detached: false,
            ...(partial ?? {}),
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
        },
    };
}

describe('inferRemoteTargetFromSnapshot', () => {
    it('uses parsed upstream when available', () => {
        expect(inferRemoteTargetFromSnapshot(makeSnapshot({ upstream: 'upstream/feature/x' }))).toEqual({
            remote: 'upstream',
            branch: 'feature/x',
        });
    });

    it('falls back to origin + head when upstream is missing', () => {
        expect(inferRemoteTargetFromSnapshot(makeSnapshot({ upstream: null, head: 'release/1.2' }))).toEqual({
            remote: 'origin',
            branch: 'release/1.2',
        });
    });

    it('returns null branch on detached head without upstream', () => {
        expect(
            inferRemoteTargetFromSnapshot(makeSnapshot({ upstream: null, head: null, detached: true }))
        ).toEqual({
            remote: 'origin',
            branch: null,
        });
    });

    it('does not fall back to active head for sapling backend snapshots without upstream', () => {
        expect(
            inferRemoteTargetFromSnapshot({
                ...makeSnapshot(),
                repo: {
                    isRepo: true,
                    rootPath: '/repo',
                    backendId: 'sapling',
                    mode: '.sl',
                },
                branch: {
                    head: '2f3f508ef55d',
                    upstream: null,
                    ahead: 0,
                    behind: 0,
                    detached: false,
                },
            })
        ).toEqual({
            remote: 'origin',
            branch: null,
        });
    });
});
