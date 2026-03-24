import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionGitPaneCommonModuleMocks } from './sessionGitPaneTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const commitTabRenderSpy = vi.hoisted(() => vi.fn());

const useChangedFilesDataSpy = vi.fn((_: unknown) => ({
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
}));

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
    useSessionRightPanelGitCommitSelection: () => ({
        repositorySelectedCount: 0,
        isSelectedForCommit: () => false,
        toggleCommitSelectionForFile: vi.fn(),
        bulkSelectAll: vi.fn(),
        bulkSelectNone: vi.fn(),
        disableSelectAll: true,
        disableSelectNone: true,
    }),
}));

describe('SessionRightPanelGitCommitTabContent', () => {
    it('prefers latest-turn view when a canonical latest-turn change set is available', async () => {
        useChangedFilesDataSpy.mockClear();
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
});
