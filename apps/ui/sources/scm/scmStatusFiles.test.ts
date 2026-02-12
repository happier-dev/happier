import { describe, expect, it } from 'vitest';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { snapshotToScmStatusFiles } from './scmStatusFiles';

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
                workspaceWorktreeCreate: true,
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
});
