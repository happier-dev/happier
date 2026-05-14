import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
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
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: vi.fn(),
                prompt: vi.fn(),
                show: vi.fn(),
            },
        }).module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSession: () => scmRefreshSession,
            useProjectForSession: () => scmRefreshProject,
            useSessions: () => [],
            useSessionReviewCommentsDrafts: () => [],
            useWorkspaceReviewCommentsDrafts: () => [],
            useSessionProjectScmCommitSelectionPaths: () => [],
            useSessionProjectScmCommitSelectionPatches: () => [],
            useSessionProjectScmInFlightOperation: () => null,
            useSessionProjectScmSnapshot: () => scmSnapshot,
            useWorkspaceScmCommitSelectionPaths: () => [],
            useWorkspaceScmCommitSelectionPatches: () => [],
            useWorkspaceScmInFlightOperation: () => null,
            useWorkspaceScmSnapshot: () => scmSnapshot,
            useSetting: () => null,
            importOriginal,
        });
    },
});

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
  readMachineTargetForSession: () => ({ machineId: 'm1', basePath: '/workspace' }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
  usePreferredServerIdForSession: () =>
    React.useSyncExternalStore(
      (listener: () => void) => {
        activeServerState.listeners.add(listener);
        return () => {
          activeServerState.listeners.delete(listener);
        };
      },
      () => activeServerState.serverId,
      () => activeServerState.serverId,
    ),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
  resolvePreferredServerIdForSessionId: () => activeServerState.serverId,
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

vi.mock('@/components/workspaces/files/file/FileHeader', () => ({
  FileHeader: (props: any) => React.createElement('FileHeader', props, props.rightElement ?? null),
}));

vi.mock('@/components/workspaces/files/file/FileActionToolbar', () => ({
  FileActionToolbar: (props: any) => React.createElement('FileActionToolbar', props),
}));

vi.mock('@/components/workspaces/files/file/FileContentPanel', () => ({
  FileContentPanel: (props: any) => React.createElement('FileContentPanel', props),
}));

vi.mock('@/components/workspaces/files/file/editor/FileEditorPanel', () => ({
  FileEditorPanel: (props: any) => React.createElement('FileEditorPanel', props),
}));

vi.mock('@/components/sessions/sourceControl/changes/ScmChangeDiscardButton', () => ({
  ScmChangeDiscardButton: (props: any) => React.createElement('ScmChangeDiscardButton', props),
}));

vi.mock('@/components/workspaces/files/file/FileScreenState', () => ({
  FileLoadingState: (props: any) => React.createElement('FileLoadingState', props),
  FileErrorState: (props: any) => React.createElement('FileErrorState', props),
  FileBinaryState: (props: any) => React.createElement('FileBinaryState', props),
}));

vi.mock('@/components/workspaces/files/details/WorkspaceFileDetailsView', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/workspaces/files/details/WorkspaceFileDetailsView')>();
  return {
    ...actual,
    WorkspaceFileDetailsView: (props: any) => {
      workspaceFileDetailsViewState.current = props;
      return React.createElement(actual.WorkspaceFileDetailsView, props);
    },
  };
});

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

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => true,
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

vi.mock('@/scm/scmLineSelection', () => ({
  buildFileLineSelectionFingerprint: (entry: any) => {
    if (!entry) return 'none';
    return `${entry.path}:${entry.stats?.pendingAdded ?? 0}:${entry.stats?.pendingRemoved ?? 0}`;
  },
  canUseLineSelection: () => false,
    canStartLineSelection: () => false,
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

const refreshSpy = vi.fn(async (_input: any) => {
  const call = refreshSpy.mock.calls.length;
  return {
    status: 'ready' as const,
    error: null,
    diffContent: call <= 1 ? 'diff-1' : 'diff-2',
    fileContent: { content: 'file', isBinary: false },
    fileWriteSupported: true,
  };
});
const activeServerState = vi.hoisted(() => {
    const listeners = new Set<() => void>();

    return {
        serverId: 'srv1' as string | null,
        listeners,
        setServerId(next: string | null) {
            activeServerState.serverId = next;
            for (const listener of Array.from(listeners)) {
                listener();
            }
        },
        reset() {
            activeServerState.serverId = 'srv1';
            listeners.clear();
        },
    };
});
const workspaceFileDetailsViewState = vi.hoisted(() => ({
  current: null as any,
}));

const scmRefreshSession: Session = createSessionFixture({
    id: 's1',
    serverId: 'srv-session',
    active: true,
    metadata: {
        path: '/workspace',
        host: 'tester.local',
        homeDir: '/Users/tester',
        machineId: 'm1',
    } as Session['metadata'],
});
const scmRefreshProject: Project = {
    id: 'project-1',
    key: { serverId: null as unknown as string, machineId: 'm1', rootPath: '/workspace' },
    sessionIds: ['s1'],
    createdAt: 1,
    updatedAt: 1,
};
const createScmRefreshEntry = (pendingAdded: number, pendingRemoved: number): ScmWorkingSnapshot['entries'][number] => ({
    path: 'src/a.txt',
    kind: 'modified',
    includeStatus: 'unmodified',
    pendingStatus: 'modified',
    hasIncludedDelta: false,
    hasPendingDelta: true,
    previousPath: null,
    stats: {
        pendingAdded,
        pendingRemoved,
        includedAdded: 0,
        includedRemoved: 0,
        isBinary: false,
    },
});

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/refreshWorkspaceFileDetails', () => ({
  refreshWorkspaceFileDetails: (input: any) => refreshSpy(input),
}));

let scmSnapshot: ScmWorkingSnapshot | null = null;

describe('SessionFileDetailsView (SCM refresh)', () => {
  beforeEach(() => {
    activeServerState.reset();
    workspaceFileDetailsViewState.current = null;
    scmRefreshSession.serverId = 'srv-session';
  });

  it('refreshes diff content in-place when SCM entry fingerprint changes', async () => {
    const { SessionFileDetailsView } = await import('./SessionFileDetailsView');

    scmSnapshot = {
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
        entries: [createScmRefreshEntry(1, 0)],
        capabilities: {
            writeDiscard: true,
            writeCommitPathSelection: true,
            writeCommitLineSelection: true,
        } as ScmWorkingSnapshot['capabilities'],
        hasConflicts: false,
        totals: {
            includedFiles: 0,
            pendingFiles: 1,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 1,
            pendingRemoved: 0,
        },
    };

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<SessionFileDetailsView sessionId="s1" scopeId="session:s1" filePath="src/a.txt" />)).tree;
    await act(async () => {});

    const panels = tree.findAllByType('FileContentPanel' as any);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.props.diffContent).toBe('diff-1');

    // Simulate a snapshot update that should change the selection fingerprint (e.g., commit applied).
    const currentSnapshot = scmSnapshot;
    expect(currentSnapshot).toBeTruthy();
    scmSnapshot = {
        ...currentSnapshot!,
        fetchedAt: currentSnapshot!.fetchedAt + 1,
        entries: [createScmRefreshEntry(0, 0)],
    };

    await act(async () => {
      tree.update(<SessionFileDetailsView sessionId="s1" scopeId="session:s1" filePath="src/a.txt" />);
    });
    await act(async () => {});

    const panelsAfter = tree.findAllByType('FileContentPanel' as any);
    expect(panelsAfter).toHaveLength(1);
    expect(panelsAfter[0]!.props.diffContent).toBe('diff-2');

    // Regression: background refresh should not return to the initial loading skeleton.
    expect(tree.findAllByType('FileLoadingState' as any)).toHaveLength(0);
  });

  it('reacts to active server changes when the session server id is not hydrated yet', async () => {
    scmRefreshSession.serverId = undefined as any;
    const { SessionFileDetailsView } = await import('./SessionFileDetailsView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<SessionFileDetailsView sessionId="s1" scopeId="session:s1" filePath="src/a.txt" />)).tree;
    await act(async () => {});

    expect(workspaceFileDetailsViewState.current.scope.serverId).toBe('srv1');

    await act(async () => {
      activeServerState.setServerId('srv2');
    });

    expect(workspaceFileDetailsViewState.current.scope.serverId).toBe('srv2');
  });
});
