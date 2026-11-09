import { describe, expect, it } from 'vitest';

import type { ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { selectScmChangedFiles } from '@/scm/scmStatusFiles';
import { buildSessionScmSummary } from './statusSummary';

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

describe('buildSessionScmSummary', () => {
    it('does not rescan 55k unchanged file statistics for repeated summary reads and keeps changed totals current', () => {
        let reads = 0;
        const stats = { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false };
        const entries: ScmWorkingEntry[] = Array.from({ length: 55_000 }, (_, index) => ({
            path: `src/file-${index}.ts`, previousPath: null, kind: 'modified', includeStatus: ' ', pendingStatus: 'M',
            hasIncludedDelta: false, hasPendingDelta: true, get stats() { reads++; return stats; },
        }));
        const snapshot = buildSnapshot({ entries, totals: {
            includedFiles: 0, pendingFiles: entries.length, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0,
            pendingAdded: entries.length, pendingRemoved: 0,
        } });
        expect(buildSessionScmSummary(snapshot)?.linesAdded).toBe(55_000);
        reads = 0;
        for (let index = 0; index < 3; index++) expect(buildSessionScmSummary(snapshot)?.linesAdded).toBe(55_000);
        expect(reads).toBe(0);
        const changed = { ...snapshot, entries: [{ ...entries[0]!, stats: { ...stats, pendingAdded: 2 } }, ...entries.slice(1)],
            totals: { ...snapshot.totals, pendingAdded: 55_001 } };
        expect(buildSessionScmSummary(changed)?.linesAdded).toBe(55_001);
    });

    it('excludes media and binary line statistics while retaining both text change areas and every file', () => {
        const entries: ScmWorkingEntry[] = ['a.ts', 'b.pdf', 'c.png', 'd.mp4', 'e.mp3', 'f.dat'].map((path) => ({
            path, previousPath: null, kind: 'modified', includeStatus: 'M', pendingStatus: 'M',
            hasIncludedDelta: true, hasPendingDelta: true,
            stats: { includedAdded: 2, includedRemoved: 1, pendingAdded: 3, pendingRemoved: 4, isBinary: path === 'f.dat' },
        }));
        const totals = { includedFiles: 6, pendingFiles: 6, untrackedFiles: 0, includedAdded: 12, includedRemoved: 6, pendingAdded: 18, pendingRemoved: 24 };
        expect(buildSessionScmSummary(buildSnapshot({ entries, totals }))).toMatchObject({
            changedFiles: 6, linesAdded: 5, linesRemoved: 5, hasLineChanges: true,
        });
        expect(buildSessionScmSummary(buildSnapshot({ entries: entries.slice(1), totals: {
            ...totals, includedAdded: 10, includedRemoved: 5, pendingAdded: 15, pendingRemoved: 20,
        } }))).toMatchObject({ changedFiles: 5, linesAdded: 0, linesRemoved: 0, hasLineChanges: false, hasAnyChanges: true });
    });

    it('returns null when snapshot is missing or not a git repo', () => {
        expect(buildSessionScmSummary(null)).toBeNull();
        expect(
            buildSessionScmSummary(
                buildSnapshot({
                    repo: { isRepo: false, rootPath: null },
                })
            )
        ).toBeNull();
    });

    it('computes line deltas from totals and changed file count from entry list', () => {
        const summary = buildSessionScmSummary(
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

        expect(summary).toMatchObject({
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
        const summary = buildSessionScmSummary(
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

        expect(summary).toMatchObject({
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

    it('counts exactly the changed-file list: collapsed directories and stale totals never reach the count', () => {
        const entry = (path: string, kind: ScmWorkingEntry['kind']): ScmWorkingEntry => ({
            path, previousPath: null, kind, includeStatus: '.', pendingStatus: kind === 'untracked' ? '?' : 'M',
            hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
        });
        const snapshot = buildSnapshot({
            entries: [entry('a.txt', 'modified'), entry('notes.md', 'untracked'), entry('scratch/', 'untracked')],
            totals: { includedFiles: 0, pendingFiles: 3, untrackedFiles: 2, includedAdded: 0, includedRemoved: 0, pendingAdded: 3, pendingRemoved: 0 },
        });
        expect(buildSessionScmSummary(snapshot)?.changedFiles).toBe(selectScmChangedFiles(snapshot).length);
        expect(buildSessionScmSummary(snapshot)?.changedFiles).toBe(2);

        // An empty list is no changes, whatever the totals say.
        const empty = buildSnapshot({ totals: { includedFiles: 1, pendingFiles: 1, untrackedFiles: 1, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 } });
        expect(buildSessionScmSummary(empty)).toMatchObject({ changedFiles: 0, hasAnyChanges: false });
    });

    it('exposes the same complete file projection and observation time for the Changes glance', () => {
        const entry = (path: string): ScmWorkingEntry => ({
            path, previousPath: null, kind: 'modified', includeStatus: 'M', pendingStatus: 'M',
            hasIncludedDelta: true, hasPendingDelta: true,
            stats: { includedAdded: 1, includedRemoved: 0, pendingAdded: 2, pendingRemoved: 1, isBinary: false },
        });
        const snapshot = buildSnapshot({
            fetchedAt: 1234,
            entries: [entry('z.ts'), entry('a.ts'), entry('b.ts'), entry('c.ts')],
            totals: { includedFiles: 4, pendingFiles: 4, untrackedFiles: 0, includedAdded: 4, includedRemoved: 0, pendingAdded: 8, pendingRemoved: 4, isComplete: false },
        });
        const summary = buildSessionScmSummary(snapshot);
        expect(summary).toMatchObject({ fetchedAt: 1234, changedFiles: 4, isComplete: false });
        expect(summary?.files).toBe(selectScmChangedFiles(snapshot));
        expect(summary?.files.map((file) => file.fullPath)).toEqual(['a.ts', 'b.ts', 'c.ts', 'z.ts']);
        expect(summary?.files[0]?.linesAdded).toBe(2);
    });
});
