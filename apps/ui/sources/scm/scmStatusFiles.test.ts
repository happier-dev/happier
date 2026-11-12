import { describe, expect, it } from 'vitest';

import type { ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { buildScmStatusFilesFromEntries, snapshotToScmStatusFiles } from './scmStatusFiles';

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

function makeEntry(path: string, overrides?: Partial<ScmWorkingEntry>): ScmWorkingEntry {
    return {
        path,
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
        ...overrides,
    };
}

function makeSnapshot(entries: ScmWorkingEntry[]): ScmWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries,
        totals: {
            includedFiles: 0,
            pendingFiles: entries.length,
            untrackedFiles: entries.length,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    };
}

describe('scmStatusFiles directory-entry handling', () => {
    it('renders a collapsed directory row without the malformed name split and marks it non-actionable', () => {
        const files = snapshotToScmStatusFiles(makeSnapshot([
            makeEntry('D/', { isDirectory: true, untrackedFileCount: 30000 }),
        ]));

        const dirRow = files.pendingFiles.find((file) => file.fullPath === 'D/');
        expect(dirRow).toBeDefined();
        expect(dirRow?.isDirectory).toBe(true);
        expect(dirRow?.fileName).toBe('D');
        expect(dirRow?.filePath).toBe('');
    });

    it('keeps file rows byte-identical to the legacy shape', () => {
        const files = snapshotToScmStatusFiles(makeSnapshot([
            makeEntry('src/app.ts', { kind: 'modified' }),
        ]));

        const row = files.pendingFiles[0];
        expect(row?.fileName).toBe('app.ts');
        expect(row?.filePath).toBe('src');
        expect(row?.fullPath).toBe('src/app.ts');
        expect(row?.isDirectory).toBeUndefined();
    });

    it('builds the row projection from an explicit entries list (entries window source)', () => {
        const snapshot = makeSnapshot([]);
        const files = buildScmStatusFilesFromEntries([
            makeEntry('D/', { isDirectory: true, untrackedFileCount: 30000 }),
            makeEntry('loose.ts'),
        ], snapshot);

        expect(files.pendingFiles).toHaveLength(2);
        expect(files.branch).toBe('main');
        expect(files.changeSetModel).toBe('index');
        expect(files.pendingFiles.find((file) => file.fullPath === 'loose.ts')?.fileName).toBe('loose.ts');
        expect(files.pendingFiles.find((file) => file.fullPath === 'D/')?.isDirectory).toBe(true);
    });
});
