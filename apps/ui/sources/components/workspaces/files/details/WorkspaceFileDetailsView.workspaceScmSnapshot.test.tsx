import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmCommitSelectionPatch } from '@/sync/domains/state/storageTypes';
import type { WorkspaceFileDetailsRefreshResult } from './workspaceFileDetails/refreshWorkspaceFileDetails';
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

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/components/workspaces/files/file/FileHeader', () => ({
    FileHeader: (props: any) => React.createElement('FileHeader', props, props.rightElement ?? null),
}));

vi.mock('@/components/workspaces/files/file/FileContentPanel', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/workspaces/files/file/FileContentPanel')>(),
    FileContentPanel: (props: any) => React.createElement('FileContentPanel', props),
}));

vi.mock('@/components/workspaces/files/file/editor/FileEditorPanel', () => ({
    FileEditorPanel: (props: any) => React.createElement('FileEditorPanel', props),
}));

vi.mock('@/components/workspaces/files/file/FileScreenState', () => ({
    FileLoadingState: (props: any) => React.createElement('FileLoadingState', props),
    FileErrorState: (props: any) => React.createElement('FileErrorState', props),
}));

vi.mock('@/components/workspaces/files/details/sessionAugmentation/WorkspaceAugmentedScmChangeDiscardButton', () => ({
    WorkspaceAugmentedScmChangeDiscardButton: (props: any) => React.createElement('ScmChangeDiscardButton', props),
}));

vi.mock('@/components/workspaces/files/file/WorkspaceFileDownloadButton', () => ({
    WorkspaceFileDownloadButton: (props: any) => React.createElement('WorkspaceFileDownloadButton', props),
}));

// The pane owner publishes one stable scope object until its state changes.
const paneScope = vi.hoisted(() => ({
    // The pane owner always publishes its Details tabs beside their per-tab state.
    scopeState: { details: { tabs: [], tabState: {} } },
    setDetailsTabState: () => {},
    patchDetailsTabState: () => {},
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/appShell/panes/hooks/useAppPaneScope')>(),
    useAppPaneScope: () => paneScope,
}));

const featureEnabledMock = vi.hoisted(() => vi.fn((_featureId: string) => false));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledMock(featureId),
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

const fileLanguageMock = vi.hoisted(() => vi.fn<(path: string) => string>(() => 'txt'));
vi.mock('@/utils/code/fileLanguage', () => ({
    getFileLanguageFromPath: (path: string) => fileLanguageMock(path),
}));

vi.mock('@/scm/settings/commitStrategy', () => ({
    SCM_COMMIT_STRATEGIES: ['atomic', 'git_staging'],
    allowsLiveStaging: () => false,
    isAtomicCommitStrategy: () => true,
}));

vi.mock('@/scm/diff/defaultMode', () => ({
    resolveDefaultDiffModeForFile: () => 'pending',
}));

// The Machine RPC facade is the boundary: what the page's Discard sends is the contract under test.
const machineScmChangeDiscardMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ success: true, entries: [] as unknown[] })));
vi.mock('@/sync/ops/scm/machineScm', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/ops/scm/machineScm')>(),
    machineScmChangeDiscard: machineScmChangeDiscardMock,
}));

const canUseLineSelectionMock = vi.fn(() => false);

vi.mock('@/scm/scmLineSelection', () => ({
    buildFileLineSelectionFingerprint: () => 'fingerprint-1',
    canUseLineSelection: () => canUseLineSelectionMock(),
    canStartLineSelection: () => canUseLineSelectionMock(),
}));

vi.mock('@/hooks/session/files/useFileScmStageActions', () => ({
    useFileScmStageActions: () => ({
        isApplyingStage: false,
        handleStage: vi.fn(),
        applySelectedLines: vi.fn(),
    }),
}));

const workspaceStageActionsMock = vi.hoisted(() => ({
    applySelectedLines: vi.fn(async () => true),
    handleStage: vi.fn(),
}));
// The real stage-actions owner publishes stable handlers; a fresh object per call would hide header-prop stability.
const workspaceStageActions = vi.hoisted(() => ({
    isApplyingStage: false,
    handleStage: (included: boolean) => workspaceStageActionsMock.handleStage(included),
    applySelectedLines: () => workspaceStageActionsMock.applySelectedLines(),
}));
vi.mock('@/hooks/workspaces/scm/useWorkspaceFileScmStageActions', () => ({
    useWorkspaceFileScmStageActions: () => workspaceStageActions,
}));

const fileEditorState = vi.hoisted(() => ({
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
        startEditingFile: vi.fn(),
        cancelEditingFile: vi.fn(),
        saveFileEdits: vi.fn(),
        readSnapshot: () => ({ isEditingFile: false, hash: null, dirty: false, conflict: null }),
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState', () => ({
    useWorkspaceFileEditorState: () => fileEditorState,
}));

const refreshSpy = vi.fn(async (_input: any): Promise<WorkspaceFileDetailsRefreshResult> => ({
    status: 'ready' as const,
    error: null,
    diffContent: null,
    fileContent: { content: 'hello', isBinary: false },
    fileWriteSupported: true,
}));
let workspaceCommitSelectionPatches: ScmCommitSelectionPatch[] = [];

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/refreshWorkspaceFileDetails', () => ({
    refreshWorkspaceFileDetails: (input: any) => refreshSpy(input),
}));

let workspaceSnapshot: ScmWorkingSnapshot = {
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
        useSessionListPreferredMetadata: () => null,
        useProjectForSession: () => null,
        useSetting: () => null,
        useSessionProjectScmSnapshot: () => null,
        useSessionProjectScmCommitSelectionPaths: () => [],
        useSessionProjectScmCommitSelectionPatches: () => [],
        useSessionProjectScmInFlightOperation: () => null,
        useWorkspaceScmSnapshot: () => workspaceSnapshot,
        useWorkspaceScmCommitSelectionPaths: () => [],
        useWorkspaceScmCommitSelectionPatches: () => workspaceCommitSelectionPatches,
        useWorkspaceScmInFlightOperation: () => null,
        useWorkspaceReviewCommentsDrafts: () => [],
        importOriginal,
    });
});

const { FilePageHeader } = await import('@/components/workspaces/files/file/FilePageHeader');

describe('WorkspaceFileDetailsView (workspace SCM snapshot)', () => {
    it('states that file details are unavailable when the machine scope is missing', async () => {
        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
        const screen = await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="session:offline-session"
                scope={null}
                filePath="src/a.txt"
                sessionIdForAugmentation="offline-session"
            />,
        );
        expect(screen.findByTestId('file-details-scope-unavailable')).not.toBeNull();
        expect(screen.getTextContent()).toContain('errors.daemonUnavailableBody');
    });

    beforeEach(() => {
        canUseLineSelectionMock.mockReset();
        canUseLineSelectionMock.mockReturnValue(false);
        workspaceStageActionsMock.applySelectedLines.mockReset();
        workspaceStageActionsMock.applySelectedLines.mockResolvedValue(true);
        workspaceStageActionsMock.handleStage.mockReset();
        fileLanguageMock.mockReset();
        fileLanguageMock.mockReturnValue('txt');
        featureEnabledMock.mockReset();
        featureEnabledMock.mockReturnValue(false);
        workspaceCommitSelectionPatches = [];
        workspaceSnapshot = {
            ...workspaceSnapshot,
            fetchedAt: 1,
        };
        fileEditorState.editorSurfaceEnabled = false;
        fileEditorState.isEditingFile = false;
        fileEditorState.editorSeedText = '';
        refreshSpy.mockReset();
        refreshSpy.mockImplementation(async (_input: any) => ({
            status: 'ready' as const,
            error: null,
            diffContent: null,
            fileContent: { content: 'hello', isBinary: false },
            fileWriteSupported: true,
        }));
    });

    it('keeps line selection active after the toolbar starts explicit commit selection mode', async () => {
        // Select lines is a commit-selection write: the ⋯ item exists only with SCM writes on.
        featureEnabledMock.mockImplementation((featureId: string) => featureId === 'scm.writeOperations');
        canUseLineSelectionMock.mockReturnValueOnce(true).mockReturnValue(true);
        refreshSpy.mockResolvedValueOnce({
            status: 'ready' as const,
            error: null,
            diffContent: 'diff --git a/src/a.txt b/src/a.txt\n@@ -1 +1 @@\n-old\n+new\n',
            fileContent: { content: 'new', isBinary: false },
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

        await act(async () => {});

        let toolbar = screen.findAllByType(FilePageHeader)[0];
        expect(toolbar?.props.lineSelectionEnabled).toBe(true);
        expect(toolbar?.props.lineSelectionActive).toBe(false);

        await act(async () => {
            toolbar?.props.menuActions.find((action: { id: string }) => action.id === 'selectLines')?.onSelect();
        });

        toolbar = screen.findAllByType(FilePageHeader)[0];
        const contentPanel = screen.findAllByType('FileContentPanel')[0];
        expect(toolbar?.props.lineSelectionActive).toBe(true);
        expect(contentPanel?.props.lineSelectionEnabled).toBe(true);
    });

    it('owns range selection state and passes it to file content while selecting commit lines', async () => {
        // Select lines is a commit-selection write: the ⋯ item exists only with SCM writes on.
        featureEnabledMock.mockImplementation((featureId: string) => featureId === 'scm.writeOperations');
        canUseLineSelectionMock.mockReturnValueOnce(true).mockReturnValue(true);
        refreshSpy.mockResolvedValueOnce({
            status: 'ready' as const,
            error: null,
            diffContent: 'diff --git a/src/a.txt b/src/a.txt\n@@ -1 +1 @@\n-old\n+new\n',
            fileContent: { content: 'new', isBinary: false },
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

        await act(async () => {});

        let toolbar = screen.findAllByType(FilePageHeader)[0];
        await act(async () => {
            toolbar?.props.menuActions.find((action: { id: string }) => action.id === 'selectLines')?.onSelect();
        });

        toolbar = screen.findAllByType(FilePageHeader)[0];
        let contentPanel = screen.findAllByType('FileContentPanel')[0];
        expect(toolbar?.props.rangeSelectionActive).toBe(false);
        expect(contentPanel?.props.rangeSelectionActive).toBe(false);

        await act(async () => {
            toolbar?.props.onStartRangeSelection();
        });

        toolbar = screen.findAllByType(FilePageHeader)[0];
        contentPanel = screen.findAllByType('FileContentPanel')[0];
        expect(toolbar?.props.rangeSelectionActive).toBe(true);
        expect(contentPanel?.props.rangeSelectionActive).toBe(true);

        await act(async () => {
            contentPanel?.props.onToggleLine('additions:1');
        });

        toolbar = screen.findAllByType(FilePageHeader)[0];
        contentPanel = screen.findAllByType('FileContentPanel')[0];
        expect(toolbar?.props.rangeSelectionActive).toBe(false);
        expect(contentPanel?.props.rangeSelectionActive).toBe(false);
        expect(toolbar?.props.selectedLineCount).toBe(1);
    });

    it('passes explicit review comment mode from the toolbar into markdown file content', async () => {
        featureEnabledMock.mockImplementation((featureId: string) => featureId === 'files.reviewComments');
        fileLanguageMock.mockReturnValue('markdown');
        refreshSpy.mockResolvedValueOnce({
            status: 'ready' as const,
            error: null,
            diffContent: null,
            fileContent: { content: '# Title\n\nBody', isBinary: false },
            fileWriteSupported: true,
        } as any);

        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');

        const screen = await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/repo"
                scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/repo' }}
                filePath="README.md"
                sessionIdForAugmentation={null}
            />,
        );

        await act(async () => {});

        let toolbar = screen.findAllByType(FilePageHeader)[0];
        let contentPanel = screen.findAllByType('FileContentPanel')[0];
        expect(toolbar?.props.reviewCommentsEnabled).toBe(true);
        expect(toolbar?.props.commentModeActive).toBe(false);
        expect(contentPanel?.props.reviewCommentModeActive).toBe(false);

        await act(async () => {
            toolbar?.props.onToggleCommentMode(true);
        });

        toolbar = screen.findAllByType(FilePageHeader)[0];
        contentPanel = screen.findAllByType('FileContentPanel')[0];
        expect(toolbar?.props.commentModeActive).toBe(true);
        expect(contentPanel?.props.reviewCommentModeActive).toBe(true);
    });

    it('clears range selection state when applying or canceling commit line selection', async () => {
        // Select lines is a commit-selection write: the ⋯ item exists only with SCM writes on.
        featureEnabledMock.mockImplementation((featureId: string) => featureId === 'scm.writeOperations');
        canUseLineSelectionMock.mockReturnValueOnce(true).mockReturnValue(true);
        refreshSpy.mockResolvedValueOnce({
            status: 'ready' as const,
            error: null,
            diffContent: 'diff --git a/src/a.txt b/src/a.txt\n@@ -1 +1 @@\n-old\n+new\n',
            fileContent: { content: 'new', isBinary: false },
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

        await act(async () => {});

        let toolbar = screen.findAllByType(FilePageHeader)[0];
        await act(async () => {
            toolbar?.props.menuActions.find((action: { id: string }) => action.id === 'selectLines')?.onSelect();
        });

        let contentPanel = screen.findAllByType('FileContentPanel')[0];
        await act(async () => {
            contentPanel?.props.onToggleLine('additions:1');
        });

        toolbar = screen.findAllByType(FilePageHeader)[0];
        await act(async () => {
            toolbar?.props.onStartRangeSelection();
        });

        expect(screen.findAllByType('FileContentPanel')[0]?.props.rangeSelectionActive).toBe(true);

        toolbar = screen.findAllByType(FilePageHeader)[0];
        await act(async () => {
            await toolbar?.props.onApplySelectedLines();
        });

        expect(screen.findAllByType('FileContentPanel')[0]?.props.rangeSelectionActive).toBe(false);
        expect(screen.findAllByType(FilePageHeader)[0]?.props.lineSelectionActive).toBe(false);

        toolbar = screen.findAllByType(FilePageHeader)[0];
        await act(async () => {
            toolbar?.props.menuActions.find((action: { id: string }) => action.id === 'selectLines')?.onSelect();
        });
        toolbar = screen.findAllByType(FilePageHeader)[0];
        await act(async () => {
            toolbar?.props.onStartRangeSelection();
        });

        expect(screen.findAllByType('FileContentPanel')[0]?.props.rangeSelectionActive).toBe(true);

        toolbar = screen.findAllByType(FilePageHeader)[0];
        await act(async () => {
            toolbar?.props.onClearSelection();
        });

        expect(screen.findAllByType('FileContentPanel')[0]?.props.rangeSelectionActive).toBe(false);
        expect(screen.findAllByType(FilePageHeader)[0]?.props.lineSelectionActive).toBe(false);
    });

    it('shows applied partial commit selection when reopening file details', async () => {
        canUseLineSelectionMock.mockReturnValue(true);
        workspaceCommitSelectionPatches = [{
            path: 'src/a.txt',
            patch: [
                'diff --git a/src/a.txt b/src/a.txt',
                '--- a/src/a.txt',
                '+++ b/src/a.txt',
                '@@ -1 +1 @@',
                '-old',
                '+new',
                '',
            ].join('\n'),
        }];
        refreshSpy.mockResolvedValueOnce({
            status: 'ready' as const,
            error: null,
            diffContent: 'diff --git a/src/a.txt b/src/a.txt\n@@ -1 +1 @@\n-old\n+new\n',
            fileContent: { content: 'new', isBinary: false },
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

        await act(async () => {});

        const toolbar = screen.findAllByType(FilePageHeader)[0];
        const contentPanel = screen.findAllByType('FileContentPanel')[0];
        expect(toolbar?.props.lineSelectionActive).toBe(false);
        expect(toolbar?.props.selectedLineCount).toBe(0);
        expect(contentPanel?.props.selectedLineKeys.size).toBe(2);
        expect(contentPanel?.props.lineSelectionEnabled).toBe(false);
        expect(contentPanel?.props.selectedLineKeys).toEqual(new Set(['deletions:1', 'additions:1']));
    });

    it('seeds explicit line selection from an applied partial commit selection', async () => {
        // Select lines is a commit-selection write: the ⋯ item exists only with SCM writes on.
        featureEnabledMock.mockImplementation((featureId: string) => featureId === 'scm.writeOperations');
        canUseLineSelectionMock.mockReturnValue(true);
        workspaceCommitSelectionPatches = [{
            path: 'src/a.txt',
            patch: [
                'diff --git a/src/a.txt b/src/a.txt',
                '--- a/src/a.txt',
                '+++ b/src/a.txt',
                '@@ -1 +1 @@',
                '-old',
                '+new',
                '',
            ].join('\n'),
        }];
        refreshSpy.mockResolvedValueOnce({
            status: 'ready' as const,
            error: null,
            diffContent: 'diff --git a/src/a.txt b/src/a.txt\n@@ -1 +1 @@\n-old\n+new\n',
            fileContent: { content: 'new', isBinary: false },
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

        await act(async () => {});

        let toolbar = screen.findAllByType(FilePageHeader)[0];
        await act(async () => {
            toolbar?.props.menuActions.find((action: { id: string }) => action.id === 'selectLines')?.onSelect();
        });

        toolbar = screen.findAllByType(FilePageHeader)[0];
        const contentPanel = screen.findAllByType('FileContentPanel')[0];
        expect(toolbar?.props.lineSelectionActive).toBe(true);
        expect(toolbar?.props.selectedLineCount).toBe(2);
        expect(contentPanel?.props.lineSelectionEnabled).toBe(true);
        expect(contentPanel?.props.selectedLineKeys).toEqual(new Set(['deletions:1', 'additions:1']));
    });

    it('keeps explicit line selection active when applying selected lines fails', async () => {
        // Select lines is a commit-selection write: the ⋯ item exists only with SCM writes on.
        featureEnabledMock.mockImplementation((featureId: string) => featureId === 'scm.writeOperations');
        canUseLineSelectionMock.mockReturnValue(true);
        workspaceStageActionsMock.applySelectedLines.mockResolvedValueOnce(false);
        workspaceCommitSelectionPatches = [{
            path: 'src/a.txt',
            patch: [
                'diff --git a/src/a.txt b/src/a.txt',
                '--- a/src/a.txt',
                '+++ b/src/a.txt',
                '@@ -1 +1 @@',
                '-old',
                '+new',
                '',
            ].join('\n'),
        }];
        refreshSpy.mockResolvedValueOnce({
            status: 'ready' as const,
            error: null,
            diffContent: 'diff --git a/src/a.txt b/src/a.txt\n@@ -1 +1 @@\n-old\n+new\n',
            fileContent: { content: 'new', isBinary: false },
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

        await act(async () => {});

        let toolbar = screen.findAllByType(FilePageHeader)[0];
        await act(async () => {
            toolbar?.props.menuActions.find((action: { id: string }) => action.id === 'selectLines')?.onSelect();
        });

        toolbar = screen.findAllByType(FilePageHeader)[0];
        expect(toolbar?.props.lineSelectionActive).toBe(true);

        await act(async () => {
            await toolbar?.props.onApplySelectedLines();
        });

        toolbar = screen.findAllByType(FilePageHeader)[0];
        expect(workspaceStageActionsMock.applySelectedLines).toHaveBeenCalledTimes(1);
        expect(toolbar?.props.lineSelectionActive).toBe(true);
    });

    it('defaults markdown files to markdown view when the diff is not renderable', async () => {
        fileLanguageMock.mockReturnValue('markdown');
        refreshSpy.mockResolvedValueOnce({
            status: 'ready' as const,
            error: null,
            diffContent: 'No changes',
            fileContent: { content: '# Title', isBinary: false },
            fileWriteSupported: true,
        } as any);

        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');

        const screen = await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/repo"
                scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/repo' }}
                filePath="README.md"
                sessionIdForAugmentation={null}
            />,
        );

        await act(async () => {});

        const toolbar = screen.findAllByType(FilePageHeader)[0];
        expect(toolbar?.props.displayMode).toBe('markdown');
    });

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

    it('refreshes file details when the SCM snapshot refreshes with the same file fingerprint', async () => {
        let call = 0;
        refreshSpy.mockImplementation(async (_input: any) => {
            call += 1;
            return {
                status: 'ready' as const,
                error: null,
                diffContent: call === 1 ? 'diff-1' : 'diff-2',
                fileContent: { content: 'hello', isBinary: false },
                fileWriteSupported: true,
            };
        });

        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');

        const screen = await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/repo"
                scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/repo' }}
                filePath="src/a.txt"
                sessionIdForAugmentation={null}
            />,
        );
        await act(async () => {});

        expect(screen.findAllByType('FileContentPanel')[0]?.props.diffContent).toBe('diff-1');
        expect(screen.root.findAllByType('View').some((view) => (
            view.props.style?.position === 'relative'
            && view.props.style?.flex === 1
            && view.props.style?.minHeight === 0
        ))).toBe(true);

        workspaceSnapshot = {
            ...workspaceSnapshot,
            fetchedAt: 2,
        };

        await act(async () => {
            await screen.update(
                <WorkspaceFileDetailsView
                    scopeId="workspace:srv1:m1:/repo"
                    scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/repo' }}
                    filePath="src/a.txt"
                    sessionIdForAugmentation={null}
                />,
            );
        });
        await act(async () => {});

        expect(screen.findAllByType('FileContentPanel')[0]?.props.diffContent).toBe('diff-2');
    });

    it('does not switch away from file mode while the file editor is active during an SCM refresh', async () => {
        fileEditorState.editorSurfaceEnabled = true;
        fileEditorState.isEditingFile = false;
        fileEditorState.editorSeedText = 'draft';
        let call = 0;
        refreshSpy.mockImplementation(async (_input: any) => {
            call += 1;
            return {
                status: 'ready' as const,
                error: null,
                diffContent: call === 1 ? 'diff-1' : 'diff-2',
                fileContent: { content: 'hello', isBinary: false },
                fileWriteSupported: true,
            };
        });

        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');

        const screen = await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/repo"
                scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/repo' }}
                filePath="src/a.txt"
                sessionIdForAugmentation={null}
            />,
        );
        await act(async () => {
            screen.findByType(FilePageHeader).props?.onDisplayMode?.('file');
        });
        fileEditorState.isEditingFile = true;
        await act(async () => {
            await screen.update(
                <WorkspaceFileDetailsView
                    scopeId="workspace:srv1:m1:/repo"
                    scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/repo' }}
                    filePath="src/a.txt"
                    sessionIdForAugmentation={null}
                />,
            );
        });
        expect(screen.findAllByType('FileEditorPanel')).toHaveLength(1);

        workspaceSnapshot = {
            ...workspaceSnapshot,
            fetchedAt: 2,
        };

        await act(async () => {
            await screen.update(
                <WorkspaceFileDetailsView
                    scopeId="workspace:srv1:m1:/repo"
                    scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/repo' }}
                    filePath="src/a.txt"
                    sessionIdForAugmentation={null}
                />,
            );
        });
        await act(async () => {});

        expect(screen.findAllByType('FileEditorPanel')).toHaveLength(1);
    });

    it('keeps the toolbar edit callback stable across unchanged file-detail rerenders', async () => {
        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
        const onStartEditingFile = vi.fn();

        const screen = await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/repo"
                scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/repo' }}
                filePath="src/a.txt"
                sessionIdForAugmentation={null}
                onStartEditingFile={onStartEditingFile}
            />,
        );
        await act(async () => {});

        const firstCallback = screen.findByType(FilePageHeader).props?.onStartEditingFile;
        expect(typeof firstCallback).toBe('function');

        await act(async () => {
            await screen.update(
                <WorkspaceFileDetailsView
                    scopeId="workspace:srv1:m1:/repo"
                    scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/repo' }}
                    filePath="src/a.txt"
                    sessionIdForAugmentation={null}
                    onStartEditingFile={onStartEditingFile}
                />,
            );
        });
        await act(async () => {});

        expect(screen.findByType(FilePageHeader).props?.onStartEditingFile).toBe(firstCallback);
    });

    it('keeps the selected-line apply callback stable across unchanged file-detail rerenders', async () => {
        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');

        const screen = await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/repo"
                scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/repo' }}
                filePath="src/a.txt"
                sessionIdForAugmentation={null}
            />,
        );
        await act(async () => {});

        const firstCallback = screen.findByType(FilePageHeader).props?.onApplySelectedLines;
        expect(typeof firstCallback).toBe('function');

        await act(async () => {
            await screen.update(
                <WorkspaceFileDetailsView
                    scopeId="workspace:srv1:m1:/repo"
                    scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/repo' }}
                    filePath="src/a.txt"
                    sessionIdForAugmentation={null}
                />,
            );
        });
        await act(async () => {});

        expect(screen.findByType(FilePageHeader).props?.onApplySelectedLines).toBe(firstCallback);
    });

    it('renders a workspace-scoped download action when preview is too large (no sessionId required)', async () => {
        const { t } = await import('@/text');
        refreshSpy.mockResolvedValueOnce({
            status: 'ready' as const,
            error: t('files.fileTooLargeToPreview'),
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
                // A modified file opens in Changes, where the body is the diff; the too-large body is View's.
                initialView={{ view: 'view' }}
            />,
        );

        await act(async () => {});

        expect(screen.findAllByType('FileErrorState')).toHaveLength(0);
        expect(screen.findAllByType(FilePageHeader)).toHaveLength(1);
        // One cause, one place: no second banner; Download stays reachable without a Session.
        expect(screen.findAllHostsByTestId('file-preview-unavailable-banner')).toHaveLength(0);
        expect(screen.findAllByType(FilePageHeader)[0]?.props.menuActions.map((action: { id: string }) => action.id)).toContain('download');
    });

    it('discards the whole file through the comparison arm in View, with one Discard item and no HEAD arm', async () => {
        machineScmChangeDiscardMock.mockClear();
        refreshSpy.mockResolvedValueOnce({
            status: 'ready' as const,
            error: null,
            diffContent: 'diff --git a/src/a.txt b/src/a.txt\n@@ -1 +1 @@\n-old\n+new\n',
            fileContent: { content: 'new', isBinary: false, contentHash: 'a'.repeat(64) },
            fileWriteSupported: true,
        } as any);
        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
        const screen = await renderScreen(
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/repo"
                scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/repo' }}
                filePath="src/a.txt"
                sessionIdForAugmentation={null}
                initialView={{ view: 'view' }}
            />,
        );
        await act(async () => {});
        const header = screen.findAllByType(FilePageHeader)[0];
        expect(header?.props.displayMode).not.toBe('diff');
        const discards = header?.props.menuActions.filter((action: { id: string }) => action.id === 'discard') ?? [];
        expect(discards).toHaveLength(1);
        await act(async () => { await discards[0].onSelect(); });
        expect(machineScmChangeDiscardMock).toHaveBeenCalledTimes(1);
        const request = machineScmChangeDiscardMock.mock.calls[0]?.[1] as { entries: unknown[] };
        expect(request.entries).toEqual([expect.objectContaining({
            kind: 'comparison', path: 'src/a.txt', against: { source: { kind: 'workingTree' } }, expectedHash: 'a'.repeat(64),
        })]);
    });
    it('keeps the header props stable when the page re-renders with unchanged facts', async () => {
        // One open re-renders this page about twenty times (store, pane and parent commits); the header is
        // expensive, so a render that changes no header fact must hand it identical props and let it bail out.
        refreshSpy.mockResolvedValue({
            status: 'ready' as const,
            error: null,
            diffContent: 'diff --git a/src/a.txt b/src/a.txt\n@@ -1 +1 @@\n-old\n+new\n',
            fileContent: { content: 'new', isBinary: false },
            fileWriteSupported: true,
        } as any);
        const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
        // The parent memoizes its scope; only handler props are fresh closures on each parent render.
        const scope = { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' };
        const element = () => (
            <WorkspaceFileDetailsView
                scopeId="workspace:srv1:m1:/repo"
                scope={scope}
                filePath="src/a.txt"
                sessionIdForAugmentation={null}
                onRevealInFilesTree={() => {}}
            />
        );
        const screen = await renderScreen(element());
        await act(async () => {});
        const before = screen.findAllByType(FilePageHeader)[0]!.props as Record<string, unknown>;
        await act(async () => { screen.update(element()); });
        await act(async () => {});
        const after = screen.findAllByType(FilePageHeader)[0]!.props as Record<string, unknown>;
        const changed = Object.keys({ ...before, ...after }).filter(key => !Object.is(before[key], after[key]));
        expect(changed.join(',')).toBe('');
    });
});
