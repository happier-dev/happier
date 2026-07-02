import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { installWorkspaceFileDetailsCommonModuleMocks } from './workspaceFileDetails/workspaceFileDetailsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

installWorkspaceFileDetailsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: (spec: any) => spec?.default ?? spec?.web },
        });
    },
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));

const fileActionToolbarProps = vi.hoisted(() => ({ current: null as any }));
vi.mock('@/components/workspaces/files/file/FileActionToolbar', () => ({
    FileActionToolbar: (props: any) => {
        fileActionToolbarProps.current = props;
        return React.createElement('FileActionToolbar', props, props.rightElement ?? null);
    },
}));

vi.mock('@/components/workspaces/files/file/FileContentPanel', () => ({
    FileContentPanel: (props: any) => React.createElement('FileContentPanel', props),
}));

vi.mock('@/components/workspaces/files/file/editor/FileEditorPanel', () => ({
    FileEditorPanel: (props: any) => React.createElement('FileEditorPanel', props),
}));

vi.mock('@/components/ui/markdown/editor/RichMarkdownEditorPanel', () => ({
    RichMarkdownEditorPanel: (props: any) => React.createElement('RichMarkdownEditorPanel', props),
}));

vi.mock('@/components/workspaces/files/file/FileScreenState', () => ({
    FileLoadingState: (props: any) => React.createElement('FileLoadingState', props),
    FileErrorState: (props: any) => React.createElement('FileErrorState', props),
    FileBinaryState: (props: any) => React.createElement('FileBinaryState', props),
}));

vi.mock('@/components/workspaces/files/details/sessionAugmentation/WorkspaceAugmentedScmChangeDiscardButton', () => ({
    WorkspaceAugmentedScmChangeDiscardButton: (props: any) => React.createElement('ScmChangeDiscardButton', props),
}));

vi.mock('@/components/workspaces/files/file/WorkspaceFileDownloadButton', () => ({
    WorkspaceFileDownloadButton: (props: any) => React.createElement('WorkspaceFileDownloadButton', props),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({ scopeState: { details: { tabState: {} } }, setDetailsTabState: vi.fn() }),
}));

const featureState = vi.hoisted(() => ({ markdownRichEditor: true }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (id: string) => {
        if (id === 'files.editor') return true;
        if (id === 'files.markdownRichEditor') return featureState.markdownRichEditor;
        return false;
    },
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

vi.mock('@/scm/settings/commitStrategy', () => ({
    SCM_COMMIT_STRATEGIES: ['atomic', 'git_staging'],
    allowsLiveStaging: () => false,
    isAtomicCommitStrategy: () => true,
}));

vi.mock('@/scm/diff/defaultMode', () => ({ resolveDefaultDiffModeForFile: () => 'pending' }));

vi.mock('@/scm/scmLineSelection', () => ({
    buildFileLineSelectionFingerprint: () => 'fp',
    canUseLineSelection: () => false,
    canStartLineSelection: () => false,
}));

vi.mock('@/hooks/session/files/useFileScmStageActions', () => ({
    useFileScmStageActions: () => ({
        isApplyingStage: false,
        handleStage: vi.fn(),
        applySelectedLines: vi.fn(async () => true),
    }),
}));

vi.mock('@/hooks/workspaces/scm/useWorkspaceFileScmStageActions', () => ({
    useWorkspaceFileScmStageActions: () => ({
        isApplyingStage: false,
        handleStage: vi.fn(),
        applySelectedLines: vi.fn(async () => true),
    }),
}));

const editorState = vi.hoisted(() => ({
    editorSurfaceEnabled: true,
    editorResetKey: 0,
    editorOriginalText: '# Title\n\nbody',
    editorSeedText: '# Title\n\nbody',
    editorHandleRef: { current: null },
    onEditorChange: vi.fn(),
    getEditorText: () => '# Title\n\nbody',
    editorDirty: false,
    editorTooLarge: false,
    editorChunkTooLarge: false,
    isEditingFile: true,
    isSavingEdits: false,
    fileChangedExternally: false,
    startEditingFile: vi.fn(),
    cancelEditingFile: vi.fn(),
    saveFileEdits: vi.fn(),
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState', () => ({
    useWorkspaceFileEditorState: () => editorState,
}));

const markdownEditModeState = vi.hoisted(() => ({
    markdownEditMode: 'rich' as 'raw' | 'rich',
    richEligible: true,
    richDisabledReason: undefined as string | undefined,
    seedText: '# Title\n\nbody',
    resetKey: '0:rich:0',
    onToggle: vi.fn(),
    onUnavailable: vi.fn(),
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/useMarkdownFileEditMode', () => ({
    useMarkdownFileEditMode: () => markdownEditModeState,
}));

const refreshSpy = vi.fn(async (_input?: any) => ({
    status: 'ready' as const,
    error: null,
    diffContent: null,
    fileContent: { content: '# Title\n\nbody', isBinary: false, contentHash: 'h1' },
    fileWriteSupported: true,
}));

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/refreshWorkspaceFileDetails', () => ({
    refreshWorkspaceFileDetails: (input: any) => refreshSpy(input),
}));

const workspaceSnapshot: ScmWorkingSnapshot = {
    projectKey: 'workspace:srv1:m1:/workspace',
    fetchedAt: 1,
    repo: { isRepo: true, rootPath: '/workspace', backendId: 'git', mode: '.git', worktrees: [] },
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false,
    entries: [{
        path: 'README.md',
        kind: 'modified',
        includeStatus: 'unmodified',
        pendingStatus: 'modified',
        hasIncludedDelta: false,
        hasPendingDelta: true,
        previousPath: null,
        stats: { pendingAdded: 1, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: false },
    }],
    totals: {
        includedFiles: 0,
        pendingFiles: 1,
        untrackedFiles: 0,
        includedAdded: 0,
        includedRemoved: 0,
        pendingAdded: 1,
        pendingRemoved: 0,
    },
    capabilities: {} as ScmWorkingSnapshot['capabilities'],
};

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSession: () => null,
        useProjectForSession: () => null,
        useSetting: () => null,
        useWorkspaceScmSnapshot: () => workspaceSnapshot,
        useWorkspaceScmCommitSelectionPaths: () => [],
        useWorkspaceScmCommitSelectionPatches: () => [],
        useWorkspaceScmInFlightOperation: () => null,
        useWorkspaceReviewCommentsDrafts: () => [],
        importOriginal,
    });
});

beforeEach(() => {
    featureState.markdownRichEditor = true;
    markdownEditModeState.markdownEditMode = 'rich';
    markdownEditModeState.richEligible = true;
    markdownEditModeState.richDisabledReason = undefined;
    editorState.isEditingFile = true;
});

async function mountView(filePath = 'README.md') {
    const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
    const screen = await renderScreen(
        <WorkspaceFileDetailsView
            scopeId="workspace:srv1:m1:/workspace"
            scope={{ serverId: 'srv1', machineId: 'm1', rootPath: '/workspace' }}
            filePath={filePath}
            sessionIdForAugmentation={null}
        />,
    );
    await act(async () => {});
    return screen.tree;
}

describe('WorkspaceFileDetailsView (markdown edit mode)', () => {
    it('renders the RichMarkdownEditorPanel when mode is rich and the file is eligible', async () => {
        const tree = await mountView();
        expect(tree.findAllByType('RichMarkdownEditorPanel' as any).length).toBe(1);
        expect(tree.findAllByType('FileEditorPanel' as any).length).toBe(0);
    });

    it('seeds the rich panel from the hook seedText and resetKey', async () => {
        const tree = await mountView();
        const panel = tree.findByType('RichMarkdownEditorPanel' as any);
        expect(panel.props.value).toBe('# Title\n\nbody');
        expect(panel.props.resetKey).toBe('0:rich:0');
    });

    it('renders the raw FileEditorPanel when mode is raw', async () => {
        markdownEditModeState.markdownEditMode = 'raw';
        const tree = await mountView();
        expect(tree.findAllByType('FileEditorPanel' as any).length).toBe(1);
        expect(tree.findAllByType('RichMarkdownEditorPanel' as any).length).toBe(0);
    });

    it('renders the raw FileEditorPanel when mode is rich but the file is ineligible', async () => {
        markdownEditModeState.richEligible = false;
        markdownEditModeState.richDisabledReason = 'footnotes';
        const tree = await mountView();
        expect(tree.findAllByType('FileEditorPanel' as any).length).toBe(1);
        expect(tree.findAllByType('RichMarkdownEditorPanel' as any).length).toBe(0);
    });

    it('passes the markdown toggle props to the FileActionToolbar', async () => {
        const tree = await mountView();
        const toolbar = tree.findByType('FileActionToolbar' as any);
        expect(toolbar.props.showMarkdownEditToggle).toBe(true);
        expect(toolbar.props.markdownEditMode).toBe('rich');
        expect(typeof toolbar.props.onMarkdownEditMode).toBe('function');
    });

    it('does not offer the markdown toggle when the rich editor feature is disabled', async () => {
        // When the flag is off the hook reports ineligible; the view must not show
        // the toggle and must fall back to the raw editor.
        featureState.markdownRichEditor = false;
        markdownEditModeState.richEligible = false;
        markdownEditModeState.markdownEditMode = 'rich';
        const tree = await mountView();
        const toolbar = tree.findByType('FileActionToolbar' as any);
        expect(toolbar.props.showMarkdownEditToggle).toBe(false);
        expect(tree.findAllByType('FileEditorPanel' as any).length).toBe(1);
        expect(tree.findAllByType('RichMarkdownEditorPanel' as any).length).toBe(0);
    });

    it('passes the authoritative richEligible to the FileActionToolbar (N2)', async () => {
        markdownEditModeState.richEligible = true;
        const tree = await mountView();
        const toolbar = tree.findByType('FileActionToolbar' as any);
        expect(toolbar.props.markdownRichEligible).toBe(true);
    });

    it('does not show the toggle and stays raw for an editable .mdx file (S3 / R-A1)', async () => {
        // `.mdx` is raw/preview-only in Phase 1: even with the feature on and the
        // hook reporting rich, the view must not surface the toggle and must
        // render the raw editor.
        markdownEditModeState.markdownEditMode = 'rich';
        markdownEditModeState.richEligible = true;
        const tree = await mountView('GUIDE.mdx');
        const toolbar = tree.findByType('FileActionToolbar' as any);
        expect(toolbar.props.showMarkdownEditToggle).toBe(false);
        expect(tree.findAllByType('FileEditorPanel' as any).length).toBe(1);
        expect(tree.findAllByType('RichMarkdownEditorPanel' as any).length).toBe(0);
    });
});
