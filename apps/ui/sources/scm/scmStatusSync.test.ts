import { describe, expect, it } from 'vitest';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    ATTRIBUTION_INVALIDATION_WINDOW_MS,
    collectChangedPaths,
    isSessionPathWithinRepoRoot,
    shouldAttributeChangedPaths,
} from './scmStatusSync';

function makeSnapshot(entries: ScmWorkingSnapshot['entries']): ScmWorkingSnapshot {
    return {
        projectKey: 'm:/repo',
        fetchedAt: Date.now(),
        repo: { isRepo: true, rootPath: '/repo' },
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries,
        totals: {
            includedFiles: entries.filter((e) => e.hasIncludedDelta).length,
            pendingFiles: entries.filter((e) => e.hasPendingDelta).length,
            untrackedFiles: entries.filter((e) => e.kind === 'untracked').length,
            includedAdded: entries.reduce((acc, e) => acc + e.stats.includedAdded, 0),
            includedRemoved: entries.reduce((acc, e) => acc + e.stats.includedRemoved, 0),
            pendingAdded: entries.reduce((acc, e) => acc + e.stats.pendingAdded, 0),
            pendingRemoved: entries.reduce((acc, e) => acc + e.stats.pendingRemoved, 0),
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

    it('treats tilde-prefixed session paths as in-scope when they match the repo root', () => {
        expect(isSessionPathWithinRepoRoot('~/Documents/Development/happier/dev', '/Documents/Development/happier/dev')).toBe(true);
        expect(isSessionPathWithinRepoRoot('~/repo', '/repo')).toBe(true);
        expect(isSessionPathWithinRepoRoot('~/repo-other', '/repo')).toBe(false);
    });
});

describe('collectChangedPaths', () => {
    it('returns added, removed and materially changed paths between snapshots', () => {
        const before = makeSnapshot([
            {
                path: 'a.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: 'M',
                pendingStatus: ' ',
                hasIncludedDelta: true,
                hasPendingDelta: false,
                stats: {
                    includedAdded: 1,
                    includedRemoved: 0,
                    pendingAdded: 0,
                    pendingRemoved: 0,
                    isBinary: false,
                },
            },
            {
                path: 'old.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: ' ',
                pendingStatus: 'M',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: {
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 2,
                    pendingRemoved: 1,
                    isBinary: false,
                },
            },
        ]);

        const after = makeSnapshot([
            {
                path: 'a.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: 'M',
                pendingStatus: 'M',
                hasIncludedDelta: true,
                hasPendingDelta: true,
                stats: {
                    includedAdded: 1,
                    includedRemoved: 0,
                    pendingAdded: 4,
                    pendingRemoved: 0,
                    isBinary: false,
                },
            },
            {
                path: 'new.ts',
                previousPath: null,
                kind: 'added',
                includeStatus: 'A',
                pendingStatus: ' ',
                hasIncludedDelta: true,
                hasPendingDelta: false,
                stats: {
                    includedAdded: 8,
                    includedRemoved: 0,
                    pendingAdded: 0,
                    pendingRemoved: 0,
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
