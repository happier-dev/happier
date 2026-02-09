import { describe, expect, it } from 'vitest';

import type { GitWorkingSnapshot } from '../storageTypes';
import {
    ATTRIBUTION_INVALIDATION_WINDOW_MS,
    collectChangedPaths,
    isSessionPathWithinRepoRoot,
    shouldAttributeChangedPaths,
} from './gitStatusSync';

function makeSnapshot(entries: GitWorkingSnapshot['entries']): GitWorkingSnapshot {
    return {
        projectKey: 'm:/repo',
        fetchedAt: Date.now(),
        repo: { isGitRepo: true, rootPath: '/repo' },
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries,
        totals: {
            stagedFiles: entries.filter((e) => e.hasStagedDelta).length,
            unstagedFiles: entries.filter((e) => e.hasUnstagedDelta).length,
            untrackedFiles: entries.filter((e) => e.kind === 'untracked').length,
            stagedAdded: entries.reduce((acc, e) => acc + e.stats.stagedAdded, 0),
            stagedRemoved: entries.reduce((acc, e) => acc + e.stats.stagedRemoved, 0),
            unstagedAdded: entries.reduce((acc, e) => acc + e.stats.unstagedAdded, 0),
            unstagedRemoved: entries.reduce((acc, e) => acc + e.stats.unstagedRemoved, 0),
        },
    };
}

describe('isSessionPathWithinRepoRoot', () => {
    it('matches root path and nested paths only', () => {
        expect(isSessionPathWithinRepoRoot('/repo', '/repo')).toBe(true);
        expect(isSessionPathWithinRepoRoot('/repo/apps/ui', '/repo')).toBe(true);
        expect(isSessionPathWithinRepoRoot('/repo-other', '/repo')).toBe(false);
        expect(isSessionPathWithinRepoRoot('/tmp/repo', '/repo')).toBe(false);
    });
});

describe('collectChangedPaths', () => {
    it('returns added, removed and materially changed paths between snapshots', () => {
        const before = makeSnapshot([
            {
                path: 'a.ts',
                previousPath: null,
                kind: 'modified',
                indexStatus: 'M',
                worktreeStatus: ' ',
                hasStagedDelta: true,
                hasUnstagedDelta: false,
                stats: {
                    stagedAdded: 1,
                    stagedRemoved: 0,
                    unstagedAdded: 0,
                    unstagedRemoved: 0,
                    isBinary: false,
                },
            },
            {
                path: 'old.ts',
                previousPath: null,
                kind: 'modified',
                indexStatus: ' ',
                worktreeStatus: 'M',
                hasStagedDelta: false,
                hasUnstagedDelta: true,
                stats: {
                    stagedAdded: 0,
                    stagedRemoved: 0,
                    unstagedAdded: 2,
                    unstagedRemoved: 1,
                    isBinary: false,
                },
            },
        ]);

        const after = makeSnapshot([
            {
                path: 'a.ts',
                previousPath: null,
                kind: 'modified',
                indexStatus: 'M',
                worktreeStatus: 'M',
                hasStagedDelta: true,
                hasUnstagedDelta: true,
                stats: {
                    stagedAdded: 1,
                    stagedRemoved: 0,
                    unstagedAdded: 4,
                    unstagedRemoved: 0,
                    isBinary: false,
                },
            },
            {
                path: 'new.ts',
                previousPath: null,
                kind: 'added',
                indexStatus: 'A',
                worktreeStatus: ' ',
                hasStagedDelta: true,
                hasUnstagedDelta: false,
                stats: {
                    stagedAdded: 8,
                    stagedRemoved: 0,
                    unstagedAdded: 0,
                    unstagedRemoved: 0,
                    isBinary: false,
                },
            },
        ]);

        expect(collectChangedPaths(before, after).sort()).toEqual(['a.ts', 'new.ts', 'old.ts']);
    });
});

describe('shouldAttributeChangedPaths', () => {
    it('returns true when attribution source is mutation, actor is in scope, changes exist, invalidation is fresh, and scope is single-session', () => {
        expect(
            shouldAttributeChangedPaths({
                actorSessionId: 's1',
                actorSource: 'mutation',
                scopeSessionIds: ['s1'],
                changedPathCount: 2,
                invalidatedAt: 1000,
                now: 1000 + ATTRIBUTION_INVALIDATION_WINDOW_MS - 1,
            })
        ).toBe(true);
    });

    it('returns false when multiple sessions are active in the same repository scope', () => {
        expect(
            shouldAttributeChangedPaths({
                actorSessionId: 's1',
                actorSource: 'mutation',
                scopeSessionIds: ['s1', 's2'],
                changedPathCount: 2,
                invalidatedAt: 1000,
                now: 1000 + ATTRIBUTION_INVALIDATION_WINDOW_MS - 1,
            })
        ).toBe(false);
    });

    it('returns false when invalidation source is not mutation', () => {
        expect(
            shouldAttributeChangedPaths({
                actorSessionId: 's1',
                actorSource: 'unknown',
                scopeSessionIds: ['s1'],
                changedPathCount: 2,
                invalidatedAt: 1000,
                now: 1000 + ATTRIBUTION_INVALIDATION_WINDOW_MS - 1,
            })
        ).toBe(false);
    });

    it('returns false when invalidation is stale', () => {
        expect(
            shouldAttributeChangedPaths({
                actorSessionId: 's1',
                actorSource: 'mutation',
                scopeSessionIds: ['s1'],
                changedPathCount: 1,
                invalidatedAt: 1000,
                now: 1000 + ATTRIBUTION_INVALIDATION_WINDOW_MS + 1,
            })
        ).toBe(false);
    });

    it('returns false when actor is missing, out of scope, or no changed paths exist', () => {
        expect(
            shouldAttributeChangedPaths({
                actorSessionId: null,
                actorSource: null,
                scopeSessionIds: ['s1'],
                changedPathCount: 1,
                invalidatedAt: 1000,
                now: 1001,
            })
        ).toBe(false);

        expect(
            shouldAttributeChangedPaths({
                actorSessionId: 's3',
                actorSource: 'mutation',
                scopeSessionIds: ['s1', 's2'],
                changedPathCount: 1,
                invalidatedAt: 1000,
                now: 1001,
            })
        ).toBe(false);

        expect(
            shouldAttributeChangedPaths({
                actorSessionId: 's1',
                actorSource: 'mutation',
                scopeSessionIds: ['s1'],
                changedPathCount: 0,
                invalidatedAt: 1000,
                now: 1001,
            })
        ).toBe(false);
    });
});
