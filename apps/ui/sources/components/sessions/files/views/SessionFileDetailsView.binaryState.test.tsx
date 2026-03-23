import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type { Session, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { Project } from '@/sync/runtime/orchestration/projectManager';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                                    Platform: {
                                                        OS: 'ios',
                                                        select: (spec: any) => spec?.ios ?? spec?.default,
                                                    },
                                                }
    );
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/layout/layout', () => ({
  layout: { maxWidth: 1024 },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: vi.fn(),
            confirm: vi.fn(),
            prompt: vi.fn(),
            show: vi.fn(),
        },
    }).module;
});

vi.mock('@/components/sessions/files/file/FileHeader', () => ({
  FileHeader: (props: any) => React.createElement('FileHeader', props, props.rightElement ?? null),
}));

vi.mock('@/components/sessions/sourceControl/changes/ScmChangeDiscardButton', () => ({
  ScmChangeDiscardButton: (props: any) => React.createElement('ScmChangeDiscardButton', props),
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
const binarySession: Session = createSessionFixture({
    id: 's1',
    active: true,
    metadata: {
        path: '/workspace',
        host: 'tester.local',
        homeDir: '/Users/tester',
        machineId: 'm1',
    } as Session['metadata'],
});
const binaryProject: Project = {
    id: 'project-1',
    key: { machineId: 'm1', path: '/workspace' },
    sessionIds: ['s1'],
    createdAt: 1,
    updatedAt: 1,
};
const binaryEntry: ScmWorkingSnapshot['entries'][number] = {
    path: 'bin.dat',
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
        isBinary: true,
    },
};
const binarySnapshot: ScmWorkingSnapshot = {
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
    entries: [binaryEntry],
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

vi.mock('@/hooks/session/files/useWorkspaceFileTransfers', () => ({
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
  error: null,
  diffContent: null,
  fileContent: { content: '', isBinary: true },
  fileWriteSupported: true,
}));

vi.mock('./sessionFileDetails/refreshSessionFileDetails', () => ({
  refreshSessionFileDetails: (input: any) => refreshSpy(input),
}));

vi.mock('@/hooks/session/files/useFileScmStageActions', () => ({
  useFileScmStageActions: () => ({
    isApplyingStage: false,
    handleStage: vi.fn(),
    handleUnstage: vi.fn(),
    applySelectedLines: vi.fn(),
  }),
}));

vi.mock('./sessionFileDetails/useSessionFileEditorState', () => ({
  useSessionFileEditorState: () => ({
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
    fileWriteSupported: true,
    startEditingFile: vi.fn(),
    cancelEditingFile: vi.fn(),
    saveFileEdits: vi.fn(),
    editorResetKey: 0,
  }),
}));

vi.mock('@/components/sessions/reviews/comments/useSessionReviewCommentDraftHandlers', () => ({
  useSessionReviewCommentDraftHandlers: () => ({
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

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSession: () => binarySession,
    useProjectForSession: () => binaryProject,
    useSessions: () => [],
    useSessionReviewCommentsDrafts: () => [],
    useSessionProjectScmCommitSelectionPaths: () => [],
    useSessionProjectScmCommitSelectionPatches: () => [],
    useSessionProjectScmInFlightOperation: () => null,
    useSessionProjectScmSnapshot: () => binarySnapshot,
    useSetting: () => null,
});
});

describe('SessionFileDetailsView (binary)', () => {
  it('renders header actions even when file content is binary', async () => {
    const { SessionFileDetailsView } = await import('./SessionFileDetailsView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<SessionFileDetailsView sessionId="s1" scopeId="session:s1" filePath="bin.dat" />)).tree;

    // Flush the refresh effect.
    await act(async () => {});

    expect(refreshSpy).toHaveBeenCalled();
    expect(tree.findAllByType('FileHeader' as any).length).toBe(1);
    expect(tree.findAllByType('ScmChangeDiscardButton' as any).length).toBe(1);
    expect(tree.findAllByProps({ testID: 'file-header-download', accessibilityRole: 'button' }).length).toBe(1);
    expect(tree.findAllByType('FileBinaryState' as any).length).toBe(1);

    await act(async () => {
      await pressTestInstanceAsync(tree.findByProps({ testID: 'file-header-download', accessibilityRole: 'button' }));
    });

    expect(startDownloadSpy).toHaveBeenCalledWith({ path: 'bin.dat', asZip: false });
  });
});
