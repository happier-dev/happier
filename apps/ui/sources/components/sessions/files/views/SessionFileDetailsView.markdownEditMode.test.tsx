import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import type { Session, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const markdownSession: Session = createSessionFixture({
    id: 's1',
    active: true,
    metadata: {
        path: '/workspace',
        host: 'tester.local',
        homeDir: '/Users/tester',
        machineId: 'm1',
    } as Session['metadata'],
});

const markdownEntry: ScmWorkingSnapshot['entries'][number] = {
    path: 'README.md',
    kind: 'modified',
    includeStatus: 'unmodified',
    pendingStatus: 'modified',
    hasIncludedDelta: false,
    hasPendingDelta: true,
    previousPath: null,
    stats: {
        pendingAdded: 1,
        pendingRemoved: 0,
        includedAdded: 0,
        includedRemoved: 0,
        isBinary: false,
    },
};

const markdownSnapshot: ScmWorkingSnapshot = {
    projectKey: 'project-1',
    fetchedAt: 1,
    repo: { isRepo: true, rootPath: '/workspace', backendId: 'git', mode: '.git', worktrees: [] },
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false,
    entries: [markdownEntry],
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

installSessionFilesViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: (spec: any) => spec?.default ?? spec?.web },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSession: () => markdownSession,
            useSessionWorkspacePath: () => '/workspace',
            useSessions: () => [],
            useSessionReviewCommentsDrafts: () => [],
            useWorkspaceReviewCommentsDrafts: () => [],
            useSessionProjectScmCommitSelectionPaths: () => [],
            useSessionProjectScmCommitSelectionPatches: () => [],
            useSessionProjectScmInFlightOperation: () => null,
            useSessionProjectScmSnapshot: () => markdownSnapshot,
            useSessionsReady: () => true,
            useSetting: () => null,
            importOriginal,
        });
    },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));

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

vi.mock('@/components/sessions/files/file/FileScreenState', () => ({
    FileLoadingState: (props: any) => React.createElement('FileLoadingState', props),
    FileErrorState: (props: any) => React.createElement('FileErrorState', props),
    FileBinaryState: (props: any) => React.createElement('FileBinaryState', props),
}));

vi.mock('@/hooks/ui/useMountedRef', () => ({ useMountedRef: () => ({ current: true }) }));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        visibility: { top: false, bottom: false, left: false, right: false },
        onViewportLayout: vi.fn(),
        onContentSizeChange: vi.fn(),
        onScroll: vi.fn(),
    }),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({ ScrollEdgeFades: (props: any) => React.createElement('ScrollEdgeFades', props) }));
vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({ ScrollEdgeIndicators: (props: any) => React.createElement('ScrollEdgeIndicators', props) }));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({ scopeState: { details: { tabState: {} } }, setDetailsTabState: vi.fn() }),
}));

const refreshSpy = vi.fn(async (_input?: any) => ({
    status: 'ready' as const,
    error: null,
    diffContent: null,
    fileContent: { content: '# Title\n\nbody', isBinary: false, contentHash: 'h1' },
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

const editorState = {
    editorSurfaceEnabled: true,
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
    editorResetKey: 0,
};

vi.mock('./sessionFileDetails/useSessionFileEditorState', () => ({
    useSessionFileEditorState: () => editorState,
}));

const markdownEditModeState = {
    markdownEditMode: 'rich' as 'raw' | 'rich',
    richEligible: true,
    richDisabledReason: undefined as string | undefined,
    seedText: '# Title\n\nbody',
    resetKey: '0:rich:0',
    onToggle: vi.fn(),
    onUnavailable: vi.fn(),
};

vi.mock('./sessionFileDetails/useMarkdownFileEditMode', () => ({
    useMarkdownFileEditMode: () => markdownEditModeState,
}));

vi.mock('@/components/sessions/reviews/comments/useWorkspaceReviewCommentDraftHandlers', () => ({
    useWorkspaceReviewCommentDraftHandlers: () => ({
        onUpsertReviewCommentDraft: vi.fn(),
        onDeleteReviewCommentDraft: vi.fn(),
        onReviewCommentError: vi.fn(),
    }),
}));

vi.mock('@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting', () => ({
    useCodeLinesSyntaxHighlighting: () => ({ syntaxHighlighting: null }),
}));

const featureState = { markdownRichEditor: true };
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (id: string) => {
        if (id === 'files.editor') return true;
        if (id === 'files.markdownRichEditor') return featureState.markdownRichEditor;
        return false;
    },
}));

vi.mock('@/scm/scmLineSelection', () => ({
    buildFileLineSelectionFingerprint: () => 'fp',
    canUseLineSelection: () => false,
    canStartLineSelection: () => false,
}));

vi.mock('@/scm/settings/commitStrategy', () => ({
    SCM_COMMIT_STRATEGIES: ['atomic', 'git_staging'],
    allowsLiveStaging: () => false,
    isAtomicCommitStrategy: () => true,
}));

vi.mock('@/scm/diff/defaultMode', () => ({ resolveDefaultDiffModeForFile: () => 'pending' }));

vi.mock('@/components/sessions/files/useSessionFileDownloadAvailability', () => ({
    useSessionFileDownloadAvailability: () => false,
}));

beforeEach(() => {
    featureState.markdownRichEditor = true;
    markdownEditModeState.markdownEditMode = 'rich';
    markdownEditModeState.richEligible = true;
    markdownEditModeState.richDisabledReason = undefined;
    editorState.isEditingFile = true;
});

async function mountView(filePath = 'README.md') {
    const { SessionFileDetailsView } = await import('./SessionFileDetailsView');
    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<SessionFileDetailsView sessionId="s1" scopeId="session:s1" filePath={filePath} />)).tree;
    await act(async () => {});
    return tree;
}

describe('SessionFileDetailsView (markdown edit mode)', () => {
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
        expect(toolbar.props.showWrapLinesToggle).toBe(true);
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
