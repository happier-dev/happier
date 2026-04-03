import { describe, expect, it } from 'vitest';

import { buildWorkspaceChangedFilesData } from './buildWorkspaceChangedFilesData';

describe('buildWorkspaceChangedFilesData', () => {
    it('returns empty data when snapshot is null or not a repo', () => {
        expect(buildWorkspaceChangedFilesData({ scmSnapshot: null })).toEqual({
            scmStatusFiles: null,
            changedFilesCount: 0,
            allRepositoryChangedFiles: [],
        });

        expect(
            buildWorkspaceChangedFilesData({
                scmSnapshot: {
                    projectKey: 'p',
                    fetchedAt: 1,
                    repo: { isRepo: false, rootPath: null, backendId: null, mode: null },
                    capabilities: {},
                    branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
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
                } as any,
            }),
        ).toEqual({
            scmStatusFiles: null,
            changedFilesCount: 0,
            allRepositoryChangedFiles: [],
        });
    });

    it('counts and returns merged changed files for a repo snapshot', () => {
        const result = buildWorkspaceChangedFilesData({
            scmSnapshot: {
                projectKey: 'p',
                fetchedAt: 1,
                repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                capabilities: {},
                branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                stashCount: 0,
                hasConflicts: false,
                entries: [
                    {
                        kind: 'modified',
                        path: 'a.txt',
                        hasIncludedDelta: false,
                        hasPendingDelta: true,
                        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
                        previousPath: null,
                    },
                    {
                        kind: 'modified',
                        path: 'b.txt',
                        hasIncludedDelta: true,
                        hasPendingDelta: false,
                        stats: { includedAdded: 0, includedRemoved: 2, pendingAdded: 0, pendingRemoved: 0, isBinary: false },
                        previousPath: null,
                    },
                ],
                totals: {
                    includedFiles: 1,
                    pendingFiles: 1,
                    untrackedFiles: 0,
                    includedAdded: 0,
                    includedRemoved: 2,
                    pendingAdded: 1,
                    pendingRemoved: 0,
                },
            } as any,
        });

        expect(result.changedFilesCount).toBe(2);
        expect(result.allRepositoryChangedFiles.map((f) => f.fullPath)).toEqual(['a.txt', 'b.txt']);
    });
});
