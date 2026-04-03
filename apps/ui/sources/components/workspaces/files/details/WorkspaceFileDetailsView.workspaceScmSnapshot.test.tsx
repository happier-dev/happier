import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { installWorkspaceFileDetailsCommonModuleMocks } from './workspaceFileDetails/workspaceFileDetailsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

installWorkspaceFileDetailsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (spec: any) => spec?.ios ?? spec?.default,
            },
        });
    },
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/sessions/files/file/FileHeader', () => ({
    FileHeader: (props: any) => React.createElement('FileHeader', props, props.rightElement ?? null),
}));

vi.mock('@/components/sessions/files/file/FileActionToolbar', () => ({
    FileActionToolbar: (props: any) => React.createElement('FileActionToolbar', props),
}));

vi.mock('@/components/sessions/files/file/FileContentPanel', () => ({
    FileContentPanel: (props: any) => React.createElement('FileContentPanel', props),
}));

vi.mock('@/components/sessions/files/file/editor/FileEditorPanel', () => ({
    FileEditorPanel: (props: any) => React.createElement('FileEditorPanel', props),
}));

vi.mock('@/components/sessions/files/file/FileScreenState', () => ({
    FileLoadingState: (props: any) => React.createElement('FileLoadingState', props),
    FileErrorState: (props: any) => React.createElement('FileErrorState', props),
    FileBinaryState: (props: any) => React.createElement('FileBinaryState', props),
}));

vi.mock('@/components/sessions/sourceControl/changes/ScmChangeDiscardButton', () => ({
    ScmChangeDiscardButton: (props: any) => React.createElement('ScmChangeDiscardButton', props),
}));

vi.mock('@/components/sessions/files/file/FileDownloadButton', () => ({
    FileDownloadButton: (props: any) => React.createElement('FileDownloadButton', props),
}));

vi.mock('@/components/workspaces/files/file/WorkspaceFileDownloadButton', () => ({
    WorkspaceFileDownloadButton: (props: any) => React.createElement('WorkspaceFileDownloadButton', props),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: { details: { tabState: {} } },
        setDetailsTabState: vi.fn(),
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers', () => ({
    useWorkspaceReviewCommentDraftHandlers: () => ({
        onUpsertReviewCommentDraft: vi.fn(),
        onDeleteReviewCommentDraft: vi.fn(),
        onReviewCommentError: vi.fn(),
    }),
}));

vi.mock('@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting', () => ({
    useCodeLinesSyntaxHighlighting: () => ({ mode: 'off' }),
}));

vi.mock('@/utils/code/fileLanguage', () => ({
    getFileLanguageFromPath: () => 'txt',
}));

vi.mock('@/scm/settings/commitStrategy', () => ({
    SCM_COMMIT_STRATEGIES: ['atomic', 'git_staging'],
    allowsLiveStaging: () => false,
    isAtomicCommitStrategy: () => true,
}));

vi.mock('@/scm/diff/defaultMode', () => ({
    resolveDefaultDiffModeForFile: () => 'pending',
}));

vi.mock('@/scm/scmLineSelection', () => ({
    buildFileLineSelectionFingerprint: () => 'fingerprint-1',
    canUseLineSelection: () => false,
}));

vi.mock('@/hooks/session/files/useFileScmStageActions', () => ({
    useFileScmStageActions: () => ({
        isApplyingStage: false,
        handleStage: vi.fn(),
        applySelectedLines: vi.fn(),
    }),
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState', () => ({
    useWorkspaceFileEditorState: () => ({
        editorSurfaceEnabled: false,
        isEditingFile: false,
        editorResetKey: 0,
        editorOriginalText: '',
        editorSeedText: '',
        editorHandleRef: { current: null },
        onEditorChange: vi.fn(),
        getEditorText: () => '',
        isSavingEdits: false,
        editorDirty: false,
        editorTooLarge: false,
        editorChunkTooLarge: false,
        startEditingFile: vi.fn(),
        cancelEditingFile: vi.fn(),
        saveFileEdits: vi.fn(),
    }),
}));

const refreshSpy = vi.fn(async (_input: any) => ({
    status: 'ready' as const,
    error: null,
    diffContent: null,
    fileContent: { content: 'hello', isBinary: false },
    fileWriteSupported: true,
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/refreshWorkspaceFileDetails', () => ({
    refreshWorkspaceFileDetails: (input: any) => refreshSpy(input),
}));

const workspaceSnapshot: ScmWorkingSnapshot = {
    projectKey: 'workspace:srv1:m1:/repo',
    fetchedAt: 1,
    repo: {
        isRepo: true,
        rootPath: '/repo',
        backendId: 'git',
        mode: '.git',
        worktrees: [],
    },
    branch: {
        head: 'main',
        upstream: null,
        ahead: 0,
        behind: 0,
        detached: false,
    },
    hasConflicts: false,
    entries: [
        {
            path: 'src/a.txt',
            kind: 'modified',
            includeStatus: 'unmodified',
            pendingStatus: 'modified',
            hasIncludedDelta: false,
            hasPendingDelta: true,
            previousPath: null,
            stats: {
                pendingAdded: 1,
                pendingRemoved: 1,
                includedAdded: 0,
                includedRemoved: 0,
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
        pendingAdded: 1,
        pendingRemoved: 1,
    },
    capabilities: {
        readStatus: true,
        readDiffFile: true,
        readDiffCommit: true,
        readLog: true,
        writeInclude: true,
        writeExclude: true,
        writeCommit: true,
        writeCommitPathSelection: true,
        writeCommitLineSelection: true,
        writeBackout: true,
        writeDiscard: true,
        writeRemoteFetch: true,
        writeRemotePull: true,
        writeRemotePush: true,
        readBranches: true,
        writeBranchCreate: true,
        writeBranchCheckout: true,
        readStash: true,
        writeStash: true,
        worktreeCreate: true,
    },
};

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSession: () => null,
        useProjectForSession: () => null,
        useSetting: () => null,
        useSessionProjectScmSnapshot: () => null,
        useSessionProjectScmCommitSelectionPaths: () => [],
        useSessionProjectScmCommitSelectionPatches: () => [],
        useSessionProjectScmInFlightOperation: () => null,
        useWorkspaceScmSnapshot: () => workspaceSnapshot,
        useWorkspaceScmCommitSelectionPaths: () => [],
        useWorkspaceScmCommitSelectionPatches: () => [],
        useWorkspaceScmInFlightOperation: () => null,
        useWorkspaceReviewCommentsDrafts: () => [],
        importOriginal,
    });
});

describe('WorkspaceFileDetailsView (workspace SCM snapshot)', () => {
    it('passes workspace file entry kind into refreshWorkspaceFileDetails', async () => {
        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');

        await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/repo"
                scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/repo' }}
                filePath="src/a.txt"
                sessionIdForAugmentation={null}
            />,
        );

        expect(refreshSpy).toHaveBeenCalled();
        const firstCall = refreshSpy.mock.calls[0]?.[0];
        expect(firstCall?.fileEntryKind).toBe('modified');
    });

    it('renders a workspace-scoped download action when preview is too large (no sessionId required)', async () => {
        refreshSpy.mockResolvedValueOnce({
            status: 'ready' as const,
            error: 'files.fileTooLargeToPreview',
            diffContent: null,
            fileContent: null,
            fileWriteSupported: true,
        } as any);

        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');

        const screen = await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/repo"
                scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/repo' }}
                filePath="src/a.txt"
                sessionIdForAugmentation={null}
            />,
        );

        expect(screen.findAllByType('WorkspaceFileDownloadButton')).toHaveLength(1);
    });
});
