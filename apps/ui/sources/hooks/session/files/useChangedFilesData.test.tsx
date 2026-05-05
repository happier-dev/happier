import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { SessionChangeSet } from '@happier-dev/protocol';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { useChangedFilesData, type UseChangedFilesDataResult } from './useChangedFilesData';
import { renderScreen } from '@/dev/testkit';


// Align with React test-renderer act requirements in this suite.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeSnapshot(): ScmWorkingSnapshot {
    return {
        projectKey: 'm:/repo',
        fetchedAt: 1,
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
        entries: [
            {
                path: 'src/a.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: '.',
                pendingStatus: 'M',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: {
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 2,
                    pendingRemoved: 1,
                    isBinary: false,
                },
            },
        ],
        totals: {
            includedFiles: 0,
            pendingFiles: 1,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 2,
            pendingRemoved: 1,
        },
    };
}

function makeProviderChangeSet(filePath: string): SessionChangeSet {
    return {
        sessionId: 's1',
        turns: [],
        files: [{
            filePath,
            changeKind: 'modified',
            oldText: null,
            newText: null,
            source: 'provider_native',
            confidence: 'exact',
            provider: 'codex',
            turns: ['turn_1'],
        }],
        rolledBackTurnIds: [],
        confidenceSummary: {
            source: 'provider_native',
            confidence: 'exact',
        },
    };
}

describe('useChangedFilesData', () => {
    it('can skip attribution computation for repository-only surfaces', async () => {
        let latest: UseChangedFilesDataResult | null = null;

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
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
                projectSessionIds: ['s1'],
                searchQuery: '',
                showAllRepositoryFiles: false,
                computeAttribution: false,
            });
            return null;
        }

        let root: renderer.ReactTestRenderer;
        root = (await renderScreen(<Test />)).tree;

        expect(latest).not.toBeNull();
        if (!latest) {
            throw new Error('Expected hook result');
        }
        const result: UseChangedFilesDataResult = latest;
        expect(result.showSessionViewToggle).toBe(false);
        expect(result.sessionAttributedFiles).toHaveLength(0);
        expect(result.repositoryOnlyFiles).toHaveLength(1);
        expect(result.suppressedInferredCount).toBe(0);
        act(() => {
            root!.unmount();
        });
    });

    it('includes inferred session attribution when reliability is high', async () => {
        let latest: UseChangedFilesDataResult | null = null;

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
                touchedPaths: ['src/a.ts'],
                operationLog: [],
                projectSessionIds: ['s1'],
                searchQuery: '',
                showAllRepositoryFiles: false,
            });
            return null;
        }

        let root: renderer.ReactTestRenderer;
        root = (await renderScreen(<Test />)).tree;

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

    it('suppresses inferred attribution when multiple sessions are active', async () => {
        let latest: UseChangedFilesDataResult | null = null;

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
                touchedPaths: ['src/a.ts'],
                operationLog: [],
                projectSessionIds: ['s1', 's2'],
                searchQuery: '',
                showAllRepositoryFiles: false,
            });
            return null;
        }

        let root: renderer.ReactTestRenderer;
        root = (await renderScreen(<Test />)).tree;

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

    it('does not expose session scope for commit selection operations in limited mode', async () => {
        let latest: UseChangedFilesDataResult | null = null;

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
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
        root = (await renderScreen(<Test />)).tree;

        expect(latest).not.toBeNull();
        if (!latest) {
            throw new Error('Expected hook result');
        }
        const result: UseChangedFilesDataResult = latest;
        expect(result.attributionReliability).toBe('limited');
        expect(result.showSessionViewToggle).toBe(false);
        expect(result.sessionAttributedFiles).toHaveLength(0);
        expect(result.repositoryOnlyFiles.map((entry) => entry.fullPath)).toEqual(['src/a.ts']);
        act(() => {
            root!.unmount();
        });
    });

    it('prefers provider-backed session change sets over inferred attribution', async () => {
        let latest: UseChangedFilesDataResult | null = null;

        const sessionChangeSet: SessionChangeSet = {
            sessionId: 's1',
            turns: [],
            files: [{
                filePath: 'src/a.ts',
                changeKind: 'modified',
                oldText: 'a\n',
                newText: 'b\n',
                source: 'provider_native',
                confidence: 'exact',
                provider: 'codex',
                turns: ['turn_1'],
            }],
            rolledBackTurnIds: [],
            confidenceSummary: {
                source: 'provider_native',
                confidence: 'exact',
            },
        };

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
                touchedPaths: [],
                operationLog: [],
                projectSessionIds: ['s1', 's2'],
                searchQuery: '',
                showAllRepositoryFiles: false,
                sessionChangeSet,
            });
            return null;
        }

        let root: renderer.ReactTestRenderer;
        root = (await renderScreen(<Test />)).tree;

        expect(latest).not.toBeNull();
        if (!latest) throw new Error('Expected hook result');
        const result: UseChangedFilesDataResult = latest;
        expect(result.sessionAttributedFiles).toHaveLength(1);
        expect(result.sessionAttributedFiles[0]?.confidence).toBe('high');
        expect(result.repositoryOnlyFiles).toHaveLength(0);
        expect(result.showSessionViewToggle).toBe(true);
        act(() => {
            root!.unmount();
        });
    });

    it('derives a latest-turn scope from provider-backed turn change sets', async () => {
        let latest: UseChangedFilesDataResult | null = null;

        const latestTurnChangeSet: SessionChangeSet = {
            sessionId: 's1',
            turns: [],
            files: [{
                filePath: 'src/a.ts',
                changeKind: 'modified',
                oldText: 'b\n',
                newText: 'c\n',
                source: 'provider_native',
                confidence: 'exact',
                provider: 'codex',
                turns: ['turn_2'],
            }],
            rolledBackTurnIds: [],
            confidenceSummary: {
                source: 'provider_native',
                confidence: 'exact',
            },
        };

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
                touchedPaths: [],
                operationLog: [],
                projectSessionIds: ['s1', 's2'],
                searchQuery: '',
                showAllRepositoryFiles: false,
                latestTurnChangeSet,
            });
            return null;
        }

        let root: renderer.ReactTestRenderer;
        root = (await renderScreen(<Test />)).tree;

        expect(latest).not.toBeNull();
        if (!latest) throw new Error('Expected hook result');
        const result: UseChangedFilesDataResult = latest;
        expect(result.showTurnViewToggle).toBe(true);
        expect(result.turnAttributedFiles).toHaveLength(1);
        expect(result.turnAttributedFiles[0]?.confidence).toBe('high');
        expect(result.turnRepositoryOnlyFiles).toHaveLength(0);
        act(() => {
            root!.unmount();
        });
    });

    it('hides provider-backed scoped views when they cannot be projected onto repository changes', async () => {
        let latest: UseChangedFilesDataResult | null = null;
        const unprojectableChangeSet = makeProviderChangeSet('src/not-currently-changed.ts');

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
                touchedPaths: [],
                operationLog: [],
                projectSessionIds: ['s1', 's2'],
                searchQuery: '',
                showAllRepositoryFiles: false,
                latestTurnChangeSet: unprojectableChangeSet,
                sessionChangeSet: unprojectableChangeSet,
            });
            return null;
        }

        let root: renderer.ReactTestRenderer;
        root = (await renderScreen(<Test />)).tree;

        expect(latest).not.toBeNull();
        if (!latest) throw new Error('Expected hook result');
        const result: UseChangedFilesDataResult = latest;
        expect(result.showTurnViewToggle).toBe(false);
        expect(result.showSessionViewToggle).toBe(false);
        expect(result.turnAttributedFiles).toHaveLength(0);
        expect(result.sessionAttributedFiles).toHaveLength(0);
        expect(result.repositoryOnlyFiles.map((entry) => entry.fullPath)).toEqual(['src/a.ts']);
        act(() => {
            root!.unmount();
        });
    });

    it('projects provider absolute paths under the repository root onto changed files', async () => {
        let latest: UseChangedFilesDataResult | null = null;

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
                touchedPaths: [],
                operationLog: [],
                projectSessionIds: ['s1', 's2'],
                searchQuery: '',
                showAllRepositoryFiles: false,
                latestTurnChangeSet: makeProviderChangeSet('/repo/src/a.ts'),
                sessionChangeSet: makeProviderChangeSet('/repo/src/a.ts'),
            });
            return null;
        }

        let root: renderer.ReactTestRenderer;
        root = (await renderScreen(<Test />)).tree;

        expect(latest).not.toBeNull();
        if (!latest) throw new Error('Expected hook result');
        const result: UseChangedFilesDataResult = latest;
        expect(result.showTurnViewToggle).toBe(true);
        expect(result.showSessionViewToggle).toBe(true);
        expect(result.turnAttributedFiles.map((entry) => entry.file.fullPath)).toEqual(['src/a.ts']);
        expect(result.sessionAttributedFiles.map((entry) => entry.file.fullPath)).toEqual(['src/a.ts']);
        act(() => {
            root!.unmount();
        });
    });
});
