import { describe, expect, it } from 'vitest';

import type { ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { snapshotToScmStatusFiles } from '@/scm/scmStatusFiles';

import { fileHasDeltaForArea, indexScmEntriesByPath, toAreaFileStatus } from './scmEntryDelta';

const entry: ScmWorkingEntry = {
    path: 'src/file.ts', previousPath: null, kind: 'modified',
    includeStatus: 'M', pendingStatus: 'M', hasIncludedDelta: true, hasPendingDelta: true,
    stats: { includedAdded: 2, includedRemoved: 3, pendingAdded: 5, pendingRemoved: 7, isBinary: false, isComplete: false },
};
const file: ScmFileStatus = {
    fullPath: entry.path, fileName: 'file.ts', filePath: 'src', status: 'modified',
    isIncluded: false, linesAdded: 7, linesRemoved: 10,
};

describe('Review snapshot entry projection', () => {
    it('reuses the status producer rows when the requested area already matches, at 59k files', () => {
        const entries = Array.from({ length: 59_000 }, (_, index) => ({ ...entry, path: `row${index}.txt` }));
        const snapshot: ScmWorkingSnapshot = {
            projectKey: 'machine:/repo', fetchedAt: 1,
            repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', worktrees: [], remotes: [] },
            capabilities: { capabilityScope: 'local-backend', changeSetModel: 'index', supportedDiffAreas: ['included', 'pending', 'both'],
                readStatus: true, readDiffFile: true, readDiffCommit: true, readLog: true,
                writeInclude: true, writeExclude: true, writeCommit: true, writeCommitPathSelection: true,
                writeCommitLineSelection: true, writeBackout: true, writeRemoteFetch: true,
                writeRemotePull: true, writeRemotePush: true, worktreeCreate: true },
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            stashCount: 0, hasConflicts: false, entries,
            totals: { includedFiles: entries.length, pendingFiles: entries.length, untrackedFiles: 0,
                includedAdded: entries.length * 2, includedRemoved: entries.length * 3,
                pendingAdded: entries.length * 5, pendingRemoved: entries.length * 7 },
        };
        const { pendingFiles, includedFiles } = snapshotToScmStatusFiles(snapshot);
        const byPath = indexScmEntriesByPath(entries);
        for (const [area, files] of [['pending', pendingFiles], ['included', includedFiles]] as const) {
            const projected = files.map(file => toAreaFileStatus(file, byPath.get(file.fullPath)!, area));
            expect(projected.filter((file, index) => file !== files[index])).toHaveLength(0);
        }
    });
    it('indexes a large snapshot without allocating a normalized copy for each entry', () => {
        const entries = Array.from({ length: 59_448 }, (_, index) => ({ ...entry, path: `row${index}.txt` }));
        const byPath = indexScmEntriesByPath(entries);
        expect(byPath.size).toBe(entries.length);
        expect(byPath.get(entries[0]!.path)).toBe(entries[0]);
        expect(byPath.get(entries.at(-1)!.path)).toBe(entries.at(-1));
    });

    it('preserves both areas, incomplete counts, and pending-only additions', () => {
        const delta = indexScmEntriesByPath([entry]).get(entry.path)!;
        expect(toAreaFileStatus(file, delta, 'included')).toMatchObject({ isIncluded: true, linesAdded: 2, linesRemoved: 3, isComplete: false });
        expect(toAreaFileStatus(file, delta, 'pending')).toMatchObject({ isIncluded: false, linesAdded: 5, linesRemoved: 7, isComplete: false });
        expect(toAreaFileStatus(file, delta, 'both')).toMatchObject({ linesAdded: 7, linesRemoved: 10, isComplete: false });
        const added = { ...entry, kind: 'untracked' as const, hasIncludedDelta: false, stats: { ...entry.stats, isBinary: true } };
        const indexed = indexScmEntriesByPath([added]).get(added.path)!;
        expect(fileHasDeltaForArea(file, indexed, 'included')).toBe(false);
        expect(fileHasDeltaForArea(file, indexed, 'pending')).toBe(true);
    });
});
