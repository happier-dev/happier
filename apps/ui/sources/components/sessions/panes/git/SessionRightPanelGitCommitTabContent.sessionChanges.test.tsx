import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionGitPaneCommonModuleMocks } from './sessionGitPaneTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const commitTabRenderSpy = vi.hoisted(() => vi.fn());

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

function makeCommitSelectionResult(overrides: Record<string, unknown> = {}) {
    return {
        repositorySelectedCount: 0,
        isSelectedForCommit: () => false,
        toggleCommitSelectionForFile: vi.fn(),
        bulkSelectAll: vi.fn(),
        bulkSelectFiles: vi.fn(),
        bulkSelectNone: vi.fn(),
        disableSelectAll: true,
        disableSelectNone: true,
        ...overrides,
    };
}

const useCommitSelectionSpy = vi.fn(() => makeCommitSelectionResult());

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

vi.mock('@/components/sessions/sourceControl/changes/ScmChangeOverflowMenu', () => ({
    ScmChangeOverflowMenu: () => React.createElement('ScmChangeOverflowMenu'),
}));

vi.mock('@/hooks/session/files/useChangedFilesData', () => ({
    useChangedFilesData: (input: any) => useChangedFilesDataSpy(input),
}));

vi.mock('@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet', () => ({
    useDerivedSessionChangeSet: (sessionId: string) => useDerivedSessionChangeSetSpy(sessionId),
}));

vi.mock('./useSessionRightPanelGitCommitSelection', () => ({
    useSessionRightPanelGitCommitSelection: () => useCommitSelectionSpy(),
}));

describe('SessionRightPanelGitCommitTabContent', () => {
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

    it('makes selected-for-commit a real scope without treating selection as session attribution', async () => {
        const selectedFile = {
            fileName: 'selected.ts',
            filePath: 'src',
            fullPath: 'src/selected.ts',
            status: 'modified',
            isIncluded: false,
            linesAdded: 1,
            linesRemoved: 0,
        };
        const unselectedFile = {
            fileName: 'unselected.ts',
            filePath: 'src',
            fullPath: 'src/unselected.ts',
            status: 'modified',
            isIncluded: false,
            linesAdded: 1,
            linesRemoved: 0,
        };
        useChangedFilesDataSpy.mockClear();
        useChangedFilesDataSpy.mockReturnValue(makeChangedFilesData({
            allRepositoryChangedFiles: [selectedFile, unselectedFile],
            showTurnViewToggle: false,
            showSessionViewToggle: false,
            sessionAttributedFiles: [],
        }));
        useCommitSelectionSpy.mockReturnValue(makeCommitSelectionResult({
            repositorySelectedCount: 1,
            isSelectedForCommit: (file: { fullPath: string }) => file.fullPath === 'src/selected.ts',
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

        expect(commitTabRenderSpy.mock.calls.at(-1)?.[0].showSessionViewToggle).toBe(false);
        expect(commitTabRenderSpy.mock.calls.at(-1)?.[0].showSelectedViewToggle).toBe(true);
        expect(commitTabRenderSpy.mock.calls.at(-1)?.[0].selectedRepositoryChangedFiles.map((file: { fullPath: string }) => file.fullPath)).toEqual([
            'src/selected.ts',
        ]);

        await act(async () => {
            commitTabRenderSpy.mock.calls.at(-1)?.[0].onChangedFilesViewMode('selected');
        });

        expect(commitTabRenderSpy.mock.calls.at(-1)?.[0].changedFilesViewMode).toBe('selected');
    });

    it('selects all files only from the active scoped view', async () => {
        const turnFile = {
            fileName: 'turn.ts',
            filePath: 'src',
            fullPath: 'src/turn.ts',
            status: 'modified',
            isIncluded: false,
            linesAdded: 1,
            linesRemoved: 0,
        };
        const repositoryOnlyFile = {
            fileName: 'repo.ts',
            filePath: 'src',
            fullPath: 'src/repo.ts',
            status: 'modified',
            isIncluded: false,
            linesAdded: 1,
            linesRemoved: 0,
        };
        const bulkSelectAll = vi.fn();
        const bulkSelectFiles = vi.fn();
        useChangedFilesDataSpy.mockClear();
        useChangedFilesDataSpy.mockReturnValue(makeChangedFilesData({
            allRepositoryChangedFiles: [turnFile, repositoryOnlyFile],
            turnAttributedFiles: [{ file: turnFile, confidence: 'high' }],
            showTurnViewToggle: true,
            showSessionViewToggle: false,
        }));
        useCommitSelectionSpy.mockReturnValue(makeCommitSelectionResult({
            bulkSelectAll,
            bulkSelectFiles,
            disableSelectAll: false,
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

        expect(commitTabRenderSpy.mock.calls.at(-1)?.[0].changedFilesViewMode).toBe('turn');

        await act(async () => {
            commitTabRenderSpy.mock.calls.at(-1)?.[0].onSelectAll();
        });

        expect(bulkSelectAll).not.toHaveBeenCalled();
        expect(bulkSelectFiles).toHaveBeenCalledTimes(1);
        expect(bulkSelectFiles).toHaveBeenCalledWith([turnFile]);
    });
});
