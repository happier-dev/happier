import { describe, expect, it } from 'vitest';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { selectScmChangedFileByPath, selectScmChangedFiles, selectScmChangedFilesForPaths, selectScmConflictFiles, selectScmDeletedPaths, snapshotToScmStatusFiles } from './scmStatusFiles';
import { snapshotToScmStatus } from './scmRepositoryService';
import { gitScmUiPlugin } from './backends/git/plugin';

describe('snapshotToScmStatusFiles', () => {
    it('splits staged and unstaged entries from canonical snapshot', () => {
        const snapshot: ScmWorkingSnapshot = {
            projectKey: 'machine:/repo',
            fetchedAt: 1,
            repo: { isRepo: true, rootPath: '/repo' },
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
                worktreeCreate: true,
                changeSetModel: 'index',
                supportedDiffAreas: ['included', 'pending', 'both'],
            },
            branch: { head: 'main', upstream: 'origin/main', ahead: 1, behind: 0, detached: false },
            stashCount: 0,
            hasConflicts: false,
            entries: [
                {
                    path: 'src/a.ts',
                    previousPath: null,
                    kind: 'modified',
                    includeStatus: 'M',
                    pendingStatus: 'M',
                    hasIncludedDelta: true,
                    hasPendingDelta: true,
                    stats: {
                        includedAdded: 2,
                        includedRemoved: 1,
                        isComplete: false,
                        pendingAdded: 4,
                        pendingRemoved: 0,
                        isBinary: false,
                    },
                },
                {
                    path: 'new.txt',
                    previousPath: null,
                    kind: 'untracked',
                    includeStatus: '?',
                    pendingStatus: '?',
                    hasIncludedDelta: false,
                    hasPendingDelta: true,
                    stats: {
                        includedAdded: 0,
                        includedRemoved: 0,
                        pendingAdded: 0,
                        pendingRemoved: 0,
                        isBinary: false,
                    },
                },
            ],
            totals: {
                includedFiles: 1,
                pendingFiles: 2,
                untrackedFiles: 1,
                includedAdded: 2,
                includedRemoved: 1,
                pendingAdded: 4,
                pendingRemoved: 0,
            },
        };

        const files = snapshotToScmStatusFiles(snapshot);
        expect(files.pendingFiles.find((file) => file.fullPath === "src/a.ts")?.hasIncludedDelta).toBe(true);
        expect(files.pendingFiles.find((file) => file.fullPath === "new.txt")?.hasIncludedDelta).toBe(false);
        expect(files.pendingFiles.find((file) => file.fullPath === "src/a.ts")?.isComplete).toBe(false);

        expect(files.branch).toBe('main');
        expect(files.upstream).toBe('origin/main');
        expect(files.ahead).toBe(1);
        expect(files.behind).toBe(0);
        expect(files.detached).toBe(false);
        expect(files.changeSetModel).toBe('index');
        expect(files.totalIncluded).toBe(1);
        expect(files.totalPending).toBe(2);
        expect(files.includedFiles[0]).toMatchObject({
            fullPath: 'src/a.ts',
            isIncluded: true,
            linesAdded: 2,
            linesRemoved: 1,
        });
        expect(files.pendingFiles.find((item) => item.fullPath === 'src/a.ts')).toMatchObject({
            isIncluded: false,
            linesAdded: 4,
            linesRemoved: 0,
        });
        expect(files.pendingFiles.find((item) => item.fullPath === 'new.txt')?.status).toBe('untracked');
    });

    it('memoizes derived status files per snapshot instance', () => {
        const snapshot: ScmWorkingSnapshot = {
            projectKey: 'machine:/repo',
            fetchedAt: 1,
            repo: { isRepo: true, rootPath: '/repo' },
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
                worktreeCreate: true,
                changeSetModel: 'index',
                supportedDiffAreas: ['included', 'pending', 'both'],
            },
            branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
            stashCount: 0,
            hasConflicts: false,
            entries: [
                {
                    path: 'src/a.ts',
                    previousPath: null,
                    kind: 'modified',
                    includeStatus: 'M',
                    pendingStatus: '',
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
            ],
            totals: {
                includedFiles: 1,
                pendingFiles: 0,
                untrackedFiles: 0,
                includedAdded: 1,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        };

        const first = snapshotToScmStatusFiles(snapshot);
        const second = snapshotToScmStatusFiles(snapshot);
        expect(second).toBe(first);
    });
});

describe('one changed-file truth', () => {
    function entry(path: string, kind: ScmWorkingSnapshot['entries'][number]['kind'], deltas: { included: boolean; pending: boolean }): ScmWorkingSnapshot['entries'][number] {
        return {
            path,
            previousPath: null,
            kind,
            includeStatus: deltas.included ? 'M' : '.',
            pendingStatus: kind === 'untracked' ? '?' : deltas.pending ? 'M' : '.',
            hasIncludedDelta: deltas.included,
            hasPendingDelta: deltas.pending,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
        };
    }

    const snapshot: ScmWorkingSnapshot = {
        projectKey: 'machine:/repo',
        fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/repo' },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries: [
            // Staged and then edited again: one file, present in both areas.
            entry('src/partly-staged.ts', 'modified', { included: true, pending: true }),
            entry('src/edited.ts', 'modified', { included: false, pending: true }),
            entry('notes.md', 'untracked', { included: false, pending: true }),
            // An untracked directory collapsed by porcelain: not a file row.
            entry('scratch/', 'untracked', { included: false, pending: true }),
        ],
        totals: {
            includedFiles: 1,
            pendingFiles: 4,
            untrackedFiles: 2,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 4,
            pendingRemoved: 0,
        },
    };

    it('lists each changed file once, including untracked files and excluding collapsed directories', () => {
        expect(selectScmChangedFiles(snapshot).map((file) => file.fullPath)).toEqual([
            'notes.md',
            'src/edited.ts',
            'src/partly-staged.ts',
        ]);
    });

    it('orders changed paths naturally, so group-2 comes before group-10', () => {
        const numbered: ScmWorkingSnapshot = {
            ...snapshot,
            entries: ['changes/group-10/entry-181.ts', 'changes/group-2/entry-021.ts', 'changes/group-1/entry-020.ts', 'changes/group-1/entry-3.ts']
                .map((path) => entry(path, 'untracked', { included: false, pending: true })),
        };
        expect(selectScmChangedFiles(numbered).map((file) => file.fullPath)).toEqual([
            'changes/group-1/entry-3.ts',
            'changes/group-1/entry-020.ts',
            'changes/group-2/entry-021.ts',
            'changes/group-10/entry-181.ts',
        ]);
    });

    it('reads Recent/session path facts from the admitted 54,935-change projection and observes a changed snapshot', () => {
        const entries = Array.from({ length: 54_935 }, (_, index) => entry(`src/file-${index}.ts`, 'modified', { included: false, pending: true }));
        entries[19] = entry('src/deleted.ts', 'deleted', { included: false, pending: true });
        const full: ScmWorkingSnapshot = { ...snapshot, entries };
        selectScmChangedFiles(full);
        let entryReads = 0;
        for (const item of entries) {
            const kind = item.kind;
            Object.defineProperty(item, 'kind', { get: () => { entryReads += 1; return kind; } });
        }
        for (let open = 0; open < 3; open += 1) {
            expect(selectScmDeletedPaths(full).has('src/deleted.ts')).toBe(true);
            expect(selectScmChangedFileByPath(full, 'src/file-54934.ts')?.linesAdded).toBe(1);
            expect(selectScmChangedFilesForPaths(full, ['src/file-54934.ts', 'src/file-2.ts', 'missing.ts', 'src/file-2.ts'])
                .map(file => file.fullPath)).toEqual(['src/file-2.ts', 'src/file-54934.ts']);
        }
        expect(entryReads).toBe(0);
        const freshEntry = entry('src/fresh.ts', 'modified', { included: false, pending: true });
        const fresh: ScmWorkingSnapshot = { ...full, entries: [{ ...freshEntry, stats: { ...freshEntry.stats, pendingAdded: 7 } }] };
        expect(selectScmChangedFileByPath(fresh, 'src/file-54934.ts')).toBeUndefined();
        expect(selectScmChangedFileByPath(fresh, 'src/fresh.ts')?.linesAdded).toBe(7);
        expect(selectScmDeletedPaths(fresh).size).toBe(0);
    });

    it('gives the aggregate status (badge, tooltip, headers) the same count as the list', () => {
        expect(snapshotToScmStatus(snapshot).changedFileCount).toBe(selectScmChangedFiles(snapshot).length);
        expect(snapshotToScmStatus(snapshot).changedFileCount).toBe(3);
        // The composer's source-control instrument reads the backend's status summary.
        expect(gitScmUiPlugin.statusSummaryMapper(snapshot)?.changedFiles).toBe(3);
    });

    it('keeps canonical ordering for collator-equivalent paths when narrowing to Session paths', () => {
        const tied: ScmWorkingSnapshot = { ...snapshot, entries: ['file-02.ts', 'file-2.ts']
            .map(path => entry(path, 'modified', { included: false, pending: true })) };
        expect(selectScmChangedFilesForPaths(tied, ['file-2.ts', 'file-02.ts']).map(file => file.fullPath))
            .toEqual(selectScmChangedFiles(tied).map(file => file.fullPath));
    });

    it('lists openable conflict files from the same changed-file membership', () => {
        const conflicts: ScmWorkingSnapshot = {
            ...snapshot,
            hasConflicts: true,
            entries: [
                ...snapshot.entries,
                entry('src/conflict.ts', 'conflicted', { included: true, pending: true }),
            ],
        };
        expect(selectScmConflictFiles(conflicts)).toEqual([{ path: 'src/conflict.ts', openPath: 'src/conflict.ts' }]);
    });
});
