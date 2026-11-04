import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';

// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: {
      OS: 'web',
      select: ({ web, default: value }: { web?: number; default: number }) =>
        web ?? value,
    },
    View: 'View',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
  });
});

vi.mock('@/components/ui/text/Text', () => ({
  Text: 'Text',
  TextInput: 'TextInput',
}));

vi.mock('@/components/ui/code/WrapLinesToggleButton', () => ({
  WrapLinesToggleButton: 'WrapLinesToggleButton',
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
  Octicons: 'Octicons',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', async () => {
  const React = await import('react');
  return {
    DropdownMenu: (props: any) =>
      React.createElement(
        'DropdownMenu',
        props,
        typeof props.trigger === 'function'
          ? props.trigger({
              open: Boolean(props.open),
              toggle: vi.fn(),
              openMenu: vi.fn(),
              closeMenu: vi.fn(),
              selectedItem:
                props.items?.find(
                  (item: any) => item.id === props.selectedId,
                ) ?? null,
            })
          : props.trigger,
      ),
  };
});

vi.mock('@/components/ui/scroll/ScrollEdgeFades', async () => {
  const React = await import('react');
  return {
    ScrollEdgeFades: (props: any) =>
      React.createElement('ScrollEdgeFades', props),
  };
});

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', async () => {
  const React = await import('react');
  return {
    ScrollEdgeIndicators: (props: any) =>
      React.createElement('ScrollEdgeIndicators', props),
  };
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

function flattenToolbarStyle(style: any): Record<string, any> {
  if (!style) return {};
  if (Array.isArray(style))
    return style.reduce(
      (acc, entry) => Object.assign(acc, flattenToolbarStyle(entry)),
      {},
    );
  return typeof style === 'object' ? style : {};
}

function menuItemIds(
  screen: Awaited<ReturnType<typeof renderScreen>>,
): string[] {
  const menu = screen
    .findAllByType('DropdownMenu' as never)
    .find((node: any) => node.props.testID === 'file-details-header.menu');
  return menu
    ? (menu as any).props.items.map((item: { id: string }) => item.id)
    : [];
}

async function selectMenuItem(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  id: string,
) {
  const menu = screen
    .findAllByType('DropdownMenu' as never)
    .find((node: any) => node.props.testID === 'file-details-header.menu');
  await act(async () => {
    await (menu as any)?.props.onSelect(id);
  });
}

// The real toolbar graph is shared by every case. Load it during collection so a
// cold transform cannot outlive a case's act() scope and corrupt later renders.
await import('./FilePageHeader');

describe('FilePageHeader', () => {
  const theme = createThemeFixture({
    colors: {
      border: { default: '#ddd' },
      input: { background: '#f2f2f2' },
      state: {
        neutral: { foreground: '#666' },
        success: { foreground: '#34C759' },
        warning: { foreground: '#FF9500' },
      },
      surface: { base: '#fff', inset: '#f6f6f6' },
      text: { primary: '#111', secondary: '#666', link: '#007AFF' },
    },
  });

  it('shows Stage file for untracked files even when hasPendingDelta is false', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');
    const onStageFile = vi.fn();

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        theme,
        displayMode: 'diff',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: false,
        hasIncludedDelta: false,
        scmWriteEnabled: true,
        includeExcludeEnabled: true,
        lineSelectionEnabled: false,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile,
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
        isUntrackedFile: true,
      }),
    );

    expect(screen.findByTestId('file-details-stage-file')).toBeTruthy();
    const stageFileButton = screen.findHostByTestId('file-details-stage-file');
    expect(stageFileButton?.props.role).toBe('button');
    expect(stageFileButton?.props.accessibilityLabel).toBe(
      'files.fileActions.stageFile',
    );
    await screen.pressByTestIdAsync('file-details-stage-file');
    expect(onStageFile).toHaveBeenCalledOnce();
  });

  it('hides include/exclude controls when backend does not support them', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        theme,
        displayMode: 'diff',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: true,
        hasIncludedDelta: false,
        scmWriteEnabled: true,
        includeExcludeEnabled: false,
        lineSelectionEnabled: false,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
        isUntrackedFile: false,
      }),
    );

    expect(screen.findByTestId('file-details-stage-file')).toBeNull();
    expect(screen.findByTestId('file-details-unstage-file')).toBeNull();
  });

  it('keeps Stage file action enabled when conflicts are present', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        theme,
        displayMode: 'diff',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: true,
        hasIncludedDelta: false,
        scmWriteEnabled: true,
        includeExcludeEnabled: true,
        lineSelectionEnabled: false,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
        isUntrackedFile: false,
      }),
    );

    expect(
      screen.findByTestId('file-details-stage-file')?.props.accessibilityState
        ?.disabled,
    ).toBe(false);
  });

  it('shows only the remove action when a file is already selected for commit', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        theme,
        displayMode: 'diff',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: true,
        hasIncludedDelta: false,
        scmWriteEnabled: true,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: true,
        isSelectedForCommit: true,
        lineSelectionEnabled: false,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
        isUntrackedFile: false,
      }),
    );

    expect(screen.findByTestId('file-details-stage-file')).toBeNull();
    expect(screen.findByTestId('file-details-unstage-file')).toBeTruthy();
    expect(
      screen.findByTestId('file-details-unstage-file')?.props
        .accessibilityLabel,
    ).toBe('files.fileActions.removeFromCommitSelection');
  });

  it('replaces the file selection action with one compact line-selection action when lines are selected', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');
    const onApplySelectedLines = vi.fn();
    const onClearSelection = vi.fn();

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        theme,
        displayMode: 'diff',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: true,
        hasIncludedDelta: false,
        scmWriteEnabled: true,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: true,
        isSelectedForCommit: false,
        lineSelectionEnabled: true,
        lineSelectionActive: true,
        selectedLineCount: 2,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines,
        onClearSelection,
        isUntrackedFile: false,
      }),
    );

    expect(screen.findByTestId('file-details-stage-file')).toBeNull();
    expect(screen.findByTestId('file-details-unstage-file')).toBeNull();
    expect(
      screen.findByTestId('file-details-apply-selected-lines'),
    ).toBeTruthy();
    expect(screen.getTextContent()).toContain(
      'files.fileActions.selectedLines.selectLinesForCommit',
    );
    expect(screen.getTextContent()).not.toContain(
      'files.fileActions.clearSelection',
    );

    await screen.pressByTestIdAsync('file-details-apply-selected-lines');
    await screen.pressByTestIdAsync('file-details-clear-selection');

    expect(onApplySelectedLines).toHaveBeenCalledTimes(1);
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    'keeps whole-file selection distinct and lets empty line selection cancel (virtual=%s)',
    async (virtualSelectionEnabled) => {
      const { FilePageHeader } = await import('./FilePageHeader');
      function SelectionHarness() {
        const [active, setActive] = React.useState(false);
        const [included, setIncluded] = React.useState(false);
        return (
          <>
            <FilePageHeader
              displayMode="diff"
              onDisplayMode={() => {}}
              diffMode="pending"
              onDiffMode={() => {}}
              hasPendingDelta
              hasIncludedDelta={included}
              scmWriteEnabled
              includeExcludeEnabled={!virtualSelectionEnabled}
              virtualSelectionEnabled={virtualSelectionEnabled}
              isSelectedForCommit={included}
              lineSelectionEnabled
              lineSelectionActive={active}
              selectedLineCount={0}
              isApplyingStage={false}
              inFlightScmOperation={null}
              onStageFile={() => setIncluded(true)}
              onUnstageFile={() => setIncluded(false)}
              onApplySelectedLines={() => {}}
              onClearSelection={() => setActive(false)}
              menuActions={
                active
                  ? []
                  : [
                      {
                        id: 'selectLines',
                        title: 'Select lines',
                        onSelect: () => setActive(true),
                      },
                    ]
              }
            />
            <span>{included ? 'included' : 'excluded'}</span>
          </>
        );
      }
      const screen = await renderScreen(<SelectionHarness />);
      await selectMenuItem(screen, 'selectLines');
      expect(screen.findByTestId('file-details-clear-selection')).toBeTruthy();
      expect(menuItemIds(screen)).not.toContain('selectLines');
      expect(screen.getTextContent()).toContain('excluded');
      await screen.pressByTestIdAsync('file-details-clear-selection');
      expect(menuItemIds(screen)).toContain('selectLines');
      expect(screen.getTextContent()).toContain('excluded');
      await screen.pressByTestIdAsync('file-details-stage-file');
      expect(screen.getTextContent()).toContain('included');
      expect(screen.findByTestId('file-details-clear-selection')).toBeNull();
    },
  );

  it('offers separate whole-file and line selection from combined diff mode', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');
    const onStageFile = vi.fn();
    const onStartLineSelection = vi.fn();

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        theme,
        displayMode: 'diff',
        onDisplayMode: () => {},
        diffMode: 'both',
        onDiffMode: () => {},
        hasPendingDelta: true,
        hasIncludedDelta: true,
        scmWriteEnabled: true,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: true,
        isSelectedForCommit: false,
        lineSelectionEnabled: false,
        lineSelectionCanStart: true,
        lineSelectionActive: false,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile,
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
        menuActions: [
          {
            id: 'selectLines',
            title: 'Select lines',
            onSelect: onStartLineSelection,
          },
        ],
        isUntrackedFile: false,
      }),
    );

    await screen.pressByTestIdAsync('file-details-stage-file');

    expect(onStageFile).toHaveBeenCalledTimes(1);
    expect(onStartLineSelection).not.toHaveBeenCalled();
    await selectMenuItem(screen, 'selectLines');
    expect(onStartLineSelection).toHaveBeenCalledTimes(1);
  });

  it('shows explicit whole-file and cancel controls while waiting for line picks', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');
    const onStageFile = vi.fn();
    const onClearSelection = vi.fn();

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        theme,
        displayMode: 'diff',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: true,
        hasIncludedDelta: false,
        scmWriteEnabled: true,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: true,
        isSelectedForCommit: false,
        lineSelectionEnabled: true,
        lineSelectionActive: true,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile,
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection,
        onStartLineSelection: () => {},
        isUntrackedFile: false,
      }),
    );

    expect(
      screen.findByTestId('file-details-line-selection-active'),
    ).toBeTruthy();
    expect(screen.findByTestId('file-details-stage-file')).toBeTruthy();
    expect(screen.findByTestId('file-details-clear-selection')).toBeTruthy();
    expect(
      screen.findByTestId('file-details-stage-file')?.props.accessibilityLabel,
    ).toBe('files.fileActions.selectEntireFileForCommit');
    expect(screen.getTextContent()).not.toContain(
      'files.fileActions.selectForCommit',
    );

    await screen.pressByTestIdAsync('file-details-stage-file');
    await screen.pressByTestIdAsync('file-details-clear-selection');

    expect(onStageFile).toHaveBeenCalledTimes(1);
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it('shows a visible range action while line selection is active', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');
    const onStartRangeSelection = vi.fn();

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        theme,
        displayMode: 'diff',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: true,
        hasIncludedDelta: false,
        scmWriteEnabled: true,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: true,
        isSelectedForCommit: false,
        lineSelectionEnabled: true,
        lineSelectionActive: true,
        rangeSelectionActive: false,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
        onStartLineSelection: () => {},
        onStartRangeSelection,
        isUntrackedFile: false,
      }),
    );

    expect(screen.findByTestId('file-details-range-selection')).toBeTruthy();
    expect(screen.getTextContent()).toContain(
      'files.fileActions.rangeSelection',
    );

    await screen.pressByTestIdAsync('file-details-range-selection');

    expect(onStartRangeSelection).toHaveBeenCalledTimes(1);
  });

  it('renders a review comment mode toggle when review comments are available', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');
    const onToggleCommentMode = vi.fn();

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        theme,
        displayMode: 'markdown',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: false,
        hasIncludedDelta: false,
        scmWriteEnabled: true,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: false,
        isSelectedForCommit: false,
        lineSelectionEnabled: false,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
        reviewCommentsEnabled: true,
        commentModeActive: false,
        onToggleCommentMode,
      }),
    );

    expect(screen.findByTestId('file-details-comment-mode')).toBeTruthy();

    await screen.pressByTestIdAsync('file-details-comment-mode');

    expect(onToggleCommentMode).toHaveBeenCalledWith(true);
  });

  it('uses a horizontally scrollable compact action row when selected-line controls overflow', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        theme,
        fileName: 'logger.ts',
        filePath: 'src/middleware/logger.ts',
        displayMode: 'diff',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: true,
        hasIncludedDelta: false,
        scmWriteEnabled: true,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: true,
        isSelectedForCommit: false,
        lineSelectionEnabled: true,
        lineSelectionActive: true,
        selectedLineCount: 2,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
        modes: [
          { id: 'view', displayMode: 'file' },
          { id: 'changes', displayMode: 'diff' },
        ],
        fileEditorEnabled: true,
        isEditingFile: false,
        onStartEditingFile: () => {},
      }),
    );

    expect(screen.findByTestId('file-details-view-actions')).toBeTruthy();
    expect(screen.findByTestId('file-details-view-mode:diff')).toBeTruthy();
    // Selected-line controls sit on their own wrapping row under the header, never clipped off.
    const selectionBar = screen.findByTestId('file-details-change-actions');
    expect(selectionBar).toBeTruthy();
    expect(flattenToolbarStyle(selectionBar?.props.style).flexWrap).toBe(
      'wrap',
    );
    expect(
      screen.findByTestId('file-details-apply-selected-lines'),
    ).toBeTruthy();
    expect(screen.findByTestId('file-details-clear-selection')).toBeTruthy();
  });

  it('does not treat displayed applied line counts as active draft selection controls', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        theme,
        displayMode: 'diff',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: true,
        hasIncludedDelta: false,
        scmWriteEnabled: true,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: true,
        isSelectedForCommit: true,
        lineSelectionEnabled: true,
        lineSelectionActive: false,
        selectedLineCount: 2,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
        onStartLineSelection: () => {},
        isUntrackedFile: false,
      }),
    );

    expect(
      screen.findByTestId('file-details-line-selection-active'),
    ).toBeNull();
    expect(screen.findByTestId('file-details-apply-selected-lines')).toBeNull();
    expect(screen.findByTestId('file-details-clear-selection')).toBeNull();
    expect(screen.findByTestId('file-details-unstage-file')).toBeTruthy();
    expect(screen.findByTestId('file-details-edit-line-selection')).toBeNull();
  });

  it('offers Edit as the band action, Done while editing clean, and Save as the one primary once dirty', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');
    const onStartEditingFile = vi.fn();
    const onSave = vi.fn();
    const onDone = vi.fn();
    const editor = (status: string, canSave = true) => ({
      status,
      canSave,
      onSave,
      onDone,
      onCancel: vi.fn(),
      onStart: vi.fn(),
    });
    const render = (props: Record<string, unknown>) =>
      renderScreen(
        React.createElement(FilePageHeader as any, {
          displayMode: 'file',
          onDisplayMode: () => {},
          diffMode: 'pending',
          onDiffMode: () => {},
          hasPendingDelta: false,
          hasIncludedDelta: false,
          scmWriteEnabled: false,
          includeExcludeEnabled: false,
          virtualSelectionEnabled: false,
          isSelectedForCommit: false,
          lineSelectionEnabled: false,
          selectedLineCount: 0,
          isApplyingStage: false,
          inFlightScmOperation: null,
          onStageFile: () => {},
          onUnstageFile: () => {},
          onApplySelectedLines: () => {},
          onClearSelection: () => {},
          fileEditorEnabled: true,
          onStartEditingFile,
          ...props,
        }),
      );

    const idle = await render({ isEditingFile: false });
    await idle.pressByTestIdAsync('file-details-edit');
    expect(onStartEditingFile).toHaveBeenCalledTimes(1);

    const clean = await render({
      isEditingFile: true,
      editor: editor('clean'),
    });
    expect(clean.findByTestId('file-details-save')).toBeNull();
    await clean.pressByTestIdAsync('file-details-done');
    expect(onDone).toHaveBeenCalledTimes(1);

    const dirty = await render({
      isEditingFile: true,
      editor: editor('dirty'),
    });
    expect(dirty.findByTestId('file-details-done')).toBeNull();
    expect(dirty.findHostByTestId('file-details-save')).toBeTruthy();
    await dirty.pressByTestIdAsync('file-details-save');
    expect(onSave).toHaveBeenCalledTimes(1);

    // A standing conflict is resolved on its own line; Save leaves the header (lab delta 6).
    const conflict = await render({
      isEditingFile: true,
      editor: editor('conflict'),
    });
    expect(conflict.findByTestId('file-details-save')).toBeNull();
    expect(conflict.findByTestId('file-details-done')).toBeNull();
  });
  it('draws no view choice when the file has one view', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        displayMode: 'file',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: false,
        hasIncludedDelta: false,
        scmWriteEnabled: false,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: false,
        isSelectedForCommit: false,
        lineSelectionEnabled: false,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
        modes: [{ id: 'view', displayMode: 'file' }],
      }),
    );

    expect(
      screen.findAll(
        (node) =>
          Array.isArray(node.props?.tabs) &&
          typeof node.props?.onSelectTab === 'function',
      ),
    ).toHaveLength(0);
  });
  it('keeps the reading views reachable while editing, none of them selected', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');
    const onDisplayMode = vi.fn();
    const render = (modes: readonly unknown[]) =>
      renderScreen(
        React.createElement(FilePageHeader as any, {
          displayMode: 'file',
          onDisplayMode,
          diffMode: 'pending',
          onDiffMode: () => {},
          hasPendingDelta: false,
          hasIncludedDelta: false,
          scmWriteEnabled: false,
          includeExcludeEnabled: false,
          virtualSelectionEnabled: false,
          isSelectedForCommit: false,
          lineSelectionEnabled: false,
          selectedLineCount: 0,
          isApplyingStage: false,
          inFlightScmOperation: null,
          onStageFile: () => {},
          onUnstageFile: () => {},
          onApplySelectedLines: () => {},
          onClearSelection: () => {},
          fileEditorEnabled: true,
          isEditingFile: true,
          edit: { kind: 'done', onPress: () => {} },
          modes,
        }),
      );
    const segmentOf = (screen: Awaited<ReturnType<typeof render>>) =>
      screen.findAll(
        (node) =>
          Array.isArray(node.props?.tabs) &&
          typeof node.props?.onSelectTab === 'function',
      )[0];

    const both = await render([
      { id: 'view', displayMode: 'file' },
      { id: 'changes', displayMode: 'diff' },
    ]);
    const segmented = segmentOf(both);
    expect(segmented?.props.tabs.map((tab: any) => tab.id)).toEqual([
      'file',
      'diff',
    ]);
    // Edit is not a reading view: neither View nor Changes reads as current, so View leaves Edit.
    expect(['file', 'diff']).not.toContain(segmented?.props.activeTabId);
    segmented?.props.onSelectTab('file');
    expect(onDisplayMode).toHaveBeenCalledWith('file');

    // View alone is still the way back to reading while a draft is kept.
    const only = await render([{ id: 'view', displayMode: 'file' }]);
    expect(segmentOf(only)?.props.tabs.map((tab: any) => tab.id)).toEqual([
      'file',
    ]);
  });
  it('says a kept draft is unsaved while reading, and nothing for a clean file', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');
    const render = (status: string) =>
      renderScreen(
        React.createElement(FilePageHeader as any, {
          displayMode: 'file', onDisplayMode: () => {}, diffMode: 'pending', onDiffMode: () => {},
          hasPendingDelta: false, hasIncludedDelta: false, scmWriteEnabled: false, includeExcludeEnabled: false,
          virtualSelectionEnabled: false, isSelectedForCommit: false, lineSelectionEnabled: false,
          selectedLineCount: 0, isApplyingStage: false, inFlightScmOperation: null, onStageFile: () => {},
          onUnstageFile: () => {}, onApplySelectedLines: () => {}, onClearSelection: () => {},
          fileEditorEnabled: true, isEditingFile: false,
          editor: { status, canSave: true, onSave: () => {}, onDone: () => {}, onCancel: () => {}, onStart: () => {} },
          edit: { kind: 'edit', onPress: () => {} },
          modes: [{ id: 'view', displayMode: 'file' }],
        }),
      );
    expect((await render('dirty')).findByTestId('file-editor-status-pill')).not.toBeNull();
    expect((await render('clean')).findByTestId('file-editor-status-pill')).toBeNull();
  });
  it('names the views View | Changes in one segmented choice', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        displayMode: 'diff',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: false,
        hasIncludedDelta: false,
        scmWriteEnabled: false,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: false,
        isSelectedForCommit: false,
        lineSelectionEnabled: false,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
        modes: [
          { id: 'view', displayMode: 'file' },
          { id: 'changes', displayMode: 'diff' },
        ],
      }),
    );

    // Two or three short views: one segmented choice, all visible (control decision table).
    const segmented = screen.findAll(
      (node) =>
        Array.isArray(node.props?.tabs) &&
        typeof node.props?.onSelectTab === 'function',
    )[0];
    expect(
      segmented?.props.tabs.map((tab: any) => [tab.id, tab.label]),
    ).toEqual([
      ['file', 'files.pane.page.view'],
      ['diff', 'files.pane.page.changes'],
    ]);
    expect(segmented?.props.activeTabId).toBe('diff');
  });
  it('gives Markdown and SVG Preview | Source | Changes', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');
    const onDisplayMode = vi.fn();

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        displayMode: 'markdown',
        onDisplayMode,
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: false,
        hasIncludedDelta: false,
        scmWriteEnabled: false,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: false,
        isSelectedForCommit: false,
        lineSelectionEnabled: false,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
        modes: [
          { id: 'preview', displayMode: 'markdown' },
          { id: 'source', displayMode: 'file' },
          { id: 'changes', displayMode: 'diff' },
        ],
      }),
    );

    const segmented = screen.findAll(
      (node) =>
        Array.isArray(node.props?.tabs) &&
        typeof node.props?.onSelectTab === 'function',
    )[0];
    expect(segmented?.props.tabs.map((tab: any) => tab.label)).toEqual([
      'files.pane.page.preview',
      'files.pane.page.source',
      'files.pane.page.changes',
    ]);
    expect(segmented?.props.activeTabId).toBe('markdown');

    segmented?.props.onSelectTab('file');
    expect(onDisplayMode).toHaveBeenCalledWith('file');
  });

  it('moves the view choice, Find and Edit to the phone toolbar when it is below', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');
    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        displayMode: 'file',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: false,
        hasIncludedDelta: false,
        scmWriteEnabled: false,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: false,
        isSelectedForCommit: false,
        lineSelectionEnabled: false,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
        modes: [
          { id: 'view', displayMode: 'file' },
          { id: 'changes', displayMode: 'diff' },
        ],
        find: { onOpen: () => {} },
        fileEditorEnabled: true,
        onStartEditingFile: () => {},
        toolbarBelow: true,
      }),
    );
    expect(
      screen.findAll(
        (node) =>
          Array.isArray(node.props?.tabs) &&
          typeof node.props?.onSelectTab === 'function',
      ),
    ).toHaveLength(0);
    expect(screen.findByTestId('file-header-find')).toBeNull();
    expect(screen.findByTestId('file-details-edit')).toBeNull();
  });
  it('keeps View | Changes and Find in a phone Changes band and lets the desk-only review toggles go', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');
    const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
    const { DiffPresentationStyleToggleButton } = await import('@/components/ui/code/diff/DiffPresentationStyleToggleButton');
    const props = {
      displayMode: 'diff',
      onDisplayMode: () => {},
      diffMode: 'pending',
      onDiffMode: () => {},
      hasPendingDelta: true,
      hasIncludedDelta: false,
      scmWriteEnabled: false,
      includeExcludeEnabled: false,
      virtualSelectionEnabled: false,
      isSelectedForCommit: false,
      lineSelectionEnabled: false,
      selectedLineCount: 0,
      isApplyingStage: false,
      inFlightScmOperation: null,
      onStageFile: () => {},
      onUnstageFile: () => {},
      onApplySelectedLines: () => {},
      onClearSelection: () => {},
      modes: [
        { id: 'view', displayMode: 'file' },
        { id: 'changes', displayMode: 'diff' },
      ],
      find: { onOpen: () => {} },
      reviewCommentsEnabled: true,
      onToggleCommentMode: () => {},
    };
    const segments = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
      screen.findAll((node) => Array.isArray(node.props?.tabs) && typeof node.props?.onSelectTab === 'function');
    // The review bar holds the phone's bottom edge (rvp P1), so the band keeps only the way back to View and Find;
    // comments start from a selection there, and a phone diff has one column.
    const phone = await renderScreen(
      React.createElement(SurfaceStateSizeProvider, {
        size: 'phone',
        children: React.createElement(FilePageHeader as any, props),
      }),
    );
    expect(segments(phone)).toHaveLength(1);
    expect(phone.findByTestId('file-header-find')).not.toBeNull();
    expect(phone.findByTestId('file-details-comment-mode')).toBeNull();
    expect(phone.findAllByType(DiffPresentationStyleToggleButton as any)).toHaveLength(0);
    const pane = await renderScreen(React.createElement(FilePageHeader as any, props));
    expect(pane.findByTestId('file-details-comment-mode')).not.toBeNull();
  });

  it('shows the single diff area without offering an unavailable choice', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');

    const singleAreaScreen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        theme,
        displayMode: 'diff',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: true,
        hasIncludedDelta: false,
        scmWriteEnabled: false,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: false,
        isSelectedForCommit: false,
        lineSelectionEnabled: false,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
      }),
    );
    // One layer is no choice: the field is not drawn at all.
    expect(
      singleAreaScreen.findByTestId('file-details-diff-area-menu'),
    ).toBeFalsy();

    const multipleAreaScreen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        theme,
        displayMode: 'diff',
        onDisplayMode: () => {},
        diffMode: 'both',
        onDiffMode: () => {},
        hasPendingDelta: true,
        hasIncludedDelta: true,
        scmWriteEnabled: false,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: false,
        isSelectedForCommit: false,
        lineSelectionEnabled: false,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
      }),
    );

    expect(
      multipleAreaScreen.findByTestId('file-details-diff-area-menu'),
    ).toBeTruthy();
    const { SelectionListFilterChip } = await import('@/components/ui/selectionList');
    const chips = multipleAreaScreen.findAllByType(SelectionListFilterChip);
    expect(chips.at(-1)?.props.filter.options?.map((item: { id: string }) => item.id)).toEqual([
      'pending',
      'included',
      'both',
    ]);
  });

  it('names the diff areas after the index when staging is real, and keeps the selection names for a virtual selection', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');
    const baseProps = {
      theme,
      displayMode: 'diff',
      onDisplayMode: () => {},
      diffMode: 'both',
      onDiffMode: () => {},
      hasPendingDelta: true,
      hasIncludedDelta: true,
      scmWriteEnabled: true,
      includeExcludeEnabled: true,
      isSelectedForCommit: false,
      lineSelectionEnabled: false,
      selectedLineCount: 0,
      isApplyingStage: false,
      inFlightScmOperation: null,
      onStageFile: () => {},
      onUnstageFile: () => {},
      onApplySelectedLines: () => {},
      onClearSelection: () => {},
    };
    const { SelectionListFilterChip } = await import('@/components/ui/selectionList');
    const areaTitles = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
      const chip = screen
        .findAllByType(SelectionListFilterChip)
        .find((node) => node.props.filter.options?.some((item: { id: string }) => item.id === 'pending'));
      return (chip?.props.filter.options ?? []).map((item: { label: string }) => item.label);
    };

    const indexScreen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        ...baseProps,
        virtualSelectionEnabled: false,
      }),
    );
    expect(areaTitles(indexScreen)).toEqual([
      'detailsSurface.file.areaUnstaged',
      'detailsSurface.file.areaStaged',
      'detailsSurface.file.areaBoth',
    ]);

    const virtualScreen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        ...baseProps,
        virtualSelectionEnabled: true,
      }),
    );
    expect(areaTitles(virtualScreen)).toEqual([
      'files.diffModes.pending',
      'files.diffModes.included',
      'files.diffModes.combined',
    ]);
  });

  it('names the file and leads its facts with the folders it lives in', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        fileName: 'SettingsModal.tsx',
        filePath: 'apps/ui/sources/components/settings/modal/SettingsModal.tsx',
        displayMode: 'file',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: false,
        hasIncludedDelta: false,
        scmWriteEnabled: false,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: false,
        isSelectedForCommit: false,
        lineSelectionEnabled: false,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
        statusLabel: 'Modified',
      }),
    );

    const text = screen.getTextContent();
    expect(text).toContain('SettingsModal.tsx');
    // First two and last two folders stay; the middle folds (lab FV1: apps › ui › … › settings › modal).
    for (const crumb of ['apps', 'ui', '…', 'settings', 'modal'])
      expect(text).toContain(crumb);
    expect(text).not.toContain('sources');
  });

  it('keeps compact file actions grouped when the toolbar is narrow', async () => {
    const { FilePageHeader } = await import('./FilePageHeader');

    const screen = await renderScreen(
      React.createElement(FilePageHeader as any, {
        theme,
        fileName: 'logger.ts',
        filePath: 'src/middleware/logger.ts',
        displayMode: 'diff',
        onDisplayMode: () => {},
        diffMode: 'pending',
        onDiffMode: () => {},
        hasPendingDelta: true,
        hasIncludedDelta: false,
        scmWriteEnabled: true,
        includeExcludeEnabled: false,
        virtualSelectionEnabled: true,
        isSelectedForCommit: false,
        lineSelectionEnabled: false,
        selectedLineCount: 0,
        isApplyingStage: false,
        inFlightScmOperation: null,
        onStageFile: () => {},
        onUnstageFile: () => {},
        onApplySelectedLines: () => {},
        onClearSelection: () => {},
        modes: [
          { id: 'view', displayMode: 'file' },
          { id: 'changes', displayMode: 'diff' },
        ],
        fileEditorEnabled: true,
        isEditingFile: false,
        onStartEditingFile: () => {},
      }),
    );

    // Narrow panes keep one header: the quiet toggles and the labelled Stage stay in the band,
    // the whole-file action named for what it does (a virtual commit selection here).
    const stageAction = screen.findByTestId('file-details-stage-file')!;
    expect(stageAction.props.accessibilityLabel).toBe(
      'files.fileActions.selectEntireFileForCommit',
    );
    const viewActions = screen.findByTestId('file-details-view-actions')!;
    const findChildByTestId = (node: any, testID: string): unknown => {
      try {
        return node.findByProps({ testID });
      } catch {
        return null;
      }
    };
    expect(viewActions).toBeTruthy();
    expect(
      findChildByTestId(viewActions, 'file-details-stage-file'),
    ).toBeNull();
  });
});
