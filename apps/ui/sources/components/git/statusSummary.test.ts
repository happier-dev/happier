import { describe, expect, it } from 'vitest';

import type { GitWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { buildGitStatusSummaryFromSnapshot } from './statusSummary';

function buildSnapshot(overrides?: Partial<GitWorkingSnapshot>): GitWorkingSnapshot {
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

describe('buildGitStatusSummaryFromSnapshot', () => {
    it('returns null when snapshot is missing or not a git repo', () => {
        expect(buildGitStatusSummaryFromSnapshot(null)).toBeNull();
        expect(
            buildGitStatusSummaryFromSnapshot(
                buildSnapshot({
                    repo: { isRepo: false, rootPath: null },
                })
            )
        ).toBeNull();
    });

    it('computes staged + unstaged line deltas and changed file count from canonical totals', () => {
        const summary = buildGitStatusSummaryFromSnapshot(
            buildSnapshot({
                branch: {
                    head: 'feature/branch',
                    upstream: 'origin/feature/branch',
                    ahead: 2,
                    behind: 1,
                    detached: false,
                },
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
            changedFiles: 9,
            linesAdded: 18,
            linesRemoved: 12,
            hasLineChanges: true,
            hasAnyChanges: true,
        });
    });

    it('handles detached head without changes', () => {
        const summary = buildGitStatusSummaryFromSnapshot(
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
