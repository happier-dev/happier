import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import type { GitWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { useChangedFilesData, type UseChangedFilesDataResult } from './useChangedFilesData';

// Align with React test-renderer act requirements in this suite.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeSnapshot(): GitWorkingSnapshot {
    return {
        projectKey: 'm:/repo',
        fetchedAt: 1,
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
        entries: [
            {
                path: 'src/a.ts',
                previousPath: null,
                kind: 'modified',
                indexStatus: '.',
                worktreeStatus: 'M',
                hasStagedDelta: false,
                hasUnstagedDelta: true,
                stats: {
                    stagedAdded: 0,
                    stagedRemoved: 0,
                    unstagedAdded: 2,
                    unstagedRemoved: 1,
                    isBinary: false,
                },
            },
        ],
        totals: {
            stagedFiles: 0,
            unstagedFiles: 1,
            untrackedFiles: 0,
            stagedAdded: 0,
            stagedRemoved: 0,
            unstagedAdded: 2,
            unstagedRemoved: 1,
        },
    };
}

describe('useChangedFilesData', () => {
    it('includes inferred session attribution when reliability is high', () => {
        let latest: UseChangedFilesDataResult | null = null;

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                gitSnapshot: makeSnapshot(),
                touchedPaths: ['src/a.ts'],
                operationLog: [],
                projectSessionIds: ['s1'],
                searchQuery: '',
                showAllRepositoryFiles: false,
            });
            return null;
        }

        let root: renderer.ReactTestRenderer;
        act(() => {
            root = renderer.create(<Test />);
        });

        expect(latest).not.toBeNull();
        if (!latest) {
            throw new Error('Expected hook result');
        }
        const result: UseChangedFilesDataResult = latest;
        expect(result.attributionReliability).toBe('high');
        expect(result.shouldShowAllFiles).toBe(false);
        expect(result.showSessionViewToggle).toBe(true);
        expect(result.sessionAttributedFiles).toHaveLength(1);
        expect(result.sessionAttributedFiles[0]?.confidence).toBe('inferred');
        expect(result.suppressedInferredCount).toBe(0);
        act(() => {
            root!.unmount();
        });
    });

    it('suppresses inferred attribution when multiple sessions are active', () => {
        let latest: UseChangedFilesDataResult | null = null;

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                gitSnapshot: makeSnapshot(),
                touchedPaths: ['src/a.ts'],
                operationLog: [],
                projectSessionIds: ['s1', 's2'],
                searchQuery: '',
                showAllRepositoryFiles: false,
            });
            return null;
        }

        let root: renderer.ReactTestRenderer;
        act(() => {
            root = renderer.create(<Test />);
        });

        expect(latest).not.toBeNull();
        if (!latest) {
            throw new Error('Expected hook result');
        }
        const result: UseChangedFilesDataResult = latest;
        expect(result.attributionReliability).toBe('limited');
        expect(result.showSessionViewToggle).toBe(false);
        expect(result.sessionAttributedFiles).toHaveLength(0);
        expect(result.repositoryOnlyFiles).toHaveLength(1);
        expect(result.suppressedInferredCount).toBe(1);
        act(() => {
            root!.unmount();
        });
    });

    it('keeps session view toggle available in limited mode when direct attribution exists', () => {
        let latest: UseChangedFilesDataResult | null = null;

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                gitSnapshot: makeSnapshot(),
                touchedPaths: ['src/a.ts'],
                operationLog: [
                    {
                        id: 'log-1',
                        sessionId: 's1',
                        operation: 'stage',
                        status: 'success',
                        timestamp: 1,
                        path: 'src/a.ts',
                    },
                ],
                projectSessionIds: ['s1', 's2'],
                searchQuery: '',
                showAllRepositoryFiles: false,
            });
            return null;
        }

        let root: renderer.ReactTestRenderer;
        act(() => {
            root = renderer.create(<Test />);
        });

        expect(latest).not.toBeNull();
        if (!latest) {
            throw new Error('Expected hook result');
        }
        const result: UseChangedFilesDataResult = latest;
        expect(result.attributionReliability).toBe('limited');
        expect(result.showSessionViewToggle).toBe(true);
        expect(result.sessionAttributedFiles).toHaveLength(1);
        expect(result.sessionAttributedFiles[0]?.confidence).toBe('high');
        act(() => {
            root!.unmount();
        });
    });
});
