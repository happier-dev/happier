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
        success: '#0f0',
        warning: '#f90',
        textLink: '#09f',
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

vi.mock('@/components/sessions/sourceControl/changes/ScmChangeDiscardButton', () => ({
  ScmChangeDiscardButton: (props: any) => React.createElement('ScmChangeDiscardButton', props),
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

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => true,
}));

vi.mock('@/components/sessions/reviews/comments/useSessionReviewCommentDraftHandlers', () => ({
  useSessionReviewCommentDraftHandlers: () => ({
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
}));

vi.mock('@/hooks/session/files/useFileScmStageActions', () => ({
  useFileScmStageActions: () => ({
    isApplyingStage: false,
    handleStage: vi.fn(),
    applySelectedLines: vi.fn(),
  }),
}));

vi.mock('./sessionFileDetails/useSessionFileEditorState', () => ({
  useSessionFileEditorState: () => ({
    editorSurfaceEnabled: false,
    isEditingFile: false,
    editorResetKey: 0,
    editorText: '',
    setEditorText: vi.fn(),
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

vi.mock('./sessionFileDetails/refreshSessionFileDetails', () => ({
  refreshSessionFileDetails: (input: any) => refreshSpy(input),
}));

let scmSnapshot: any = null;

vi.mock('@/sync/domains/state/storage', () => ({
  useSession: () => ({ active: true, metadata: { path: '/workspace', machineId: 'm1' } }),
  useProjectForSession: () => ({ key: { machineId: 'm1', path: '/workspace' } }),
  useSessions: () => [],
  useSessionReviewCommentsDrafts: () => [],
  useSessionProjectScmCommitSelectionPaths: () => [],
  useSessionProjectScmCommitSelectionPatches: () => [],
  useSessionProjectScmInFlightOperation: () => null,
  useSessionProjectScmSnapshot: () => scmSnapshot,
  useSetting: () => null,
}));

describe('SessionFileDetailsView (SCM refresh)', () => {
  it('refreshes diff content in-place when SCM entry fingerprint changes', async () => {
    const { SessionFileDetailsView } = await import('./SessionFileDetailsView');

    scmSnapshot = {
      repo: { isRepo: true },
      entries: [
        {
          path: 'src/a.txt',
          kind: 'modified',
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
        },
      ],
      capabilities: { writeDiscard: true, writeCommitPathSelection: true, writeCommitLineSelection: true },
      hasConflicts: false,
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionFileDetailsView sessionId="s1" scopeId="session:s1" filePath="src/a.txt" />);
    });
    await act(async () => {});

    const panels = tree.root.findAllByType('FileContentPanel' as any);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.props.diffContent).toBe('diff-1');

    // Simulate a snapshot update that should change the selection fingerprint (e.g., commit applied).
    scmSnapshot = {
      ...scmSnapshot,
      entries: [
        {
          ...scmSnapshot.entries[0],
          stats: {
            ...scmSnapshot.entries[0].stats,
            pendingAdded: 0,
          },
        },
      ],
    };

    await act(async () => {
      tree.update(<SessionFileDetailsView sessionId="s1" scopeId="session:s1" filePath="src/a.txt" />);
    });
    await act(async () => {});

    const panelsAfter = tree.root.findAllByType('FileContentPanel' as any);
    expect(panelsAfter).toHaveLength(1);
    expect(panelsAfter[0]!.props.diffContent).toBe('diff-2');

    // Regression: background refresh should not return to the initial loading skeleton.
    expect(tree.root.findAllByType('FileLoadingState' as any)).toHaveLength(0);
  });
});
