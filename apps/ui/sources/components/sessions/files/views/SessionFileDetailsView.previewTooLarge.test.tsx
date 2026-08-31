import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type { Session, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { Project } from '@/sync/runtime/orchestration/projectManager';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

installSessionFilesViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (spec: any) => spec?.ios ?? spec?.default,
            },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSession: () => previewSession,
            useProjectForSession: () => previewProject,
            useSessions: () => [],
            useSessionReviewCommentsDrafts: () => [],
            useSessionProjectScmCommitSelectionPaths: () => [],
            useSessionProjectScmCommitSelectionPatches: () => [],
            useSessionProjectScmInFlightOperation: () => null,
            useSessionProjectScmSnapshot: () => previewSnapshot,
            useWorkspaceScmCommitSelectionPaths: () => [],
            useWorkspaceScmCommitSelectionPatches: () => [],
            useWorkspaceScmInFlightOperation: () => null,
            useWorkspaceScmSnapshot: () => previewSnapshot,
            useSetting: () => null,
            useWorkspaceReviewCommentsDrafts: () => [],
            importOriginal,
        });
    },
});

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
  readMachineTargetForSession: () => ({ machineId: 'm1', basePath: '/workspace' }),
}));

vi.mock('@/sync/domains/session/resolveWorkspaceScopeForSession', () => ({
  useWorkspaceScopeForSession: () => ({
    serverId: 'srv1',
    machineId: 'm1',
    rootPath: '/workspace',
  }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
  usePreferredServerIdForSession: () => 'srv1',
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/components/workspaces/files/file/FileHeader', () => ({
  FileHeader: (props: any) => React.createElement('FileHeader', props, props.rightElement ?? null),
}));

vi.mock('@/components/sessions/sourceControl/changes/ScmChangeDiscardButton', () => ({
  ScmChangeDiscardButton: (props: any) => React.createElement('ScmChangeDiscardButton', props),
}));

vi.mock('@/components/workspaces/files/file/FileActionToolbar', () => ({
  FileActionToolbar: (props: any) => React.createElement('FileActionToolbar', props, props.rightElement ?? null),
}));

vi.mock('@/components/workspaces/files/file/FileContentPanel', () => ({
  FileContentPanel: (props: any) => React.createElement('FileContentPanel', props),
}));

vi.mock('@/components/workspaces/files/file/editor/FileEditorPanel', () => ({
  FileEditorPanel: (props: any) => React.createElement('FileEditorPanel', props),
}));

vi.mock('@/components/workspaces/files/file/FileScreenState', () => ({
  FileLoadingState: (props: any) => React.createElement('FileLoadingState', props),
  FileErrorState: (props: any) => React.createElement('FileErrorState', props),
  FileBinaryState: (props: any) => React.createElement('FileBinaryState', props),
}));

vi.mock('@/hooks/ui/useMountedRef', () => ({
  useMountedRef: () => ({ current: true }),
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
  useScrollEdgeFades: () => ({
    visibility: { top: false, bottom: false, left: false, right: false },
    onViewportLayout: vi.fn(),
    onContentSizeChange: vi.fn(),
    onScroll: vi.fn(),
  }),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
  ScrollEdgeFades: (props: any) => React.createElement('ScrollEdgeFades', props),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
  ScrollEdgeIndicators: (props: any) => React.createElement('ScrollEdgeIndicators', props),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
  useAppPaneScope: () => ({
    scopeState: { details: { tabState: {} } },
    setDetailsTabState: vi.fn(),
  }),
}));

const startDownloadSpy = vi.fn(async (_input: any) => ({ ok: true as const }));
const downloadAvailabilityState = { value: true };
const previewSession: Session = createSessionFixture({
    id: 's1',
    active: true,
    metadata: {
        path: '/workspace',
        host: 'tester.local',
        homeDir: '/Users/tester',
        machineId: 'm1',
    } as Session['metadata'],
});
const previewProject: Project = {
    id: 'project-1',
    key: { serverId: 'srv1', machineId: 'm1', rootPath: '/workspace' },
    sessionIds: ['s1'],
    createdAt: 1,
    updatedAt: 1,
};
const previewEntry: ScmWorkingSnapshot['entries'][number] = {
    path: 'big.txt',
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
};
const previewSnapshot: ScmWorkingSnapshot = {
    projectKey: 'project-1',
    fetchedAt: 1,
    repo: {
        isRepo: true,
        rootPath: '/workspace',
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
    entries: [previewEntry],
    totals: {
        includedFiles: 0,
        pendingFiles: 1,
        untrackedFiles: 0,
        includedAdded: 0,
        includedRemoved: 0,
        pendingAdded: 1,
        pendingRemoved: 1,
    },
    capabilities: { writeDiscard: true } as ScmWorkingSnapshot['capabilities'],
};

vi.mock('@/hooks/workspaces/transfers/useWorkspaceFileTransfers', () => ({
  useWorkspaceFileTransfers: () => ({
    uploadState: { status: 'idle' },
    downloadState: { status: 'idle' },
    startUploads: vi.fn(async () => ({ ok: true })),
    cancelUploads: vi.fn(),
    startDownload: (input: any) => startDownloadSpy(input),
    cancelDownload: vi.fn(),
  }),
}));

const refreshSpy = vi.fn(async (..._args: any[]) => ({
  status: 'ready' as const,
  error: 'files.fileTooLargeToPreview',
  diffContent: null,
  fileContent: null,
  fileWriteSupported: false,
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/refreshWorkspaceFileDetails', () => ({
  refreshWorkspaceFileDetails: (input: any) => refreshSpy(input),
}));

vi.mock('@/hooks/session/files/useFileScmStageActions', () => ({
  useFileScmStageActions: () => ({
    isApplyingStage: false,
    handleStage: vi.fn(),
    handleUnstage: vi.fn(),
    applySelectedLines: vi.fn(),
  }),
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState', () => ({
  useWorkspaceFileEditorState: () => ({
    editorSurfaceEnabled: false,
    editorSeedText: '',
    editorHandleRef: { current: null },
    onEditorChange: vi.fn(),
    getEditorText: () => '',
    editorDirty: false,
    editorTooLarge: false,
    editorChunkTooLarge: false,
    isEditingFile: false,
    isSavingEdits: false,
    fileWriteSupported: false,
    startEditingFile: vi.fn(),
    cancelEditingFile: vi.fn(),
    saveFileEdits: vi.fn(),
    editorResetKey: 0,
  }),
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers', () => ({
  useWorkspaceReviewCommentDraftHandlers: () => ({
    onUpsertReviewCommentDraft: vi.fn(),
    onDeleteReviewCommentDraft: vi.fn(),
    onReviewCommentError: vi.fn(),
  }),
}));

vi.mock('@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting', () => ({
  useCodeLinesSyntaxHighlighting: () => ({ syntaxHighlighting: null }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (id: string) => id === 'scm.writeOperations',
}));

vi.mock('@/scm/scmLineSelection', () => ({
  buildFileLineSelectionFingerprint: () => 'fp',
  canUseLineSelection: () => false,
    canStartLineSelection: () => false,
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

vi.mock('@/components/sessions/files/useSessionFileDownloadAvailability', () => ({
  useSessionFileDownloadAvailability: () => downloadAvailabilityState.value,
}));

beforeEach(() => {
  downloadAvailabilityState.value = true;
});

describe('SessionFileDetailsView (preview too large)', () => {
  it('keeps the download action available when the workspace scope is available', async () => {
    downloadAvailabilityState.value = false;
    const { SessionFileDetailsView } = await import('./SessionFileDetailsView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<SessionFileDetailsView sessionId="s1" scopeId="session:s1" filePath="big.txt" />)).tree;

    await act(async () => {});

    expect(tree.findAllByType('FileActionToolbar' as any).length).toBe(1);
    expect(tree.findByType('FileActionToolbar' as any).props.showWrapLinesToggle).toBe(false);
    expect(tree.findAllByTestId('file-preview-unavailable-banner').length).toBe(1);
    expect(tree.findAllByProps({ testID: 'file-header-download', accessibilityRole: 'button' }).length).toBe(1);
  });

  it('renders a download action instead of a fatal error state', async () => {
    const { SessionFileDetailsView } = await import('./SessionFileDetailsView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<SessionFileDetailsView sessionId="s1" scopeId="session:s1" filePath="big.txt" />)).tree;

    await act(async () => {});

    expect(refreshSpy).toHaveBeenCalled();
    expect(tree.findAllByType('FileErrorState' as any).length).toBe(0);
    expect(tree.findAllByType('FileActionToolbar' as any).length).toBe(1);
    expect(tree.findAllByTestId('file-preview-unavailable-banner').length).toBe(1);
    expect(tree.findAllByProps({ testID: 'file-header-download', accessibilityRole: 'button' }).length).toBe(1);

    await act(async () => {
      await pressTestInstanceAsync(tree.findByProps({ testID: 'file-header-download', accessibilityRole: 'button' }));
    });

    expect(startDownloadSpy).toHaveBeenCalledWith({ path: 'big.txt', asZip: false });
  });
});
