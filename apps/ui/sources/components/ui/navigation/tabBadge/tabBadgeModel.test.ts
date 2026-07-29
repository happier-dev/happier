import { describe, expect, it } from 'vitest';

import type { ScmStatus } from '@/sync/domains/state/storageTypes';

import { formatBadgeCount, formatScmDiffBadge, resolveGitTabBadge } from './tabBadgeModel';

function makeScmStatus(overrides: Partial<ScmStatus>): ScmStatus {
    return {
        branch: 'main',
        isDirty: false,
        modifiedCount: 0,
        untrackedCount: 0,
        includedCount: 0,
        lastUpdatedAt: 0,
        includedLinesAdded: 0,
        includedLinesRemoved: 0,
        pendingLinesAdded: 0,
        pendingLinesRemoved: 0,
        linesAdded: 0,
        linesRemoved: 0,
        linesChanged: 0,
        ...overrides,
    };
}

describe('formatBadgeCount', () => {
    it('renders the raw count below the cap', () => {
        expect(formatBadgeCount(3)).toBe('3');
        expect(formatBadgeCount(99)).toBe('99');
    });

    it('caps with a trailing plus above the cap', () => {
        expect(formatBadgeCount(100)).toBe('99+');
        expect(formatBadgeCount(4200, 999)).toBe('999+');
    });

    it('clamps negative and non-finite values to zero', () => {
        expect(formatBadgeCount(-5)).toBe('0');
        expect(formatBadgeCount(Number.NaN)).toBe('0');
    });
});

describe('formatScmDiffBadge', () => {
    it('returns null for missing status', () => {
        expect(formatScmDiffBadge(null)).toBeNull();
        expect(formatScmDiffBadge(undefined)).toBeNull();
    });

    it('returns null when there are no changes to surface', () => {
        expect(formatScmDiffBadge(makeScmStatus({ isDirty: false }))).toBeNull();
    });

    it('surfaces added/removed lines and modified file count', () => {
        expect(formatScmDiffBadge(makeScmStatus({
            isDirty: true,
            modifiedCount: 3,
            linesAdded: 42,
            linesRemoved: 8,
        }))).toEqual({ added: 42, removed: 8, modifiedCount: 3 });
    });

    it('surfaces a badge when only the file count is known', () => {
        expect(formatScmDiffBadge(makeScmStatus({
            isDirty: true,
            modifiedCount: 2,
        }))).toEqual({ added: 0, removed: 0, modifiedCount: 2 });
    });

    it('floors and clamps malformed counts', () => {
        expect(formatScmDiffBadge(makeScmStatus({
            linesAdded: 5.9,
            linesRemoved: -3,
            modifiedCount: 1,
        }))).toEqual({ added: 5, removed: 0, modifiedCount: 1 });
    });
});

describe('resolveGitTabBadge', () => {
    const dirty = makeScmStatus({ isDirty: true, modifiedCount: 3, linesAdded: 42, linesRemoved: 8 });

    it('hides the badge when mode is off', () => {
        expect(resolveGitTabBadge('off', dirty)).toBeNull();
    });

    it('hides the badge for a clean tree in any mode', () => {
        expect(resolveGitTabBadge('changedFiles', makeScmStatus({}))).toBeNull();
        expect(resolveGitTabBadge('diffLines', makeScmStatus({}))).toBeNull();
    });

    it('shows a changed-files count by default', () => {
        expect(resolveGitTabBadge('changedFiles', dirty)).toEqual({ kind: 'count', value: 3 });
    });

    it('shows the added/removed line chip in diffLines mode', () => {
        expect(resolveGitTabBadge('diffLines', dirty)).toEqual({ kind: 'diff', added: 42, removed: 8, modifiedCount: 3 });
    });

    it('omits the changed-files count when only line changes are known (no file count)', () => {
        const linesOnly = makeScmStatus({ isDirty: true, modifiedCount: 0, linesAdded: 5, linesRemoved: 1 });
        expect(resolveGitTabBadge('changedFiles', linesOnly)).toBeNull();
        expect(resolveGitTabBadge('diffLines', linesOnly)).toEqual({ kind: 'diff', added: 5, removed: 1, modifiedCount: 0 });
    });
});
