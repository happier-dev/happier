import { describe, expect, it } from 'vitest';

import type { ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { areScmWorkingSnapshotsEquivalentIgnoringFetchedAt, collectChangedPaths } from './snapshotDiff';

function entry(path: string): ScmWorkingEntry {
    return {
        path,
        previousPath: null,
        kind: 'modified',
        includeStatus: ' ',
        pendingStatus: 'M',
        hasIncludedDelta: false,
        hasPendingDelta: true,
        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
    };
}

function snapshot(entries: ScmWorkingEntry[], overrides?: Partial<ScmWorkingSnapshot>): ScmWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/repo' },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries,
        totals: {
            includedFiles: 0,
            pendingFiles: entries.length,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: entries.length,
            pendingRemoved: 0,
        },
        ...overrides,
    };
}

describe('collectChangedPaths', () => {
    it('reports added and removed paths between complete snapshots', () => {
        expect(collectChangedPaths(snapshot([entry('a.ts'), entry('b.ts')]), snapshot([entry('a.ts'), entry('c.ts')])).sort())
            .toEqual(['b.ts', 'c.ts']);
    });

    it('reports nothing when either side carries only a truncated prefix of the entries', () => {
        const complete = snapshot([entry('a.ts'), entry('b.ts')]);
        const truncated = snapshot([entry('a.ts')], { entriesPresentation: 'truncated' });

        expect(collectChangedPaths(complete, truncated)).toEqual([]);
        expect(collectChangedPaths(truncated, complete)).toEqual([]);
    });
});

describe('areScmWorkingSnapshotsEquivalentIgnoringFetchedAt', () => {
    it('treats a truncated and a complete snapshot with the same shipped entries as different', () => {
        const entries = [entry('a.ts')];
        expect(areScmWorkingSnapshotsEquivalentIgnoringFetchedAt(
            snapshot(entries),
            snapshot(entries, { entriesPresentation: 'truncated' }),
        )).toBe(false);
    });
});
