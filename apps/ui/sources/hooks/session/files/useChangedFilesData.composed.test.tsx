import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { mergeTurnChangeSets} from '@happier-dev/protocol/sessions/changes/mergeTurnChangeSets';
import { type SessionChangeSet, type TurnChangeSet } from '@happier-dev/protocol/sessions/changes/types';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { Message } from "@happier-dev/session-core/messages";
import { filterPresentableSessionAttributedFiles } from '@/scm/scmAttribution';
import { deriveTurnChangeSetsFromMessages } from '@/sync/domains/session/changes/derivation/deriveTurnChangeSetsFromMessages';
import { buildTurnChangeSetDiffInput } from '../../../../../cli/src/agent/tools/diff/buildTurnChangeSetDiffInput';
import { projectRepositoryCheckpointTurnChangeSet } from '../../../../../cli/src/scm/checkpoints/projection';

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
            attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
            checkpointOverlap: 'unknown',
        }],
        rolledBackTurnIds: [],
        confidenceSummary: {
            source: 'provider_native',
            confidence: 'exact',
            attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
            checkpointOverlap: 'unknown',
        },
    };
}

function makeMixedTurnChangeSet(): TurnChangeSet {
    return {
        sessionId: 's1',
        turnId: 'turn_2',
        seqRange: {
            startSeqInclusive: 1,
            endSeqInclusive: 3,
        },
        status: 'completed',
        provider: 'codex',
        derivedAt: 2,
        repositoryCheckpoint: {
            version: 1,
            scopeId: 's1:/repo',
            startRef: 'refs/happier/checkpoints/scope/turn-start/turn_2',
            finalRef: 'refs/happier/checkpoints/scope/turn-final/turn_2',
            baseRefSource: 'turn_start',
            contentConfidence: 'exact',
            attributionScope: 'shared_worktree',
            receipts: [{ id: 'checkpoint.diff_computed' }],
        },
        files: [
            {
                filePath: 'src/a.ts',
                changeKind: 'modified',
                oldText: 'a\n',
                newText: 'b\n',
                unifiedDiff: 'provider diff',
                source: 'provider_native',
                confidence: 'strong',
                provider: 'codex',
            },
            {
                filePath: 'src/a.ts',
                changeKind: 'modified',
                oldText: 'a\n',
                newText: 'b\n',
                unifiedDiff: 'checkpoint diff',
                source: 'scm_checkpoint',
                confidence: 'exact',
                provider: 'scm:git',
            },
        ],
    };
}

describe('useChangedFilesData', () => {
    it.each([true, false])('keeps recorded Session span counts honest after files leave the working tree (continuous: %s)', async (continuous) => {
        const base = makeMixedTurnChangeSet();
        const turns: TurnChangeSet[] = [
            { ...base, files: [{ ...base.files[0]!, oldText: 'one\ntwo\n', newText: 'ONE\ntwo\n',
                unifiedDiff: '@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n' }] },
            { ...base, turnId: 'turn-3', seqRange: { startSeqInclusive: 4, endSeqInclusive: 6 },
                files: [{ ...base.files[0]!, oldText: continuous ? 'ONE\ntwo\n' : 'unrelated fragment\n', newText: 'ONE\nTWO\n',
                    unifiedDiff: '@@ -1,2 +1,2 @@\n ONE\n-two\n+TWO\n' }] },
        ];
        const changeSet = mergeTurnChangeSets({ sessionId: 's1', turns });
        let latest: UseChangedFilesDataResult | null = null;
        function Test() {
            latest = useChangedFilesData({ sessionId: 's1', scmSnapshot: null, searchQuery: '', showAllRepositoryFiles: false, sessionChangeSet: changeSet });
            return null;
        }
        const screen = await renderScreen(<Test />);
        if (!latest) throw new Error('Expected hook result');
        const result: UseChangedFilesDataResult = latest;
        expect(result.sessionAttributedFiles[0]?.file).toMatchObject(continuous
            ? { linesAdded: 2, linesRemoved: 2 }
            : { isComplete: false });
        act(() => screen.tree.unmount());
    });

    it('keeps every rename contributor after a later edit while copies remain independent', async () => {
        const base = makeMixedTurnChangeSet();
        const paths = ['src/old.ts', 'src/middle.ts', 'src/a.ts', 'src/a.ts'];
        const turns: TurnChangeSet[] = paths.map((filePath, index) => ({
            ...base, turnId: `turn-${index}`, seqRange: { startSeqInclusive: index + 1, endSeqInclusive: index + 1 },
            files: [{ ...base.files[0]!, filePath, providerMessageId: `edit-${index}`,
                ...(index === 1 || index === 2 ? { changeKind: 'renamed', previousFilePath: paths[index - 1] } : {}) }],
        }));
        turns.push({ ...base, turnId: 'copy', seqRange: { startSeqInclusive: 5, endSeqInclusive: 5 },
            files: [{ ...base.files[0]!, filePath: 'src/copy.ts', previousFilePath: 'src/a.ts',
                changeKind: 'copied', providerMessageId: 'copy' }] });
        const changeSet = mergeTurnChangeSets({ sessionId: 's1', turns });
        let latest: UseChangedFilesDataResult | null = null;
        function Test() {
            latest = useChangedFilesData({ sessionId: 's1', scmSnapshot: makeSnapshot(), searchQuery: '', showAllRepositoryFiles: false, sessionChangeSet: changeSet });
            return null;
        }
        const screen = await renderScreen(<Test />);
        if (!latest) throw new Error('Expected hook result');
        const result: UseChangedFilesDataResult = latest;
        expect(result.sessionAttributedFiles.find((entry) => entry.file.fullPath === 'src/a.ts')?.evidence
            .map((file) => file.providerMessageId)).toEqual(['edit-0', 'edit-1', 'edit-2', 'edit-3']);
        expect(result.sessionAttributedFiles.find((entry) => entry.file.fullPath === 'src/copy.ts')?.evidence
            .map((file) => file.providerMessageId)).toEqual(['copy']);
        act(() => screen.tree.unmount());
    });

    it('shows one file with both absolute tool and relative checkpoint evidence', async () => {
        const turn = makeMixedTurnChangeSet();
        const files = turn.files.map((file) => file.source === 'provider_native' ? { ...file, filePath: '/repo/src/a.ts' } : file);
        let latest: UseChangedFilesDataResult | null = null;
        function Test() {
            latest = useChangedFilesData({ sessionId: 's1', scmSnapshot: makeSnapshot(), searchQuery: '', showAllRepositoryFiles: false, latestTurnEvidence: { ...turn, files } });
            return null;
        }
        const screen = await renderScreen(<Test />);
        if (!latest) throw new Error('Expected hook result');
        const result: UseChangedFilesDataResult = latest;
        expect(result.turnAttributedFiles).toHaveLength(1);
        expect(result.turnAttributedFiles[0]).toMatchObject({
            file: { fullPath: 'src/a.ts' }, content: { source: 'scm_checkpoint', confidence: 'exact' },
            attribution: { confidence: 'session_exact', reason: 'provider_correlated' }, checkpointOverlap: 'observed',
        });
        expect(result.turnAttributedFiles[0]?.evidence.map((file) => file.filePath)).toEqual(['/repo/src/a.ts', 'src/a.ts']);
        act(() => screen.tree.unmount());
    });

    it('projects one real provider/checkpoint turn identically through mounted list, review, and right-panel adapters', async () => {
        const projected = projectRepositoryCheckpointTurnChangeSet({
            providerTurnChangeSet: {
                sessionId: 's1', turnId: 'turn-composed', seqRange: { startSeqInclusive: 1, endSeqInclusive: 3 },
                status: 'completed', provider: 'codex', derivedAt: 2,
                files: [{
                    filePath: 'src/a.ts', changeKind: 'modified', unifiedDiff: 'provider diff',
                    source: 'provider_tool', confidence: 'strong', provider: 'codex',
                    agentTurnId: 'provider-turn-composed', providerMessageId: 'provider-message-composed',
                }],
            },
            checkpointDiff: {
                success: true,
                baseRef: {
                    scopeId: 's1:/repo', encodedScope: 's1-repo', phase: 'turn-start',
                    checkpointId: 'turn-composed', ref: 'refs/happier/start',
                },
                finalRef: {
                    scopeId: 's1:/repo', encodedScope: 's1-repo', phase: 'turn-final',
                    checkpointId: 'turn-composed', ref: 'refs/happier/final',
                },
                baseRefSource: 'turn_start', contentConfidence: 'exact',
                attributionScope: 'shared_worktree', receipts: [{ id: 'checkpoint.diff_computed' }],
                files: [{
                    filePath: 'src/a.ts', changeKind: 'modified', unifiedDiff: 'checkpoint diff', binary: false,
                    source: 'scm_checkpoint', confidence: 'exact', provider: 'scm:git',
                }],
            },
            repoRootPath: '/repo', scopeId: 's1:/repo', startRef: 'refs/happier/start', finalRef: 'refs/happier/final',
        });
        const message: Message = {
            kind: 'tool-call', id: 'canonical-diff', localId: null, createdAt: 2, children: [],
            tool: {
                name: 'Diff', state: 'completed',
                input: buildTurnChangeSetDiffInput({ turnChangeSet: projected, protocol: 'codex', rawToolName: 'RepositoryCheckpointDiff' }),
                createdAt: 2, startedAt: 2, completedAt: 3, description: null, result: { status: 'completed' },
            },
        };
        const turns = deriveTurnChangeSetsFromMessages([message]);
        const sessionChangeSet = mergeTurnChangeSets({ sessionId: 's1', turns });
        const result: { latest?: UseChangedFilesDataResult } = {};
        function Test() {
            result.latest = useChangedFilesData({
                sessionId: 's1', scmSnapshot: makeSnapshot(), searchQuery: '',
                showAllRepositoryFiles: false, latestTurnEvidence: turns[0], sessionChangeSet,
            });
            return null;
        }
        const screen = await renderScreen(<Test />);
        const latest = result.latest;
        if (!latest) throw new Error('Expected hook result');

        // These are the actual non-directory adapters used by the mounted list, review, and right panel.
        const listModel = filterPresentableSessionAttributedFiles(latest.turnAttributedFiles);
        const reviewModel = filterPresentableSessionAttributedFiles(latest.turnAttributedFiles);
        const rightPanelModel = filterPresentableSessionAttributedFiles(latest.turnAttributedFiles);
        expect(listModel).toEqual(reviewModel);
        expect(reviewModel).toEqual(rightPanelModel);
        expect(listModel[0]).toMatchObject({
            content: { source: 'scm_checkpoint', confidence: 'exact' },
            attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
            checkpointOverlap: 'observed',
            evidence: expect.arrayContaining([
                expect.objectContaining({ source: 'provider_tool', agentTurnId: 'provider-turn-composed' }),
                expect.objectContaining({ source: 'scm_checkpoint' }),
            ]),
        });
        expect(listModel[0]?.evidence).toBe(reviewModel[0]?.evidence);
        expect(reviewModel[0]?.evidence).toBe(rightPanelModel[0]?.evidence);
        act(() => screen.tree.unmount());
    });

    it('can skip attribution computation for repository-only surfaces', async () => {
        let latest: UseChangedFilesDataResult | null = null;

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
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
        act(() => {
            root!.unmount();
        });
    });

    it('attributes no repository change to the Session without daemon turn evidence', async () => {
        let latest: UseChangedFilesDataResult | null = null;

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
                searchQuery: '',
                showAllRepositoryFiles: false,
            });
            return null;
        }

        const screen = await renderScreen(<Test />);
        if (!latest) throw new Error('Expected hook result');
        const result: UseChangedFilesDataResult = latest;
        // Option B: a running turn shows only agent-reported edits; others arrive with turn-end checkpoints.
        expect(result.sessionAttributedFiles).toHaveLength(0);
        expect(result.repositoryOnlyFiles).toHaveLength(1);
        expect(result.showSessionViewToggle).toBe(false);
        act(() => screen.tree.unmount());
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
            attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
            checkpointOverlap: 'unknown',
            }],
            rolledBackTurnIds: [],
            confidenceSummary: {
                source: 'provider_native',
                confidence: 'exact',
            attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
            checkpointOverlap: 'unknown',
            },
        };

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
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
        expect(result.sessionAttributedFiles[0]?.attribution.confidence).toBe('session_exact');
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
                attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
                checkpointOverlap: 'unknown',
            }],
            rolledBackTurnIds: [],
            confidenceSummary: {
                source: 'provider_native',
                confidence: 'exact',
            attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
            checkpointOverlap: 'unknown',
            },
        };

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
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
        expect(result.turnAttributedFiles[0]?.attribution.confidence).toBe('session_exact');
        expect(result.turnRepositoryOnlyFiles).toHaveLength(0);
        act(() => {
            root!.unmount();
        });
    });

    it('keeps the latest-turn view available when the latest turn has no file changes', async () => {
        const latest: { current: UseChangedFilesDataResult | null } = { current: null };
        const latestTurnEvidence: TurnChangeSet = {
            ...makeMixedTurnChangeSet(),
            turnId: 'turn-without-files',
            files: [],
        };

        function Test() {
            latest.current = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
                searchQuery: '',
                showAllRepositoryFiles: false,
                latestTurnEvidence,
            });
            return null;
        }

        const screen = await renderScreen(<Test />);
        if (!latest.current) throw new Error('Expected hook result');
        expect(latest.current.showTurnViewToggle).toBe(true);
        expect(latest.current.turnAttributedFiles).toHaveLength(0);
        act(() => screen.tree.unmount());
    });

    it('keeps canonical Session evidence reachable when it cannot be projected onto repository changes', async () => {
        let latest: UseChangedFilesDataResult | null = null;
        const unprojectableChangeSet = makeProviderChangeSet('src/not-currently-changed.ts');

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
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
        expect(result.showSessionViewToggle).toBe(true);
        expect(result.turnAttributedFiles).toHaveLength(0);
        expect(result.sessionAttributedFiles).toEqual([
            expect.objectContaining({
                file: expect.objectContaining({ fullPath: 'src/not-currently-changed.ts' }),
                content: { source: 'provider_native', confidence: 'exact' },
                attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
            }),
        ]);
        expect(result.repositoryOnlyFiles.map((entry) => entry.fullPath)).toEqual(['src/a.ts']);
        act(() => {
            root!.unmount();
        });
    });

    it('retains original change statistics for bounded unmatched evidence', async () => {
        let latest: UseChangedFilesDataResult | null = null;
        const bounded = makeProviderChangeSet('src/bounded.ts');
        const sessionChangeSet: SessionChangeSet = {
            ...bounded,
            files: bounded.files.map((file) => ({
                ...file,
                confidence: 'best_effort',
                truncated: true,
                stats: { unifiedDiffBytes: 900_000, addedLines: 4000, removedLines: 3000 },
            })),
            confidenceSummary: { ...bounded.confidenceSummary, confidence: 'best_effort' },
        };

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
                searchQuery: '',
                showAllRepositoryFiles: false,
                sessionChangeSet,
            });
            return null;
        }

        const root = (await renderScreen(<Test />)).tree;
        if (!latest) throw new Error('Expected hook result');
        expect((latest as UseChangedFilesDataResult).sessionAttributedFiles[0]).toMatchObject({
            file: { fullPath: 'src/bounded.ts', linesAdded: 4000, linesRemoved: 3000 },
            content: { confidence: 'best_effort' },
            evidence: [expect.objectContaining({
                truncated: true,
                stats: { unifiedDiffBytes: 900_000, addedLines: 4000, removedLines: 3000 },
            })],
        });
        act(() => root.unmount());
    });

    it('projects provider absolute paths under the repository root onto changed files', async () => {
        let latest: UseChangedFilesDataResult | null = null;

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
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

    it('derives agent-reported and checkpoint turn scopes from raw turn evidence', async () => {
        let latest: UseChangedFilesDataResult | null = null;

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
                searchQuery: '',
                showAllRepositoryFiles: false,
                latestTurnEvidence: makeMixedTurnChangeSet(),
            });
            return null;
        }

        const root = (await renderScreen(<Test />)).tree;

        expect(latest).not.toBeNull();
        if (!latest) throw new Error('Expected hook result');
        const result: UseChangedFilesDataResult = latest;
        expect(result.showTurnViewToggle).toBe(true);
        expect(result.showTurnAgentReportedViewToggle).toBe(true);
        expect(result.showTurnCheckpointViewToggle).toBe(true);
        expect(result.turnAgentReportedFiles.map((entry) => entry.file.fullPath)).toEqual(['src/a.ts']);
        expect(result.turnCheckpointFiles.map((entry) => entry.file.fullPath)).toEqual(['src/a.ts']);
        expect(result.turnCheckpointMetadata?.attributionScope).toBe('shared_worktree');
        expect(result.turnAttributedFiles[0]).toMatchObject({
            content: { source: 'scm_checkpoint', confidence: 'exact' },
            attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
            checkpointOverlap: 'observed',
        });
        expect(result.turnAttributedFiles[0]?.evidence.map((entry) => entry.source)).toEqual(['provider_native', 'scm_checkpoint']);
        expect(result.turnCheckpointFiles[0]).toMatchObject({
            content: { source: 'scm_checkpoint', confidence: 'exact' },
            attribution: { confidence: 'session_possible', reason: 'checkpoint_overlap_observed' },
            checkpointOverlap: 'observed',
        });
        expect(result.turnAgentReportedFiles[0]?.attribution.confidence).toBe('session_exact');
        expect(result.turnCheckpointFiles[0]?.evidence.map((entry) => entry.source)).toEqual(['scm_checkpoint']);

        act(() => {
            root.unmount();
        });
    });

    it('keeps exact checkpoint content visible when Session attribution is unknown', async () => {
        let latest: UseChangedFilesDataResult | null = null;
        const mixed = makeMixedTurnChangeSet();
        const turn: TurnChangeSet = {
            ...mixed,
            files: mixed.files.filter((file) => file.source === 'scm_checkpoint'),
            repositoryCheckpoint: { ...mixed.repositoryCheckpoint!, attributionScope: 'unknown' },
        };
        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1', scmSnapshot: makeSnapshot(), searchQuery: '', showAllRepositoryFiles: false, latestTurnEvidence: turn,
            });
            return null;
        }
        const screen = await renderScreen(<Test />);
        if (!latest) throw new Error('Expected hook result');
        const result: UseChangedFilesDataResult = latest;
        expect(result.showTurnViewToggle).toBe(true);
        expect(result.turnAttributedFiles[0]).toMatchObject({
            content: { source: 'scm_checkpoint', confidence: 'exact' },
            attribution: { confidence: 'unknown', reason: 'unavailable' },
            checkpointOverlap: 'unknown',
        });
        act(() => screen.tree.unmount());
    });

    it('uses raw checkpoint evidence instead of a plausible UI-local attribution override', async () => {
        let latest: UseChangedFilesDataResult | null = null;
        const mixed = makeMixedTurnChangeSet();
        const rawCheckpointTurn: TurnChangeSet = {
            ...mixed,
            files: mixed.files.filter((file) => file.source === 'scm_checkpoint'),
            repositoryCheckpoint: { ...mixed.repositoryCheckpoint!, attributionScope: 'unknown' },
        };
        const overriddenProjection = makeProviderChangeSet('src/a.ts');

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
                searchQuery: '',
                showAllRepositoryFiles: false,
                latestTurnChangeSet: overriddenProjection,
                latestTurnEvidence: rawCheckpointTurn,
            });
            return null;
        }

        const screen = await renderScreen(<Test />);
        if (!latest) throw new Error('Expected hook result');
        const result: UseChangedFilesDataResult = latest;
        expect(result.turnAttributedFiles[0]).toMatchObject({
            content: { source: 'scm_checkpoint', confidence: 'exact' },
            attribution: { confidence: 'unknown', reason: 'unavailable' },
            checkpointOverlap: 'unknown',
        });
        act(() => screen.tree.unmount());
    });

    it('keeps source-specific turn evidence visible when it is not present in the current snapshot', async () => {
        let latest: UseChangedFilesDataResult | null = null;
        const turnEvidence: TurnChangeSet = {
            ...makeMixedTurnChangeSet(),
            files: [
                {
                    filePath: 'src/agent-only.ts',
                    changeKind: 'modified',
                    source: 'provider_tool',
                    confidence: 'strong',
                    provider: 'codex',
                    unifiedDiff: 'agent-only diff',
                },
                {
                    filePath: 'src/checkpoint-only.ts',
                    changeKind: 'added',
                    source: 'scm_checkpoint',
                    confidence: 'exact',
                    provider: 'scm:git',
                    unifiedDiff: 'checkpoint-only diff',
                },
            ],
        };

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
                searchQuery: '',
                showAllRepositoryFiles: false,
                latestTurnChangeSet: null,
                latestTurnEvidence: turnEvidence,
            });
            return null;
        }

        const root = (await renderScreen(<Test />)).tree;

        expect(latest).not.toBeNull();
        if (!latest) throw new Error('Expected hook result');
        const result: UseChangedFilesDataResult = latest;
        expect(result.showTurnViewToggle).toBe(true);
        expect(result.showTurnAgentReportedViewToggle).toBe(true);
        expect(result.showTurnCheckpointViewToggle).toBe(true);
        expect(result.turnAgentReportedFiles.map((entry) => entry.file.fullPath)).toEqual(['src/agent-only.ts']);
        expect(result.turnCheckpointFiles.map((entry) => entry.file.fullPath)).toEqual(['src/checkpoint-only.ts']);
        expect(result.turnCheckpointFiles[0]?.file.status).toBe('added');

        act(() => {
            root.unmount();
        });
    });

    it('keeps unmatched raw turn evidence visible in the reconciled latest-turn scope', async () => {
        let latest: UseChangedFilesDataResult | null = null;
        const latestTurnChangeSet: SessionChangeSet = {
            ...makeProviderChangeSet('src/agent-only.ts'),
            files: [{
                filePath: 'src/agent-only.ts',
                changeKind: 'modified',
                oldText: null,
                newText: null,
                source: 'provider_tool',
                confidence: 'strong',
                provider: 'codex',
                turns: ['turn_2'],
                attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
                checkpointOverlap: 'unknown',
                unifiedDiff: 'agent-only diff',
            }],
        };

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
                searchQuery: '',
                showAllRepositoryFiles: false,
                latestTurnChangeSet,
                latestTurnEvidence: {
                    ...makeMixedTurnChangeSet(),
                    files: latestTurnChangeSet.files,
                },
            });
            return null;
        }

        const root = (await renderScreen(<Test />)).tree;

        expect(latest).not.toBeNull();
        if (!latest) throw new Error('Expected hook result');
        const result: UseChangedFilesDataResult = latest;
        expect(result.showTurnViewToggle).toBe(true);
        expect(result.turnAttributedFiles.map((entry) => entry.file.fullPath)).toEqual(['src/agent-only.ts']);

        act(() => {
            root.unmount();
        });
    });

    it('keeps the evidence recorded at a renamed file\'s previous path in its disclosure', async () => {
        let latest: UseChangedFilesDataResult | null = null;
        const renameTurn: TurnChangeSet = {
            ...makeMixedTurnChangeSet(),
            files: [
                {
                    filePath: 'src/old.ts',
                    changeKind: 'modified',
                    source: 'provider_native',
                    confidence: 'best_effort',
                    provider: 'codex',
                    unifiedDiff: 'edit before the rename',
                },
                {
                    filePath: 'src/a.ts',
                    previousFilePath: 'src/old.ts',
                    changeKind: 'renamed',
                    source: 'provider_tool',
                    confidence: 'strong',
                    provider: 'codex',
                    unifiedDiff: 'rename evidence',
                },
                {
                    filePath: 'src/copy.ts',
                    previousFilePath: 'src/a.ts',
                    changeKind: 'copied',
                    source: 'provider_tool',
                    confidence: 'strong',
                    provider: 'codex',
                    unifiedDiff: 'copy evidence',
                },
            ],
        };

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
                searchQuery: '',
                showAllRepositoryFiles: false,
                latestTurnEvidence: renameTurn,
            });
            return null;
        }

        const root = (await renderScreen(<Test />)).tree;

        expect(latest).not.toBeNull();
        if (!latest) throw new Error('Expected hook result');
        const result: UseChangedFilesDataResult = latest;
        const renamed = result.turnAttributedFiles.find((entry) => entry.file.fullPath === 'src/a.ts');
        expect(renamed?.evidence.map((entry) => entry.unifiedDiff)).toEqual([
            'edit before the rename',
            'rename evidence',
        ]);
        const copied = result.turnAttributedFiles.find((entry) => entry.file.fullPath === 'src/copy.ts');
        expect(copied?.evidence.map((entry) => entry.unifiedDiff)).toEqual(['copy evidence']);

        act(() => {
            root.unmount();
        });
    });

    it('can expose checkpoint mode as unavailable metadata without checkpoint files', async () => {
        let latest: UseChangedFilesDataResult | null = null;
        const unavailableTurn: TurnChangeSet = {
            ...makeMixedTurnChangeSet(),
            repositoryCheckpoint: {
                version: 1,
                scopeId: 's1:/repo',
                baseRefSource: 'unavailable',
                contentConfidence: 'unavailable',
                attributionScope: 'unknown',
                receipts: [],
                unavailableReason: 'refs missing',
            },
            files: [
                {
                    filePath: 'src/a.ts',
                    changeKind: 'modified',
                    source: 'provider_native',
                    confidence: 'strong',
                    provider: 'codex',
                    unifiedDiff: 'provider diff',
                },
            ],
        };

        function Test() {
            latest = useChangedFilesData({
                sessionId: 's1',
                scmSnapshot: makeSnapshot(),
                searchQuery: '',
                showAllRepositoryFiles: false,
                latestTurnChangeSet: makeProviderChangeSet('src/a.ts'),
                latestTurnEvidence: unavailableTurn,
            });
            return null;
        }

        const root = (await renderScreen(<Test />)).tree;

        expect(latest).not.toBeNull();
        if (!latest) throw new Error('Expected hook result');
        const result: UseChangedFilesDataResult = latest;
        expect(result.showTurnAgentReportedViewToggle).toBe(true);
        expect(result.showTurnCheckpointViewToggle).toBe(true);
        expect(result.turnCheckpointFiles).toHaveLength(0);
        expect(result.turnCheckpointMetadata?.contentConfidence).toBe('unavailable');
        expect(result.turnCheckpointMetadata?.unavailableReason).toBe('refs missing');

        act(() => {
            root.unmount();
        });
    });
});
