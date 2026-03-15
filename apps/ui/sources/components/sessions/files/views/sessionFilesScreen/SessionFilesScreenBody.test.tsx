import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { SessionFilesScreenBody, type SessionFilesScreenBodyProps } from './SessionFilesScreenBody';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: (props: any) => React.createElement('View', props, props.children),
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#666',
            },
        },
    }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));

vi.mock('@/components/sessions/files/SourceControlBranchSummary', () => ({
    SourceControlBranchSummary: () => React.createElement('SourceControlBranchSummary'),
}));

vi.mock('@/components/sessions/files/SourceControlOperationsPanel', () => ({
    SourceControlOperationsPanel: () => React.createElement('SourceControlOperationsPanel'),
}));

vi.mock('@/components/sessions/files/content/ChangedFilesList', () => ({
    ChangedFilesList: () => React.createElement('ChangedFilesList'),
}));

vi.mock('@/components/sessions/files/content/ChangedFilesReview', () => ({
    ChangedFilesReview: () => React.createElement('ChangedFilesReview'),
}));

vi.mock('@/components/sessions/sourceControl/states', () => ({
    NotSourceControlRepositoryState: () => React.createElement('NotSourceControlRepositoryState'),
    SourceControlSessionInactiveState: () => React.createElement('SourceControlSessionInactiveState'),
    SourceControlUnavailableState: () => React.createElement('SourceControlUnavailableState'),
}));

vi.mock('@/components/sessions/files/views/SessionRepositoryTreeBrowserView', () => ({
    SessionRepositoryTreeBrowserView: (props: any) => React.createElement('SessionRepositoryTreeBrowserView', props),
}));

vi.mock('@/scm/diffCache/useScmDiffCacheLimits', () => ({
    useScmDiffCacheLimits: () => {},
}));

describe('SessionFilesScreenBody', () => {
    it('allows file browsing when session is inactive in all-files mode', () => {
        const theme = {
            colors: {
                textSecondary: '#666',
            },
        } as SessionFilesScreenBodyProps['theme'];

        const props: SessionFilesScreenBodyProps = {
            theme,
            sessionId: 's1',
            isRefreshing: false,
            scmPanelExpanded: false,
            showScmOperationsPanel: false,
            scmStatusFiles: null,
            scmSnapshot: null,
            scmSnapshotError: null,
            hasConflicts: false,
            hasGlobalOperationInFlight: false,
            inFlightScmOperation: null,
            isSessionInactive: true,
            machineReachable: true,
            machineRpcTargetAvailable: false,
            backendLabel: 'Git',
            commitActionLabel: 'Commit',
            scmOperationBusy: false,
            scmOperationStatus: null,
            commitAllowed: false,
            commitBlockedMessage: null,
            pullAllowed: false,
            pullBlockedMessage: null,
            pushAllowed: false,
            pushBlockedMessage: null,
            commitMessageDraft: '',
            onCommitMessageDraftChange: () => {},
            onCommitFromMessage: () => {},
            onCreateCommit: () => {},
            onFetch: () => {},
            onPull: () => {},
            onPush: () => {},
            onLoadMoreHistory: () => {},
            onOpenCommit: () => {},
            operationLog: [],
            commitSelectionCount: 0,
            onClearCommitSelection: undefined,
            historyLoading: false,
            historyEntries: [],
            historyHasMore: false,
            shouldShowAllFiles: true,
            searchQuery: '',
            onSearchQueryChange: () => {},
            onOpenRepositoryFile: () => {},
            onFilePress: () => {},
            changedFilesPresentation: 'list',
            changedFilesViewMode: 'repository',
            attributionReliability: 'high',
            allRepositoryChangedFiles: [],
            sessionAttributedFiles: [],
            repositoryOnlyFiles: [],
            suppressedInferredCount: 0,
            reviewFocusPath: null,
            rowDensity: 'compact',
            reviewMaxFiles: 5,
            reviewMaxChangedLines: 500,
            diffAutoRefreshIntervalMs: 0,
            diffRefreshToken: 0,
            scmCommitStrategy: 'git_staging',
            disableSelectAll: false,
            disableSelectNone: false,
            selectedCount: 0,
            onSelectAll: () => {},
            onSelectNone: () => {},
            onToggleSelectionForFile: () => {},
            renderFileActions: () => null,
            renderFileTrailingActions: () => null,
            onOpenSession: () => {},
            onRefresh: () => {},
        };

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(<SessionFilesScreenBody {...props} />);
        });
        const repositoryTree = tree.root.findByType('SessionRepositoryTreeBrowserView');
        expect(repositoryTree).toBeTruthy();
    });
});
