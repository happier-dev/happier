import { describe, expect, it } from 'vitest';

import type { ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { buildScmStatusSummaryFromSnapshot } from './statusSummary';

function buildSnapshot(overrides?: Partial<ScmWorkingSnapshot>): ScmWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: Date.now(),
        repo: {
            isRepo: true,
            rootPath: '/repo',
        },
        branch: {
            head: 'main',
            upstream: 'origin/main',
            ahead: 0,
            behind: 0,
            detached: false,
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
        ...overrides,
    };
}

describe('buildScmStatusSummaryFromSnapshot', () => {
    it('returns null when snapshot is missing or not a git repo', () => {
        expect(buildScmStatusSummaryFromSnapshot(null)).toBeNull();
        expect(
            buildScmStatusSummaryFromSnapshot(
                buildSnapshot({
                    repo: { isRepo: false, rootPath: null },
                })
            )
        ).toBeNull();
    });

    it('computes line deltas from totals and changed file count from entry list', () => {
        const summary = buildScmStatusSummaryFromSnapshot(
            buildSnapshot({
                branch: {
                    head: 'feature/branch',
                    upstream: 'origin/feature/branch',
                    ahead: 2,
                    behind: 1,
                    detached: false,
                },
                entries: [
                    { path: 'a.txt', previousPath: null, kind: 'modified', includeStatus: 'M', pendingStatus: ' ', hasIncludedDelta: true, hasPendingDelta: false, stats: { includedAdded: 1, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0, isBinary: false } },
                    { path: 'b.txt', previousPath: null, kind: 'modified', includeStatus: ' ', pendingStatus: 'M', hasIncludedDelta: false, hasPendingDelta: true, stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 2, pendingRemoved: 1, isBinary: false } },
                    { path: 'c.txt', previousPath: null, kind: 'untracked', includeStatus: '?', pendingStatus: '?', hasIncludedDelta: false, hasPendingDelta: true, stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 3, pendingRemoved: 0, isBinary: false } },
                    { path: 'd.txt', previousPath: null, kind: 'added', includeStatus: 'A', pendingStatus: ' ', hasIncludedDelta: true, hasPendingDelta: false, stats: { includedAdded: 4, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0, isBinary: false } },
                    { path: 'e.txt', previousPath: null, kind: 'deleted', includeStatus: 'D', pendingStatus: ' ', hasIncludedDelta: true, hasPendingDelta: false, stats: { includedAdded: 0, includedRemoved: 5, pendingAdded: 0, pendingRemoved: 0, isBinary: false } },
                ] satisfies ScmWorkingEntry[],
                totals: {
                    includedFiles: 3,
                    pendingFiles: 4,
                    untrackedFiles: 2,
                    includedAdded: 10,
                    includedRemoved: 5,
                    pendingAdded: 8,
                    pendingRemoved: 7,
                },
            })
        );

        expect(summary).toEqual({
            branch: 'feature/branch',
            upstream: 'origin/feature/branch',
            ahead: 2,
            behind: 1,
            changedFiles: 5,
            linesAdded: 18,
            linesRemoved: 12,
            hasLineChanges: true,
            hasAnyChanges: true,
        });
    });

    it('handles detached head without changes', () => {
        const summary = buildScmStatusSummaryFromSnapshot(
            buildSnapshot({
                branch: {
                    head: null,
                    upstream: null,
                    ahead: 0,
                    behind: 0,
                    detached: true,
                },
            })
        );

        expect(summary).toEqual({
            branch: null,
            upstream: null,
            ahead: 0,
            behind: 0,
            changedFiles: 0,
            linesAdded: 0,
            linesRemoved: 0,
            hasLineChanges: false,
            hasAnyChanges: false,
        });
    });
});
