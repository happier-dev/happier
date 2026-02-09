import { describe, expect, it } from 'vitest';

import type { GitWorkingSnapshot } from '../domains/state/storageTypes';
import { snapshotToGitStatusFiles } from './gitStatusFiles';

describe('snapshotToGitStatusFiles', () => {
    it('splits staged and unstaged entries from canonical snapshot', () => {
        const snapshot: GitWorkingSnapshot = {
            projectKey: 'machine:/repo',
            fetchedAt: 1,
            repo: { isGitRepo: true, rootPath: '/repo' },
            branch: { head: 'main', upstream: 'origin/main', ahead: 1, behind: 0, detached: false },
            stashCount: 0,
            hasConflicts: false,
            entries: [
                {
                    path: 'src/a.ts',
                    previousPath: null,
                    kind: 'modified',
                    indexStatus: 'M',
                    worktreeStatus: 'M',
                    hasStagedDelta: true,
                    hasUnstagedDelta: true,
                    stats: {
                        stagedAdded: 2,
                        stagedRemoved: 1,
                        unstagedAdded: 4,
                        unstagedRemoved: 0,
                        isBinary: false,
                    },
                },
                {
                    path: 'new.txt',
                    previousPath: null,
                    kind: 'untracked',
                    indexStatus: '?',
                    worktreeStatus: '?',
                    hasStagedDelta: false,
                    hasUnstagedDelta: true,
                    stats: {
                        stagedAdded: 0,
                        stagedRemoved: 0,
                        unstagedAdded: 0,
                        unstagedRemoved: 0,
                        isBinary: false,
                    },
                },
            ],
            totals: {
                stagedFiles: 1,
                unstagedFiles: 2,
                untrackedFiles: 1,
                stagedAdded: 2,
                stagedRemoved: 1,
                unstagedAdded: 4,
                unstagedRemoved: 0,
            },
        };

        const files = snapshotToGitStatusFiles(snapshot);

        expect(files.branch).toBe('main');
        expect(files.upstream).toBe('origin/main');
        expect(files.ahead).toBe(1);
        expect(files.behind).toBe(0);
        expect(files.detached).toBe(false);
        expect(files.totalStaged).toBe(1);
        expect(files.totalUnstaged).toBe(2);
        expect(files.stagedFiles[0]).toMatchObject({
            fullPath: 'src/a.ts',
            isStaged: true,
            linesAdded: 2,
            linesRemoved: 1,
        });
        expect(files.unstagedFiles.find((item) => item.fullPath === 'src/a.ts')).toMatchObject({
            isStaged: false,
            linesAdded: 4,
            linesRemoved: 0,
        });
        expect(files.unstagedFiles.find((item) => item.fullPath === 'new.txt')?.status).toBe('untracked');
    });
});
