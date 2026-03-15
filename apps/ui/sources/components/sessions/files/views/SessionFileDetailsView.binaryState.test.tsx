import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
}));

vi.mock('react-native-unistyles', () => ({
  __esModule: true,
  useUnistyles: () => ({
    theme: {
      dark: true,
      colors: {
        text: '#fff',
        textSecondary: '#bbb',
        surface: '#000',
        surfaceHigh: '#111',
        divider: '#222',
      },
    },
  }),
  StyleSheet: { create: (value: any) => (typeof value === 'function' ? value({ colors: { divider: '#222', surface: '#000' } }) : value) },
}));

vi.mock('@/components/ui/layout/layout', () => ({
  layout: { maxWidth: 1024 },
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

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
    editorText: '',
    setEditorText: vi.fn(),
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
  allowsLiveStaging: () => false,
  isAtomicCommitStrategy: () => true,
}));

vi.mock('@/scm/diff/defaultMode', () => ({
  resolveDefaultDiffModeForFile: () => 'pending',
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useSession: () => ({ active: true, metadata: { path: '/workspace', machineId: 'm1' } }),
  useProjectForSession: () => ({ key: { machineId: 'm1', path: '/workspace' } }),
  useSessions: () => [],
  useSessionReviewCommentsDrafts: () => [],
  useSessionProjectScmCommitSelectionPaths: () => [],
  useSessionProjectScmCommitSelectionPatches: () => [],
  useSessionProjectScmInFlightOperation: () => null,
  useSessionProjectScmSnapshot: () => ({
    repo: { isRepo: true },
    entries: [
      {
        path: 'bin.dat',
        kind: 'modified',
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
      },
    ],
    capabilities: { writeDiscard: true },
  }),
  useSetting: () => null,
}));

describe('SessionFileDetailsView (binary)', () => {
  it('renders header actions even when file content is binary', async () => {
    const { SessionFileDetailsView } = await import('./SessionFileDetailsView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionFileDetailsView sessionId="s1" scopeId="session:s1" filePath="bin.dat" />);
    });

    // Flush the refresh effect.
    await act(async () => {});

    expect(refreshSpy).toHaveBeenCalled();
    expect(tree.root.findAllByType('FileHeader' as any).length).toBe(1);
    expect(tree.root.findAllByType('ScmChangeDiscardButton' as any).length).toBe(1);
    expect(tree.root.findAllByType('FileBinaryState' as any).length).toBe(1);
  });
});
