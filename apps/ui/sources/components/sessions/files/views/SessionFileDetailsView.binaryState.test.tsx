import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type { Session, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { Project } from '@/sync/runtime/orchestration/projectManager';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';
import { FileBinaryState } from '@/components/sessions/files/file/FileScreenState';

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

installSessionFilesViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (spec: any) => spec?.web ?? spec?.default,
            },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSession: () => binarySession,
            useProjectForSession: () => binaryProject,
            useSessionWorkspacePath: () => '/workspace',
            useSessions: () => [],
            useSessionReviewCommentsDrafts: () => [],
            useSessionProjectScmCommitSelectionPaths: () => [],
            useSessionProjectScmCommitSelectionPatches: () => [],
            useSessionProjectScmInFlightOperation: () => null,
            useSessionProjectScmSnapshot: () => binarySnapshot,
            useSetting: () => null,
            importOriginal,
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/components/sessions/files/file/FileHeader', () => ({
  FileHeader: (props: any) => React.createElement('FileHeader', props, props.rightElement ?? null),
}));

vi.mock('@/components/sessions/sourceControl/changes/ScmChangeDiscardButton', () => ({
  ScmChangeDiscardButton: (props: any) => React.createElement('ScmChangeDiscardButton', props),
}));

vi.mock('@/components/sessions/files/file/FileActionToolbar', () => ({
  FileActionToolbar: (props: any) => React.createElement('FileActionToolbar', props, props.rightElement ?? null),
}));

vi.mock('@/components/sessions/files/file/FileContentPanel', () => ({
  FileContentPanel: (props: any) => React.createElement('FileContentPanel', props),
}));

vi.mock('@/components/sessions/files/file/editor/FileEditorPanel', () => ({
  FileEditorPanel: (props: any) => React.createElement('FileEditorPanel', props),
}));

vi.mock('@/components/ui/markdown/editor/RichMarkdownEditorPanel', () => ({
  RichMarkdownEditorPanel: (props: any) => React.createElement('RichMarkdownEditorPanel', props),
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
    path: 'bin.zip',
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
let binarySnapshot: ScmWorkingSnapshot = {
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
  binarySnapshot = { ...binarySnapshot, fetchedAt: 1, entries: [binaryEntry] };

});

describe('SessionFileDetailsView (binary)', () => {
  it('hides the download action when downloads are unavailable', async () => {
    downloadAvailabilityState.value = false;
    const { SessionFileDetailsView } = await import('./SessionFileDetailsView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<SessionFileDetailsView sessionId="s1" scopeId="session:s1" filePath="bin.zip" />)).tree;

    await act(async () => {});

    expect(tree.findAllByType('FileActionToolbar' as any).length).toBe(1);
    expect(tree.findAllByProps({ testID: 'file-header-download', accessibilityRole: 'button' }).length).toBe(0);
  });

  it('renders header actions even when file content is binary', async () => {
    const { SessionFileDetailsView } = await import('./SessionFileDetailsView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<SessionFileDetailsView sessionId="s1" scopeId="session:s1" filePath="bin.zip" />)).tree;

    // Flush the refresh effect.
    await act(async () => {});

    expect(tree.findAllByType('FileActionToolbar' as any).length).toBe(1);
    expect(tree.findByType('FileActionToolbar' as any).props.showWrapLinesToggle).toBe(false);
    expect(tree.findAllByType('ScmChangeDiscardButton' as any).length).toBe(1);
    expect(tree.findAllByProps({ testID: 'file-header-download', accessibilityRole: 'button' }).length).toBe(1);
    expect(tree.findAllByType(FileBinaryState).length).toBe(1);

    await act(async () => {
      await pressTestInstanceAsync(tree.findByProps({ testID: 'file-header-download', accessibilityRole: 'button' }));
    });

    expect(startDownloadSpy).toHaveBeenCalledWith({ path: 'bin.zip', asZip: false });
  });

});

it('keeps file windows focused on the file without unreachable session pane navigation', async () => {
  const { SessionFileDetailsView } = await import('./SessionFileDetailsView');
  const { tree } = await renderScreen(
    <SessionFileDetailsView sessionId="s1" scopeId="session:s1" filePath="bin.zip" presentation="window" isActive={true} />,
  );
  await act(async () => {});
  expect(tree.findAllByProps({ testID: 'file-header-reveal', accessibilityRole: 'button' })).toHaveLength(0);
  expect(tree.findAllByProps({ testID: 'file-header-open-changes', accessibilityRole: 'button' })).toHaveLength(0);
  expect(tree.findAllByProps({ testID: 'file-header-download', accessibilityRole: 'button' }).length).toBeGreaterThan(0);
});
