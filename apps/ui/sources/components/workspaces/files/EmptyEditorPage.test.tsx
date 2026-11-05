import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { renderScreen } from '@/dev/testkit';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { SessionCockpitBottomChromeHeightContext } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { ScrollView, StyleSheet } from 'react-native';
import { EmptyEditorPage } from './EmptyEditorPage';

let snapshot: unknown = null;

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key, params) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  });
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } =
    await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
  createPartialStorageModuleMock(importOriginal, {
    useWorkspaceScmSnapshot: () => snapshot,
    useWorkspaceScmTouchedPathsForSession: () => [],
  }),
);

const SCOPE = {
  serverId: 'srv-1',
  machineId: 'machine-1',
  rootPath: '/repo',
} as const;

/** A real snapshot shape: the count is the canonical changed-file list (`selectScmChangedFiles`). */
const STATS = {
  includedAdded: 0,
  includedRemoved: 0,
  pendingAdded: 1,
  pendingRemoved: 0,
  isBinary: false,
};

function changedSnapshot(count: number, extraEntries: readonly unknown[] = []) {
  return {
    repo: {
      isRepo: true,
      rootPath: '/repo',
      backendId: 'git',
      mode: '.git',
      worktrees: [],
    },
    capabilities: {},
    branch: {
      head: 'main',
      upstream: null,
      ahead: 0,
      behind: 0,
      detached: false,
    },
    totals: {
      includedFiles: 0,
      pendingFiles: count,
      untrackedFiles: 0,
      includedAdded: 0,
      includedRemoved: 0,
      pendingAdded: count,
      pendingRemoved: 0,
    },
    entries: [
      ...Array.from({ length: count }, (_unused, index) => ({
        path: `src/file-${index}.ts`,
        previousPath: null,
        kind: 'modified',
        includeStatus: ' ',
        pendingStatus: 'M',
        hasIncludedDelta: false,
        hasPendingDelta: true,
        stats: STATS,
      })),
      ...extraEntries,
    ],
  };
}

/** The files search is the app's runtime boundary for Open file…; record what it was asked to open. */
function withSearch(
  element: React.ReactElement,
  open: (...args: unknown[]) => void,
) {
  return (
    <UniversalSearchRuntimeProvider value={{ open, buildCommands: () => [] }}>
      {element}
    </UniversalSearchRuntimeProvider>
  );
}

async function renderPage(
  input: Readonly<{
    sessionId?: string;
    onReview?: () => void;
    open?: (...args: unknown[]) => void;
  }>,
) {
  return renderScreen(
    withSearch(
      <EmptyEditorPage
        scope={SCOPE}
        sessionId={input.sessionId}
        title="title"
        reason="reason"
        changedTitle="changed"
        onOpenFile={vi.fn()}
        onReview={input.onReview}
      />,
      input.open ?? vi.fn(),
    ),
  );
}

describe('EmptyEditorPage (empty editor column, lab EM1)', () => {
  it('keeps the end of the Recent list scrollable above the shell floating chrome', async () => {
    snapshot = changedSnapshot(0);
    const page = <EmptyEditorPage scope={SCOPE} title="title" reason="reason" changedTitle="changed" onOpenFile={vi.fn()} />;
    const plain = await renderScreen(page);
    const plainInset = StyleSheet.flatten(plain.findAllByType(ScrollView)[0].props.contentContainerStyle).paddingBottom ??
      StyleSheet.flatten(plain.findAllByType(ScrollView)[0].props.contentContainerStyle).paddingVertical;
    await plain.unmount();
    const covered = await renderScreen(<SessionCockpitBottomChromeHeightContext.Provider value={84}>{page}</SessionCockpitBottomChromeHeightContext.Provider>);
    const content = StyleSheet.flatten(covered.findAllByType(ScrollView)[0].props.contentContainerStyle);
    expect(content.paddingBottom).toBe(plainInset + 84);
    await covered.unmount();
  });
  it('opens quick open on this workspace and session from its one primary action', async () => {
    snapshot = changedSnapshot(0);
    const open = vi.fn();
    const screen = await renderPage({ sessionId: 's1', open });
    expect(screen.findByTestId('pane-empty-editor-scene')).not.toBeNull();
    await screen.pressByTestIdAsync('pane-empty-editor-open-file');
    expect(open).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ ...SCOPE, sessionId: 's1' }),
      { source: 'files' },
    );
  });

  it('keeps reading every change one press away and counts them like every changed-files list', async () => {
    snapshot = changedSnapshot(2, [
      {
        path: 'vendor/',
        previousPath: null,
        kind: 'untracked',
        includeStatus: '?',
        pendingStatus: '?',
        hasIncludedDelta: false,
        hasPendingDelta: true,
        stats: STATS,
      },
    ]);
    const onReview = vi.fn();
    const screen = await renderPage({ onReview });
    expect(screen.getTextContent()).toContain(
      'detailsSurface.chrome.reviewChanges:{"count":2}',
    );
    await screen.pressByTestIdAsync('pane-empty-editor-review');
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it('offers no review and lists nothing when nothing changed and nothing was read', async () => {
    snapshot = changedSnapshot(0);
    const screen = await renderPage({ onReview: vi.fn() });
    expect(screen.findByTestId('pane-empty-editor-review')).toBeNull();
    expect(screen.findByTestId('pane-empty-editor-changed')).toBeNull();
    expect(screen.findByTestId('pane-empty-editor-recent')).toBeNull();
  });
});
