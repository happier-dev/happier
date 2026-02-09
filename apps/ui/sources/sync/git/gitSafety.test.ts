import { describe, expect, it } from 'vitest';

import type { GitWorkingSnapshot } from '../domains/state/storageTypes';
import {
    canCreateCommitFromSnapshot,
    canPullFromSnapshot,
    canPushFromSnapshot,
    canRevertFromSnapshot,
} from './gitSafety';

function makeSnapshot(input: Partial<GitWorkingSnapshot['totals']> & { hasConflicts?: boolean } = {}): GitWorkingSnapshot {
    return {
        projectKey: 'project',
        fetchedAt: Date.now(),
        repo: { isGitRepo: true, rootPath: '/repo' },
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: input.hasConflicts ?? false,
        entries: [],
        totals: {
            stagedFiles: input.stagedFiles ?? 0,
            unstagedFiles: input.unstagedFiles ?? 0,
            untrackedFiles: input.untrackedFiles ?? 0,
            stagedAdded: 0,
            stagedRemoved: 0,
            unstagedAdded: 0,
            unstagedRemoved: 0,
        },
    };
}

describe('canRevertFromSnapshot', () => {
    it('allows revert only when working tree and index are clean and conflict-free', () => {
        expect(canRevertFromSnapshot(makeSnapshot())).toBe(true);
    });

    it('blocks revert when snapshot shows conflicts or local changes', () => {
        expect(canRevertFromSnapshot(makeSnapshot({ hasConflicts: true }))).toBe(false);
        expect(canRevertFromSnapshot(makeSnapshot({ stagedFiles: 1 }))).toBe(false);
        expect(canRevertFromSnapshot(makeSnapshot({ unstagedFiles: 1 }))).toBe(false);
    });

    it('blocks revert when snapshot is unavailable', () => {
        expect(canRevertFromSnapshot(null)).toBe(false);
        expect(canRevertFromSnapshot(undefined)).toBe(false);
    });
});

describe('canCreateCommitFromSnapshot', () => {
    it('allows commit only with staged changes and no conflicts', () => {
        expect(canCreateCommitFromSnapshot(makeSnapshot({ stagedFiles: 1 }))).toBe(true);
        expect(canCreateCommitFromSnapshot(makeSnapshot({ stagedFiles: 0 }))).toBe(false);
        expect(canCreateCommitFromSnapshot(makeSnapshot({ stagedFiles: 1, hasConflicts: true }))).toBe(false);
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

        const dirty = makeSnapshot({ stagedFiles: 1 });
        dirty.branch.head = 'main';
        dirty.branch.upstream = 'origin/main';
        expect(canPullFromSnapshot(dirty)).toBe(false);
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
        const noHead = makeSnapshot();
        noHead.branch.head = null;
        noHead.branch.upstream = 'origin/main';
        expect(canPushFromSnapshot(noHead)).toBe(false);

        const noUpstream = makeSnapshot();
        noUpstream.branch.head = 'main';
        noUpstream.branch.upstream = null;
        expect(canPushFromSnapshot(noUpstream)).toBe(false);

        const conflicts = makeSnapshot({ hasConflicts: true });
        conflicts.branch.head = 'main';
        conflicts.branch.upstream = 'origin/main';
        expect(canPushFromSnapshot(conflicts)).toBe(false);
    });
});
