import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionGitPaneCommonModuleMocks } from './sessionGitPaneTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const commitTabRenderSpy = vi.hoisted(() => vi.fn());
const bulkSelectAllSpy = vi.hoisted(() => vi.fn());
const bulkSelectFilesSpy = vi.hoisted(() => vi.fn());
const commitSelectionInputSpy = vi.hoisted(() => vi.fn());

function makeChangedFilesData(overrides: Record<string, unknown> = {}) {
    return {
    attributionReliability: 'high',
    allRepositoryChangedFiles: [],
    turnAttributedFiles: [],
    turnRepositoryOnlyFiles: [],
    sessionAttributedFiles: [],
    repositoryOnlyFiles: [],
    suppressedInferredCount: 0,
    showTurnViewToggle: false,
    showSessionViewToggle: false,
    scmStatusFiles: null,
    ...overrides,
    };
}

const useChangedFilesDataSpy = vi.fn((_: unknown) => makeChangedFilesData());

const useDerivedSessionChangeSetSpy = vi.fn((_: unknown) => ({
    turnChangeSets: [],
    latestTurnChangeSet: null,
    latestTurnScopedChangeSet: null,
    sessionChangeSet: null,
    latestTurnDiffByPath: null,
    providerDiffByPath: null,
}));

installSessionGitPaneCommonModuleMocks();

vi.mock('@/components/sessions/panes/git/SessionRightPanelGitCommitTab', () => ({
    SessionRightPanelGitCommitTab: (props: any) => {
        commitTabRenderSpy(props);
        return React.createElement('SessionRightPanelGitCommitTab', props);
    },
}));

vi.mock('@/components/sessions/sourceControl/commitSelection/ScmCommitSelectionToggleButton', () => ({
    ScmCommitSelectionToggleButton: () => React.createElement('ScmCommitSelectionToggleButton'),
}));

vi.mock('@/components/sessions/sourceControl/changes/ScmChangeDiscardButton', () => ({
    ScmChangeDiscardButton: () => React.createElement('ScmChangeDiscardButton'),
}));

vi.mock('@/components/workspaces/scm/changes/ScmChangeOverflowMenu', () => ({
    ScmChangeOverflowMenu: () => React.createElement('ScmChangeOverflowMenu'),
}));

vi.mock('@/hooks/session/files/useChangedFilesData', () => ({
    useChangedFilesData: (input: any) => useChangedFilesDataSpy(input),
}));

vi.mock('@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet', () => ({
    useDerivedSessionChangeSet: (sessionId: string) => useDerivedSessionChangeSetSpy(sessionId),
}));

vi.mock('./useSessionRightPanelGitCommitSelection', () => ({
    useSessionRightPanelGitCommitSelection: (input: any) => {
        commitSelectionInputSpy(input);
        const selectedVisibleCount = (input.changedFiles ?? []).filter((file: any) => {
            const selectedPaths = new Set<string>(input.commitSelectionPaths ?? []);
            const selectedPatches = new Set<string>((input.commitSelectionPatches ?? []).map((patch: any) => patch.path));
            return selectedPaths.has(file.fullPath) || selectedPatches.has(file.fullPath);
        }).length;
        return {
            repositorySelectedCount: selectedVisibleCount,
            isSelectedForCommit: (file: any) => {
                const selectedPaths = new Set<string>(input.commitSelectionPaths ?? []);
                const selectedPatches = new Set<string>((input.commitSelectionPatches ?? []).map((patch: any) => patch.path));
                return selectedPaths.has(file.fullPath) || selectedPatches.has(file.fullPath);
            },
            toggleCommitSelectionForFile: vi.fn(),
            bulkSelectAll: bulkSelectAllSpy,
            bulkSelectFiles: bulkSelectFilesSpy,
            bulkSelectNone: vi.fn(),
            disableSelectAll: false,
            disableSelectNone: true,
        };
    },
}));

describe('SessionRightPanelGitCommitTabContent', () => {
    beforeEach(() => {
        useChangedFilesDataSpy.mockReset();
        useChangedFilesDataSpy.mockImplementation((_: unknown) => makeChangedFilesData());
        commitTabRenderSpy.mockClear();
        bulkSelectAllSpy.mockClear();
        bulkSelectFilesSpy.mockClear();
        commitSelectionInputSpy.mockClear();
        useDerivedSessionChangeSetSpy.mockReset();
        useDerivedSessionChangeSetSpy.mockImplementation((_: unknown) => ({
            turnChangeSets: [],
            latestTurnChangeSet: null,
            latestTurnScopedChangeSet: null,
            sessionChangeSet: null,
            latestTurnDiffByPath: null,
            providerDiffByPath: null,
        }));
    });

    it('prefers latest-turn view when a canonical latest-turn change set is available', async () => {
        useChangedFilesDataSpy.mockClear();
        useChangedFilesDataSpy.mockReturnValue(makeChangedFilesData({
            showTurnViewToggle: true,
            turnAttributedFiles: [{ file: { fullPath: 'src/a.ts' }, confidence: 'high' }],
        }));
        commitTabRenderSpy.mockClear();
        useDerivedSessionChangeSetSpy.mockReturnValue({
            turnChangeSets: [],
            latestTurnChangeSet: null,
            latestTurnScopedChangeSet: {
                sessionId: 's1',
                turns: ['turn_1'],
                files: [],
                rolledBackTurnIds: [],
                confidenceSummary: { source: 'provider_native', confidence: 'exact' },
            } as any,
            sessionChangeSet: {
                sessionId: 's1',
                turns: [],
                files: [],
                rolledBackTurnIds: [],
                confidenceSummary: { source: 'provider_native', confidence: 'exact' },
            } as any,
            latestTurnDiffByPath: null,
            providerDiffByPath: null,
        });

        const { SessionRightPanelGitCommitTabContent } = await import('./SessionRightPanelGitCommitTabContent');

        await renderScreen(<SessionRightPanelGitCommitTabContent
                    theme={{}}
                    sessionId="s1"
                    sessionPath="/tmp/repo"
                    scmSnapshot={{ capabilities: {} } as any}
                    touchedPaths={[]}
                    operationLog={[]}
                    projectSessionIds={[]}
                    commitSelectionPaths={[]}
                    commitSelectionPatches={[]}
                    scmCommitStrategy="atomic"
                    scmWriteEnabled={true}
                    inFlightScmOperation={null}
                    hasGlobalOperationInFlight={false}
                    scmOperationBusy={false}
                    scmOperationStatus={null}
                    backendLabel="Git"
                    commitActionLabel="Commit"
                    hasConflicts={false}
                    commitAllowedForComposer={true}
                    commitBlockedMessageForComposer={null}
                    commitWriteEnabled={true}
                    commitSelectionUiEnabled={false}
                    commitDraftMessage=""
                    onCommitDraftMessageChange={vi.fn()}
                    onCommitFromMessage={vi.fn()}
                    commitMessageGeneratorEnabled={false}
                    onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
                    onOpenFilesSidebar={vi.fn()}
                    onOpenReviewAllChanges={vi.fn()}
                    onOpenStashDetails={vi.fn()}
                    openFileInDetails={vi.fn()}
                    openFileInDetailsPinned={vi.fn()}
                />);

        expect(useChangedFilesDataSpy).toHaveBeenCalledWith(expect.objectContaining({
            latestTurnChangeSet: expect.objectContaining({ sessionId: 's1' }),
            sessionChangeSet: expect.objectContaining({ sessionId: 's1' }),
        }));

        expect(commitTabRenderSpy).toHaveBeenCalled();
        expect(commitTabRenderSpy.mock.calls.at(-1)?.[0].changedFilesViewMode).toBe('turn');
    });

    it('falls back to repository view when provider changes cannot be displayed in a scoped view', async () => {
        useChangedFilesDataSpy.mockClear();
        useChangedFilesDataSpy.mockReturnValue(makeChangedFilesData({
            showTurnViewToggle: false,
            showSessionViewToggle: false,
        }));
        commitTabRenderSpy.mockClear();
        useDerivedSessionChangeSetSpy.mockReturnValue({
            turnChangeSets: [],
            latestTurnChangeSet: null,
            latestTurnScopedChangeSet: {
                sessionId: 's1',
                turns: ['turn_1'],
                files: [{ filePath: 'src/missing.ts' }],
                rolledBackTurnIds: [],
                confidenceSummary: { source: 'provider_native', confidence: 'exact' },
            } as any,
            sessionChangeSet: {
                sessionId: 's1',
                turns: [],
                files: [{ filePath: 'src/missing.ts' }],
                rolledBackTurnIds: [],
                confidenceSummary: { source: 'provider_native', confidence: 'exact' },
            } as any,
            latestTurnDiffByPath: null,
            providerDiffByPath: null,
        });

        const { SessionRightPanelGitCommitTabContent } = await import('./SessionRightPanelGitCommitTabContent');

        await renderScreen(<SessionRightPanelGitCommitTabContent
                    theme={{}}
                    sessionId="s1"
                    sessionPath="/tmp/repo"
                    scmSnapshot={{ capabilities: {} } as any}
                    touchedPaths={[]}
                    operationLog={[]}
                    projectSessionIds={[]}
                    commitSelectionPaths={[]}
                    commitSelectionPatches={[]}
                    scmCommitStrategy="atomic"
                    scmWriteEnabled={true}
                    inFlightScmOperation={null}
                    hasGlobalOperationInFlight={false}
                    scmOperationBusy={false}
                    scmOperationStatus={null}
                    backendLabel="Git"
                    commitActionLabel="Commit"
                    hasConflicts={false}
                    commitAllowedForComposer={true}
                    commitBlockedMessageForComposer={null}
                    commitWriteEnabled={true}
                    commitSelectionUiEnabled={false}
                    commitDraftMessage=""
                    onCommitDraftMessageChange={vi.fn()}
                    onCommitFromMessage={vi.fn()}
                    commitMessageGeneratorEnabled={false}
                    onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
                    onOpenFilesSidebar={vi.fn()}
                    onOpenReviewAllChanges={vi.fn()}
                    onOpenStashDetails={vi.fn()}
                    openFileInDetails={vi.fn()}
                    openFileInDetailsPinned={vi.fn()}
                />);

        expect(commitTabRenderSpy).toHaveBeenCalled();
        expect(commitTabRenderSpy.mock.calls.at(-1)?.[0].changedFilesViewMode).toBe('repository');
    });

    it('adopts latest-turn view when turn evidence arrives after the first render until the user selects a mode', async () => {
        let turnEvidenceAvailable = false;
        useChangedFilesDataSpy.mockClear();
        useChangedFilesDataSpy.mockImplementation(() => makeChangedFilesData(turnEvidenceAvailable
            ? {
                showTurnViewToggle: true,
                turnAttributedFiles: [{ file: { fullPath: 'src/late.ts' }, confidence: 'high' }],
            }
            : {
                showTurnViewToggle: false,
                showSessionViewToggle: false,
            }));
        useDerivedSessionChangeSetSpy.mockImplementation((): any => ({
            turnChangeSets: [],
            latestTurnChangeSet: turnEvidenceAvailable ? { sessionId: 's1', files: [{ filePath: 'src/late.ts' }] } : null,
            latestTurnScopedChangeSet: turnEvidenceAvailable ? {
                sessionId: 's1',
                turns: ['turn_2'],
                files: [{ filePath: 'src/late.ts' }],
                rolledBackTurnIds: [],
                confidenceSummary: { source: 'provider_native', confidence: 'exact' },
            } as any : null,
            sessionChangeSet: null,
            latestTurnDiffByPath: null,
            providerDiffByPath: null,
        }));

        const { SessionRightPanelGitCommitTabContent } = await import('./SessionRightPanelGitCommitTabContent');

        function View() {
            return <SessionRightPanelGitCommitTabContent
                        theme={{}}
                        sessionId="s1"
                        sessionPath="/tmp/repo"
                        scmSnapshot={{ capabilities: {} } as any}
                        touchedPaths={[]}
                        operationLog={[]}
                        projectSessionIds={[]}
                        commitSelectionPaths={[]}
                        commitSelectionPatches={[]}
                        scmCommitStrategy="atomic"
                        scmWriteEnabled={true}
                        inFlightScmOperation={null}
                        hasGlobalOperationInFlight={false}
                        scmOperationBusy={false}
                        scmOperationStatus={null}
                        backendLabel="Git"
                        commitActionLabel="Commit"
                        hasConflicts={false}
                        commitAllowedForComposer={true}
                        commitBlockedMessageForComposer={null}
                        commitWriteEnabled={true}
                        commitSelectionUiEnabled={false}
                        commitDraftMessage=""
                        onCommitDraftMessageChange={vi.fn()}
                        onCommitFromMessage={vi.fn()}
                        commitMessageGeneratorEnabled={false}
                        onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
                        onOpenFilesSidebar={vi.fn()}
                        onOpenReviewAllChanges={vi.fn()}
                        onOpenStashDetails={vi.fn()}
                        openFileInDetails={vi.fn()}
                        openFileInDetailsPinned={vi.fn()}
                    />;
        }

        const screen = await renderScreen(<View />);
        expect(commitTabRenderSpy.mock.calls.at(-1)?.[0].changedFilesViewMode).toBe('repository');

        turnEvidenceAvailable = true;
        await act(async () => {
            screen.tree.update(<View />);
        });

        expect(commitTabRenderSpy.mock.calls.at(-1)?.[0].changedFilesViewMode).toBe('turn');

        await act(async () => {
            commitTabRenderSpy.mock.calls.at(-1)?.[0].onChangedFilesViewMode('repository');
        });

        expect(commitTabRenderSpy.mock.calls.at(-1)?.[0].changedFilesViewMode).toBe('repository');
    });

    it('keeps repository view selected after the user explicitly switches away from a scoped view', async () => {
        useChangedFilesDataSpy.mockClear();
        useChangedFilesDataSpy.mockReturnValue(makeChangedFilesData({
            showTurnViewToggle: true,
            showSessionViewToggle: true,
            turnAttributedFiles: [{ file: { fullPath: 'src/a.ts' }, confidence: 'high' }],
            sessionAttributedFiles: [{ file: { fullPath: 'src/a.ts' }, confidence: 'high' }],
        }));
        commitTabRenderSpy.mockClear();
        useDerivedSessionChangeSetSpy.mockReturnValue({
            turnChangeSets: [],
            latestTurnChangeSet: null,
            latestTurnScopedChangeSet: {
                sessionId: 's1',
                turns: ['turn_1'],
                files: [{ filePath: 'src/a.ts' }],
                rolledBackTurnIds: [],
                confidenceSummary: { source: 'provider_native', confidence: 'exact' },
            } as any,
            sessionChangeSet: {
                sessionId: 's1',
                turns: [],
                files: [{ filePath: 'src/a.ts' }],
                rolledBackTurnIds: [],
                confidenceSummary: { source: 'provider_native', confidence: 'exact' },
            } as any,
            latestTurnDiffByPath: null,
            providerDiffByPath: null,
        });

        const { SessionRightPanelGitCommitTabContent } = await import('./SessionRightPanelGitCommitTabContent');

        await renderScreen(<SessionRightPanelGitCommitTabContent
                    theme={{}}
                    sessionId="s1"
                    sessionPath="/tmp/repo"
                    scmSnapshot={{ capabilities: {} } as any}
                    touchedPaths={[]}
                    operationLog={[]}
                    projectSessionIds={[]}
                    commitSelectionPaths={[]}
                    commitSelectionPatches={[]}
                    scmCommitStrategy="atomic"
                    scmWriteEnabled={true}
                    inFlightScmOperation={null}
                    hasGlobalOperationInFlight={false}
                    scmOperationBusy={false}
                    scmOperationStatus={null}
                    backendLabel="Git"
                    commitActionLabel="Commit"
                    hasConflicts={false}
                    commitAllowedForComposer={true}
                    commitBlockedMessageForComposer={null}
                    commitWriteEnabled={true}
                    commitSelectionUiEnabled={false}
                    commitDraftMessage=""
                    onCommitDraftMessageChange={vi.fn()}
                    onCommitFromMessage={vi.fn()}
                    commitMessageGeneratorEnabled={false}
                    onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
                    onOpenFilesSidebar={vi.fn()}
                    onOpenReviewAllChanges={vi.fn()}
                    onOpenStashDetails={vi.fn()}
                    openFileInDetails={vi.fn()}
                    openFileInDetailsPinned={vi.fn()}
                />);

        expect(commitTabRenderSpy.mock.calls.at(-1)?.[0].changedFilesViewMode).toBe('turn');

        await act(async () => {
            commitTabRenderSpy.mock.calls.at(-1)?.[0].onChangedFilesViewMode('repository');
        });

        expect(commitTabRenderSpy.mock.calls.at(-1)?.[0].changedFilesViewMode).toBe('repository');
    });

    it('reveals leading changed-file action buttons only after entering selection mode', async () => {
        useChangedFilesDataSpy.mockClear();
        commitTabRenderSpy.mockClear();
        useDerivedSessionChangeSetSpy.mockReturnValue({
            turnChangeSets: [],
            latestTurnChangeSet: null,
            latestTurnScopedChangeSet: null,
            sessionChangeSet: null,
            latestTurnDiffByPath: null,
            providerDiffByPath: null,
        });

        const { SessionRightPanelGitCommitTabContent } = await import('./SessionRightPanelGitCommitTabContent');

        await renderScreen(<SessionRightPanelGitCommitTabContent
                    theme={{}}
                    sessionId="s1"
                    sessionPath="/tmp/repo"
                    scmSnapshot={{ capabilities: {} } as any}
                    touchedPaths={[]}
                    operationLog={[]}
                    projectSessionIds={[]}
                    commitSelectionPaths={[]}
                    commitSelectionPatches={[]}
                    scmCommitStrategy="atomic"
                    scmWriteEnabled={true}
                    inFlightScmOperation={null}
                    hasGlobalOperationInFlight={false}
                    scmOperationBusy={false}
                    scmOperationStatus={null}
                    backendLabel="Git"
                    commitActionLabel="Commit"
                    hasConflicts={false}
                    commitAllowedForComposer={true}
                    commitBlockedMessageForComposer={null}
                    commitWriteEnabled={true}
                    commitSelectionUiEnabled={true}
                    commitDraftMessage=""
                    onCommitDraftMessageChange={vi.fn()}
                    onCommitFromMessage={vi.fn()}
                    commitMessageGeneratorEnabled={false}
                    onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
                    onOpenFilesSidebar={vi.fn()}
                    onOpenReviewAllChanges={vi.fn()}
                    onOpenStashDetails={vi.fn()}
                    openFileInDetails={vi.fn()}
                    openFileInDetailsPinned={vi.fn()}
                />);

        expect(commitTabRenderSpy).toHaveBeenCalled();
        const props = commitTabRenderSpy.mock.calls.at(-1)?.[0];
        expect(props.commitSelectionAvailable).toBe(true);
        // Opt-in: no per-file "+" until the user enters selection mode.
        expect(props.renderFileActions({ fullPath: 'src/a.ts', fileName: 'a.ts' })).toBeNull();

        await act(async () => {
            props.onEnterSelectionMode();
        });

        const nextProps = commitTabRenderSpy.mock.calls.at(-1)?.[0];
        expect(nextProps.selectionModeActive).toBe(true);
        const action = nextProps.renderFileActions({
            fullPath: 'src/a.ts',
            fileName: 'a.ts',
        });
        expect(React.isValidElement(action)).toBe(true);
        expect((action as React.ReactElement).type).toHaveProperty('name', 'ScmCommitSelectionToggleButton');
    });

    it('exposes selected commit files as a selectable changed-files scope', async () => {
        const files = [
            {
                fullPath: 'src/selected.ts',
                fileName: 'selected.ts',
                status: 'modified',
            },
            {
                fullPath: 'src/unselected.ts',
                fileName: 'unselected.ts',
                status: 'modified',
            },
        ] as any[];
        useChangedFilesDataSpy.mockClear();
        useChangedFilesDataSpy.mockReturnValue(makeChangedFilesData({
            allRepositoryChangedFiles: files,
        }));
        commitTabRenderSpy.mockClear();
        useDerivedSessionChangeSetSpy.mockReturnValue({
            turnChangeSets: [],
            latestTurnChangeSet: null,
            latestTurnScopedChangeSet: null,
            sessionChangeSet: null,
            latestTurnDiffByPath: null,
            providerDiffByPath: null,
        });

        const { SessionRightPanelGitCommitTabContent } = await import('./SessionRightPanelGitCommitTabContent');

        await renderScreen(<SessionRightPanelGitCommitTabContent
                    theme={{}}
                    sessionId="s1"
                    sessionPath="/tmp/repo"
                    scmSnapshot={{ capabilities: {} } as any}
                    touchedPaths={[]}
                    operationLog={[]}
                    projectSessionIds={[]}
                    commitSelectionPaths={['src/selected.ts']}
                    commitSelectionPatches={[]}
                    scmCommitStrategy="atomic"
                    scmWriteEnabled={true}
                    inFlightScmOperation={null}
                    hasGlobalOperationInFlight={false}
                    scmOperationBusy={false}
                    scmOperationStatus={null}
                    backendLabel="Git"
                    commitActionLabel="Commit"
                    hasConflicts={false}
                    commitAllowedForComposer={true}
                    commitBlockedMessageForComposer={null}
                    commitWriteEnabled={true}
                    commitSelectionUiEnabled={true}
                    commitDraftMessage=""
                    onCommitDraftMessageChange={vi.fn()}
                    onCommitFromMessage={vi.fn()}
                    commitMessageGeneratorEnabled={false}
                    onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
                    onOpenFilesSidebar={vi.fn()}
                    onOpenReviewAllChanges={vi.fn()}
                    onOpenStashDetails={vi.fn()}
                    openFileInDetails={vi.fn()}
                    openFileInDetailsPinned={vi.fn()}
                />);

        const props = commitTabRenderSpy.mock.calls.at(-1)?.[0];
        expect(props.showSelectedViewToggle).toBe(true);
        expect(props.selectedRepositoryChangedFiles.map((file: any) => file.fullPath)).toEqual(['src/selected.ts']);
        expect(props.changedFilesViewMode).toBe('repository');
    });

    it('passes only visible repository files to commit selection', async () => {
        const visibleFile = {
            fullPath: 'src/visible.ts',
            fileName: 'visible.ts',
            status: 'modified',
        } as any;
        const hiddenDirectory = {
            fullPath: 'src/generated/',
            fileName: 'generated',
            status: 'modified',
        } as any;
        useChangedFilesDataSpy.mockClear();
        useChangedFilesDataSpy.mockReturnValue(makeChangedFilesData({
            allRepositoryChangedFiles: [visibleFile, hiddenDirectory],
        }));
        commitTabRenderSpy.mockClear();

        const { SessionRightPanelGitCommitTabContent } = await import('./SessionRightPanelGitCommitTabContent');

        await renderScreen(<SessionRightPanelGitCommitTabContent
                    theme={{}}
                    sessionId="s1"
                    sessionPath="/tmp/repo"
                    scmSnapshot={{ capabilities: {} } as any}
                    touchedPaths={[]}
                    operationLog={[]}
                    projectSessionIds={[]}
                    commitSelectionPaths={['src/visible.ts', 'src/generated/']}
                    commitSelectionPatches={[]}
                    scmCommitStrategy="atomic"
                    scmWriteEnabled={true}
                    inFlightScmOperation={null}
                    hasGlobalOperationInFlight={false}
                    scmOperationBusy={false}
                    scmOperationStatus={null}
                    backendLabel="Git"
                    commitActionLabel="Commit"
                    hasConflicts={false}
                    commitAllowedForComposer={true}
                    commitBlockedMessageForComposer={null}
                    commitWriteEnabled={true}
                    commitSelectionUiEnabled={true}
                    commitDraftMessage=""
                    onCommitDraftMessageChange={vi.fn()}
                    onCommitFromMessage={vi.fn()}
                    commitMessageGeneratorEnabled={false}
                    onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
                    onOpenFilesSidebar={vi.fn()}
                    onOpenReviewAllChanges={vi.fn()}
                    onOpenStashDetails={vi.fn()}
                    openFileInDetails={vi.fn()}
                    openFileInDetailsPinned={vi.fn()}
                />);

        expect(commitSelectionInputSpy.mock.calls.at(-1)?.[0].changedFiles.map((file: any) => file.fullPath)).toEqual(['src/visible.ts']);
        expect(commitTabRenderSpy.mock.calls.at(-1)?.[0].repositorySelectedCount).toBe(1);
        expect(commitTabRenderSpy.mock.calls.at(-1)?.[0].selectedRepositoryChangedFiles.map((file: any) => file.fullPath)).toEqual(['src/visible.ts']);
    });

    it('selects all files from the current scoped view instead of the full repository', async () => {
        const turnFile = {
            fullPath: 'src/turn.ts',
            fileName: 'turn.ts',
            status: 'modified',
        } as any;
        const repositoryFile = {
            fullPath: 'src/repository.ts',
            fileName: 'repository.ts',
            status: 'modified',
        } as any;
        const hiddenTurnDirectory = {
            fullPath: 'src/generated/',
            fileName: 'generated',
            status: 'modified',
        } as any;
        useChangedFilesDataSpy.mockClear();
        useChangedFilesDataSpy.mockReturnValue(makeChangedFilesData({
            showTurnViewToggle: true,
            allRepositoryChangedFiles: [turnFile, repositoryFile, hiddenTurnDirectory],
            turnAttributedFiles: [
                { file: turnFile, confidence: 'high' },
                { file: hiddenTurnDirectory, confidence: 'high' },
            ],
        }));
        commitTabRenderSpy.mockClear();
        useDerivedSessionChangeSetSpy.mockReturnValue({
            turnChangeSets: [],
            latestTurnChangeSet: null,
            latestTurnScopedChangeSet: {
                sessionId: 's1',
                turns: ['turn_1'],
                files: [{ filePath: 'src/turn.ts' }],
                rolledBackTurnIds: [],
                confidenceSummary: { source: 'provider_native', confidence: 'exact' },
            } as any,
            sessionChangeSet: null,
            latestTurnDiffByPath: null,
            providerDiffByPath: null,
        });

        const { SessionRightPanelGitCommitTabContent } = await import('./SessionRightPanelGitCommitTabContent');

        await renderScreen(<SessionRightPanelGitCommitTabContent
                    theme={{}}
                    sessionId="s1"
                    sessionPath="/tmp/repo"
                    scmSnapshot={{ capabilities: {} } as any}
                    touchedPaths={[]}
                    operationLog={[]}
                    projectSessionIds={[]}
                    commitSelectionPaths={[]}
                    commitSelectionPatches={[]}
                    scmCommitStrategy="atomic"
                    scmWriteEnabled={true}
                    inFlightScmOperation={null}
                    hasGlobalOperationInFlight={false}
                    scmOperationBusy={false}
                    scmOperationStatus={null}
                    backendLabel="Git"
                    commitActionLabel="Commit"
                    hasConflicts={false}
                    commitAllowedForComposer={true}
                    commitBlockedMessageForComposer={null}
                    commitWriteEnabled={true}
                    commitSelectionUiEnabled={true}
                    commitDraftMessage=""
                    onCommitDraftMessageChange={vi.fn()}
                    onCommitFromMessage={vi.fn()}
                    commitMessageGeneratorEnabled={false}
                    onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
                    onOpenFilesSidebar={vi.fn()}
                    onOpenReviewAllChanges={vi.fn()}
                    onOpenStashDetails={vi.fn()}
                    openFileInDetails={vi.fn()}
                    openFileInDetailsPinned={vi.fn()}
                />);

        const props = commitTabRenderSpy.mock.calls.at(-1)?.[0];
        expect(props.changedFilesViewMode).toBe('turn');

        props.onSelectAll();

        expect(bulkSelectAllSpy).not.toHaveBeenCalled();
        expect(bulkSelectFilesSpy).toHaveBeenCalledWith([turnFile]);
    });

    it('hides leading changed-file action buttons when write operations are disabled', async () => {
        useChangedFilesDataSpy.mockClear();
        commitTabRenderSpy.mockClear();
        useDerivedSessionChangeSetSpy.mockReturnValue({
            turnChangeSets: [],
            latestTurnChangeSet: null,
            latestTurnScopedChangeSet: null,
            sessionChangeSet: null,
            latestTurnDiffByPath: null,
            providerDiffByPath: null,
        });

        const { SessionRightPanelGitCommitTabContent } = await import('./SessionRightPanelGitCommitTabContent');

        await renderScreen(<SessionRightPanelGitCommitTabContent
                    theme={{}}
                    sessionId="s1"
                    sessionPath="/tmp/repo"
                    scmSnapshot={{ capabilities: {} } as any}
                    touchedPaths={[]}
                    operationLog={[]}
                    projectSessionIds={[]}
                    commitSelectionPaths={[]}
                    commitSelectionPatches={[]}
                    scmCommitStrategy="atomic"
                    scmWriteEnabled={false}
                    inFlightScmOperation={null}
                    hasGlobalOperationInFlight={false}
                    scmOperationBusy={false}
                    scmOperationStatus={null}
                    backendLabel="Git"
                    commitActionLabel="Commit"
                    hasConflicts={false}
                    commitAllowedForComposer={true}
                    commitBlockedMessageForComposer={null}
                    commitWriteEnabled={true}
                    commitSelectionUiEnabled={true}
                    commitDraftMessage=""
                    onCommitDraftMessageChange={vi.fn()}
                    onCommitFromMessage={vi.fn()}
                    commitMessageGeneratorEnabled={false}
                    onGenerateCommitMessageSuggestion={async () => ({ ok: true, message: '' })}
                    onOpenFilesSidebar={vi.fn()}
                    onOpenReviewAllChanges={vi.fn()}
                    onOpenStashDetails={vi.fn()}
                    openFileInDetails={vi.fn()}
                    openFileInDetailsPinned={vi.fn()}
                />);

        expect(commitTabRenderSpy).toHaveBeenCalled();
        const props = commitTabRenderSpy.mock.calls.at(-1)?.[0];
        expect(props.renderFileActions({ fullPath: 'src/a.ts' })).toBeNull();
    });

    it('keeps file-open callbacks stable when the mounted commit tab becomes inactive', async () => {
        useChangedFilesDataSpy.mockClear();
        useChangedFilesDataSpy.mockReturnValue(makeChangedFilesData());
        commitTabRenderSpy.mockClear();
        useDerivedSessionChangeSetSpy.mockReturnValue({
            turnChangeSets: [],
            latestTurnChangeSet: null,
            latestTurnScopedChangeSet: null,
            sessionChangeSet: null,
            latestTurnDiffByPath: null,
            providerDiffByPath: null,
        });

        const openFileInDetails = vi.fn();
        const openFileInDetailsPinned = vi.fn();
        const { SessionRightPanelGitCommitTabContent } = await import('./SessionRightPanelGitCommitTabContent');

        const baseProps = {
            theme: {},
            sessionId: 's1',
            sessionPath: '/tmp/repo',
            scmSnapshot: { capabilities: {} } as any,
            touchedPaths: [],
            operationLog: [],
            projectSessionIds: [],
            commitSelectionPaths: [],
            commitSelectionPatches: [],
            scmCommitStrategy: 'atomic' as const,
            scmWriteEnabled: true,
            inFlightScmOperation: null,
            hasGlobalOperationInFlight: false,
            scmOperationBusy: false,
            scmOperationStatus: null,
            backendLabel: 'Git',
            commitActionLabel: 'Commit',
            hasConflicts: false,
            commitAllowedForComposer: true,
            commitBlockedMessageForComposer: null,
            commitWriteEnabled: true,
            commitSelectionUiEnabled: false,
            commitDraftMessage: '',
            onCommitDraftMessageChange: vi.fn(),
            onCommitFromMessage: vi.fn(),
            commitMessageGeneratorEnabled: false,
            onGenerateCommitMessageSuggestion: async () => ({ ok: true, message: '' } as const),
            onOpenFilesSidebar: vi.fn(),
            onOpenReviewAllChanges: vi.fn(),
            onOpenStashDetails: vi.fn(),
            openFileInDetails,
            openFileInDetailsPinned,
        };

        const { tree } = await renderScreen(
            <SessionRightPanelGitCommitTabContent {...baseProps} showBranchSummary={true} />,
        );
        const firstProps = commitTabRenderSpy.mock.calls.at(-1)?.[0];
        const firstCallCount = commitTabRenderSpy.mock.calls.length;

        await act(async () => {
            tree.update(<SessionRightPanelGitCommitTabContent {...baseProps} showBranchSummary={false} />);
        });

        const nextProps = commitTabRenderSpy.mock.calls.at(-1)?.[0];
        expect(commitTabRenderSpy.mock.calls.length).toBeGreaterThan(firstCallCount);
        expect(nextProps.onFilePress).toBe(firstProps.onFilePress);
        expect(nextProps.onFilePressPinned).toBe(firstProps.onFilePressPinned);
    });
});
