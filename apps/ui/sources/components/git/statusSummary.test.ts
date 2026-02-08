import { describe, expect, it } from 'vitest';

import type { GitWorkingSnapshot } from '@/sync/storageTypes';
import { buildGitStatusSummaryFromSnapshot } from './statusSummary';

function buildSnapshot(overrides?: Partial<GitWorkingSnapshot>): GitWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: Date.now(),
        repo: {
            isGitRepo: true,
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
            stagedFiles: 0,
            unstagedFiles: 0,
            untrackedFiles: 0,
            stagedAdded: 0,
            stagedRemoved: 0,
            unstagedAdded: 0,
            unstagedRemoved: 0,
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
                    repo: { isGitRepo: false, rootPath: null },
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
                    stagedFiles: 3,
                    unstagedFiles: 4,
                    untrackedFiles: 2,
                    stagedAdded: 10,
                    stagedRemoved: 5,
                    unstagedAdded: 8,
                    unstagedRemoved: 7,
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
