import { describe, expect, it } from 'vitest';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    canCreateCommitFromSnapshot,
    canPullFromSnapshot,
    canPushFromSnapshot,
    canRevertFromSnapshot,
} from './scmSafety';

function makeSnapshot(input: Partial<ScmWorkingSnapshot['totals']> & { hasConflicts?: boolean } = {}): ScmWorkingSnapshot {
    return {
        projectKey: 'project',
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
            operationLabels: { commit: 'Commit staged' },
        },
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: input.hasConflicts ?? false,
        entries: [],
        totals: {
            includedFiles: input.includedFiles ?? 0,
            pendingFiles: input.pendingFiles ?? 0,
            untrackedFiles: input.untrackedFiles ?? 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    };
}

describe('canRevertFromSnapshot', () => {
    it('allows revert only when working tree and index are clean and conflict-free', () => {
        expect(canRevertFromSnapshot(makeSnapshot())).toBe(true);
    });

    it('blocks revert when snapshot shows conflicts or local changes', () => {
        expect(canRevertFromSnapshot(makeSnapshot({ hasConflicts: true }))).toBe(false);
        expect(canRevertFromSnapshot(makeSnapshot({ includedFiles: 1 }))).toBe(false);
        expect(canRevertFromSnapshot(makeSnapshot({ pendingFiles: 1 }))).toBe(false);
        expect(canRevertFromSnapshot(makeSnapshot({ untrackedFiles: 1 }))).toBe(false);
    });

    it('blocks revert when snapshot is unavailable', () => {
        expect(canRevertFromSnapshot(null)).toBe(false);
        expect(canRevertFromSnapshot(undefined)).toBe(false);
    });
});

describe('canCreateCommitFromSnapshot', () => {
    it('allows commit only with staged changes and no conflicts', () => {
        expect(canCreateCommitFromSnapshot(makeSnapshot({ includedFiles: 1 }))).toBe(true);
        expect(canCreateCommitFromSnapshot(makeSnapshot({ includedFiles: 0 }))).toBe(false);
        expect(canCreateCommitFromSnapshot(makeSnapshot({ includedFiles: 1, hasConflicts: true }))).toBe(false);
    });
});

describe('canPullFromSnapshot', () => {
    it('allows pull only when branch is tracked, clean, and conflict-free', () => {
        const tracked = makeSnapshot();
        tracked.branch.head = 'main';
        tracked.branch.upstream = 'origin/main';
        expect(canPullFromSnapshot(tracked)).toBe(true);
    });

    it('blocks pull when branch tracking or cleanliness preconditions are missing', () => {
        const noUpstream = makeSnapshot();
        noUpstream.branch.head = 'main';
        noUpstream.branch.upstream = null;
        expect(canPullFromSnapshot(noUpstream)).toBe(false);

        const dirty = makeSnapshot({ includedFiles: 1 });
        dirty.branch.head = 'main';
        dirty.branch.upstream = 'origin/main';
        expect(canPullFromSnapshot(dirty)).toBe(false);

        const untracked = makeSnapshot({ untrackedFiles: 1 });
        untracked.branch.head = 'main';
        untracked.branch.upstream = 'origin/main';
        expect(canPullFromSnapshot(untracked)).toBe(false);
    });

    it('blocks pull without upstream for fallback working-copy backends when head exists', () => {
        const fallbackWorkingCopy = makeSnapshot();
        fallbackWorkingCopy.repo.backendId = null;
        fallbackWorkingCopy.repo.mode = null;
        fallbackWorkingCopy.capabilities = undefined;
        fallbackWorkingCopy.branch.upstream = null;

        expect(canPullFromSnapshot(fallbackWorkingCopy)).toBe(false);
    });
});

describe('canPushFromSnapshot', () => {
    it('allows push only when branch is tracked and conflict-free', () => {
        const tracked = makeSnapshot();
        tracked.branch.head = 'main';
        tracked.branch.upstream = 'origin/main';
        expect(canPushFromSnapshot(tracked)).toBe(true);
    });

    it('blocks push when branch tracking is missing or conflicts exist', () => {
        const detached = makeSnapshot();
        detached.branch.head = null;
        detached.branch.upstream = 'origin/main';
        detached.branch.detached = true;
        expect(canPushFromSnapshot(detached)).toBe(false);

        const noUpstream = makeSnapshot();
        noUpstream.branch.head = 'main';
        noUpstream.branch.upstream = null;
        expect(canPushFromSnapshot(noUpstream)).toBe(false);

        const conflicts = makeSnapshot({ hasConflicts: true });
        conflicts.branch.head = 'main';
        conflicts.branch.upstream = 'origin/main';
        expect(canPushFromSnapshot(conflicts)).toBe(false);
    });

    it('blocks push without upstream for fallback working-copy backends when head exists', () => {
        const fallbackWorkingCopy = makeSnapshot();
        fallbackWorkingCopy.repo.backendId = null;
        fallbackWorkingCopy.repo.mode = null;
        fallbackWorkingCopy.capabilities = undefined;
        fallbackWorkingCopy.branch.upstream = null;

        expect(canPushFromSnapshot(fallbackWorkingCopy)).toBe(false);
    });
});
