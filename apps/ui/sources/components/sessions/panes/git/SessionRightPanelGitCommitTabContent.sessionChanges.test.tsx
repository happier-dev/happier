import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                                                    View: (props: any) => React.createElement('View', props, props.children),
                                                                }
    );
});

vi.mock('@/components/sessions/panes/git/SessionRightPanelGitCommitTab', () => ({
    SessionRightPanelGitCommitTab: (props: any) => React.createElement('SessionRightPanelGitCommitTab', props),
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

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: () => ({
            getSessionRepositoryTreeExpandedPaths: () => [],
            setSessionRepositoryTreeExpandedPaths: vi.fn(),
        }),
    },
    useSession: () => ({ metadata: {} }),
    useProjectForSession: () => null,
    useSessionMessages: () => ({ messages: [] }),
});
});

describe('SessionRightPanelGitCommitTabContent', () => {
    it('prefers latest-turn view when a canonical latest-turn change set is available', async () => {
        useChangedFilesDataSpy.mockClear();
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

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionRightPanelGitCommitTabContent
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
                />)).tree;

        expect(useChangedFilesDataSpy).toHaveBeenCalledWith(expect.objectContaining({
            latestTurnChangeSet: expect.objectContaining({ sessionId: 's1' }),
            sessionChangeSet: expect.objectContaining({ sessionId: 's1' }),
        }));

        const commitTab = tree!.root.findByType('SessionRightPanelGitCommitTab' as any);
        expect(commitTab.props.changedFilesViewMode).toBe('turn');
    });
});
