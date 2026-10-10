import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { HappierMaterialRoleProvider } from '@happier-dev/plugin-ui/presentation';


// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'web',
                                                select: ({ web, default: value }: { web?: number; default: number }) => web ?? value,
                                            },
                                            View: 'View',
                                            ScrollView: 'ScrollView',
                                            Pressable: 'Pressable',
                                        }
    );
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/code/WrapLinesToggleButton', () => ({
    WrapLinesToggleButton: 'WrapLinesToggleButton',
}));

vi.mock('@/constants/Typography', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/constants/Typography')>();
    return { ...actual, Typography: { ...actual.Typography, default: () => ({}), mono: () => ({}) } };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', async () => {
    const React = await import('react');
    return {
        DropdownMenu: (props: any) => React.createElement(
            'DropdownMenu',
            props,
            typeof props.trigger === 'function'
                ? props.trigger({
                    open: Boolean(props.open),
                    toggle: vi.fn(),
                    openMenu: vi.fn(),
                    closeMenu: vi.fn(),
                    selectedItem: props.items?.find((item: any) => item.id === props.selectedId) ?? null,
                })
                : props.trigger,
        ),
    };
});

vi.mock('@/components/ui/scroll/ScrollEdgeFades', async () => {
    const React = await import('react');
    return {
        ScrollEdgeFades: (props: any) => React.createElement('ScrollEdgeFades', props),
    };
});

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', async () => {
    const React = await import('react');
    return {
        ScrollEdgeIndicators: (props: any) => React.createElement('ScrollEdgeIndicators', props),
    };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

function flattenToolbarStyle(style: any): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) return style.reduce((acc, entry) => Object.assign(acc, flattenToolbarStyle(entry)), {});
    return typeof style === 'object' ? style : {};
}

describe('FileActionToolbar', () => {
    const theme = {
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
    };

    it('places the wrap control beside the contextual view actions', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        const screen = await renderScreen(React.createElement(FileActionToolbar as any, {
            theme,
            displayMode: 'diff',
            onDisplayMode: () => {},
            showWrapLinesToggle: true,
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
        }));

        expect(screen.findByTestId('file-details-view-actions')?.findAllByType('WrapLinesToggleButton' as never)).toHaveLength(1);
    });

    it('keeps its rich/raw editing trigger translucent inside a material plane', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        const screen = await renderScreen(<HappierMaterialRoleProvider role="content" resolveMaterialColor={() => 'rgba(0, 0, 0, 0.1)'}>
            <FileActionToolbar theme={theme} displayMode="file" onDisplayMode={() => {}} diffMode="pending" onDiffMode={() => {}}
                hasPendingDelta={false} hasIncludedDelta={false} scmWriteEnabled={false} includeExcludeEnabled={false} virtualSelectionEnabled={false}
                isSelectedForCommit={false} lineSelectionEnabled={false} selectedLineCount={0} isApplyingStage={false} inFlightScmOperation={null}
                onStageFile={() => {}} onUnstageFile={() => {}} onApplySelectedLines={() => {}} onClearSelection={() => {}}
                fileEditorEnabled isEditingFile showMarkdownEditToggle markdownEditMode="rich" markdownRichEligible onMarkdownEditMode={() => {}} />
        </HappierMaterialRoleProvider>);
        expect(flattenToolbarStyle(screen.findByTestId('markdown-edit-mode-menu')!.props.style).backgroundColor).toBe('rgba(0, 0, 0, 0.1)');
    });

    it('shows Stage file for untracked files even when hasPendingDelta is false', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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
                onStageFile: () => {},
                onUnstageFile: () => {},
                onApplySelectedLines: () => {},
                onClearSelection: () => {},
                isUntrackedFile: true,
            }),
        );

        expect(screen.findByTestId('file-details-stage-file')).toBeTruthy();
        const stageFileButton = screen.findByTestId('file-details-stage-file');
        expect(stageFileButton?.props.accessibilityRole).toBe('button');
        expect(stageFileButton?.props.accessibilityLabel).toBe('files.fileActions.stageFile');
        expect(typeof stageFileButton?.props.onPress).toBe('function');
    });

    it('hides include/exclude controls when backend does not support them', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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
        const { FileActionToolbar } = await import('./FileActionToolbar');

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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

        expect(screen.findByTestId('file-details-stage-file')?.props.accessibilityState?.disabled).toBe(false);
    });

    it('shows only the remove action when a file is already selected for commit', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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
        expect(screen.findByTestId('file-details-unstage-file')?.props.accessibilityLabel).toBe('files.fileActions.removeFromCommitSelection');
    });

    it('replaces the file selection action with one compact line-selection action when lines are selected', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        const onApplySelectedLines = vi.fn();
        const onClearSelection = vi.fn();

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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
        expect(screen.findByTestId('file-details-apply-selected-lines')).toBeTruthy();
        expect(screen.getTextContent()).toContain('files.fileActions.selectedLines.selectLinesForCommit');
        expect(screen.getTextContent()).not.toContain('files.fileActions.clearSelection');

        await screen.pressByTestIdAsync('file-details-apply-selected-lines');
        await screen.pressByTestIdAsync('file-details-clear-selection');

        expect(onApplySelectedLines).toHaveBeenCalledTimes(1);
        expect(onClearSelection).toHaveBeenCalledTimes(1);
    });

    it.each([true, false])('keeps whole-file selection distinct and lets empty line selection cancel (virtual=%s)', async (virtualSelectionEnabled) => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        function SelectionHarness() {
            const [active, setActive] = React.useState(false);
            const [included, setIncluded] = React.useState(false);
            return <>
                <FileActionToolbar
                    theme={theme}
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
                    onStartLineSelection={() => setActive(true)}
                />
                <span>{included ? 'included' : 'excluded'}</span>
            </>;
        }
        const screen = await renderScreen(<SelectionHarness />);
        await screen.pressByTestIdAsync('file-details-select-lines');
        expect(screen.findByTestId('file-details-clear-selection')).toBeTruthy();
        expect(screen.findByTestId('file-details-select-lines')).toBeNull();
        expect(screen.getTextContent()).toContain('excluded');
        await screen.pressByTestIdAsync('file-details-clear-selection');
        expect(screen.findByTestId('file-details-select-lines')).toBeTruthy();
        expect(screen.getTextContent()).toContain('excluded');
        await screen.pressByTestIdAsync('file-details-stage-file');
        expect(screen.getTextContent()).toContain('included');
        expect(screen.findByTestId('file-details-clear-selection')).toBeNull();
    });

    it('offers separate whole-file and line selection from combined diff mode', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        const onStageFile = vi.fn();
        const onStartLineSelection = vi.fn();

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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
                onStartLineSelection,
                isUntrackedFile: false,
            }),
        );

        await screen.pressByTestIdAsync('file-details-stage-file');

        expect(onStageFile).toHaveBeenCalledTimes(1);
        expect(onStartLineSelection).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('file-details-select-lines');
        expect(onStartLineSelection).toHaveBeenCalledTimes(1);
    });

    it('does not start line selection during web press start before the completed press action', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        const onStageFile = vi.fn();
        const onStartLineSelection = vi.fn();

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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
                lineSelectionActive: false,
                selectedLineCount: 0,
                isApplyingStage: false,
                inFlightScmOperation: null,
                onStageFile,
                onUnstageFile: () => {},
                onApplySelectedLines: () => {},
                onClearSelection: () => {},
                onStartLineSelection,
                isUntrackedFile: false,
            }),
        );

        const stageFileButton = screen.findByTestId('file-details-stage-file');
        expect(typeof stageFileButton?.props.onPressIn).not.toBe('function');

        expect(onStartLineSelection).not.toHaveBeenCalled();
        expect(onStageFile).not.toHaveBeenCalled();
    });

    it('keeps whole-file selection available without a line selection handler', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        const onStageFile = vi.fn();

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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
                lineSelectionActive: false,
                selectedLineCount: 0,
                isApplyingStage: false,
                inFlightScmOperation: null,
                onStageFile,
                onUnstageFile: () => {},
                onApplySelectedLines: () => {},
                onClearSelection: () => {},
                isUntrackedFile: false,
            }),
        );

        await screen.pressByTestIdAsync('file-details-stage-file');

        expect(onStageFile).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('file-details-select-lines')).toBeNull();
    });

    it('shows explicit whole-file and cancel controls while waiting for line picks', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        const onStageFile = vi.fn();
        const onClearSelection = vi.fn();

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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

        expect(screen.findByTestId('file-details-line-selection-active')).toBeTruthy();
        expect(screen.findByTestId('file-details-stage-file')).toBeTruthy();
        expect(screen.findByTestId('file-details-clear-selection')).toBeTruthy();
        expect(screen.findByTestId('file-details-stage-file')?.props.accessibilityLabel).toBe('files.fileActions.selectEntireFileForCommit');
        expect(screen.getTextContent()).not.toContain('files.fileActions.selectForCommit');

        await screen.pressByTestIdAsync('file-details-stage-file');
        await screen.pressByTestIdAsync('file-details-clear-selection');

        expect(onStageFile).toHaveBeenCalledTimes(1);
        expect(onClearSelection).toHaveBeenCalledTimes(1);
    });

    it('shows a visible range action while line selection is active', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        const onStartRangeSelection = vi.fn();

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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
        expect(screen.getTextContent()).toContain('files.fileActions.rangeSelection');

        await screen.pressByTestIdAsync('file-details-range-selection');

        expect(onStartRangeSelection).toHaveBeenCalledTimes(1);
    });

    it('renders a review comment mode toggle when review comments are available', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        const onToggleCommentMode = vi.fn();

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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
        const { FileActionToolbar } = await import('./FileActionToolbar');

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
                theme,
                fileName: 'logger.ts',
                filePathDir: 'src/middleware',
                rightElement: React.createElement('View', { testID: 'file-discard-action' }),
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
                showDiffToggle: true,
                showFileToggle: true,
                fileEditorEnabled: true,
                isEditingFile: false,
                onStartEditingFile: () => {},
            }),
        );

        const toolbar = screen.findByTestId('file-action-toolbar')!;
        act(() => {
            toolbar.props.onLayout({ nativeEvent: { layout: { width: 360 } } });
        });

        expect(screen.findByTestId('file-details-view-actions')).toBeTruthy();
        expect(screen.findByTestId('file-details-view-mode:diff')).toBeTruthy();
        expect(screen.findByTestId('file-details-header.menu.trigger')).toBeTruthy();
        expect(screen.findByTestId('file-discard-action')).toBeTruthy();
        // Selected-line controls sit on their own wrapping row under the header, never clipped off.
        const selectionBar = screen.findByTestId('file-details-change-actions');
        expect(selectionBar).toBeTruthy();
        expect(flattenToolbarStyle(selectionBar?.props.style).flexWrap).toBe('wrap');
        expect(screen.findByTestId('file-details-apply-selected-lines')).toBeTruthy();
        expect(screen.findByTestId('file-details-clear-selection')).toBeTruthy();
    });

    it('does not treat displayed applied line counts as active draft selection controls', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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

        expect(screen.findByTestId('file-details-line-selection-active')).toBeNull();
        expect(screen.findByTestId('file-details-apply-selected-lines')).toBeNull();
        expect(screen.findByTestId('file-details-clear-selection')).toBeNull();
        expect(screen.findByTestId('file-details-unstage-file')).toBeTruthy();
        expect(screen.findByTestId('file-details-edit-line-selection')).toBeNull();
    });

    it('shows an edit affordance for an applied partial line selection', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        const onStartLineSelection = vi.fn();

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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
                selectedLineCount: 0,
                appliedLineSelectionCount: 2,
                isApplyingStage: false,
                inFlightScmOperation: null,
                onStageFile: () => {},
                onUnstageFile: () => {},
                onApplySelectedLines: () => {},
                onClearSelection: () => {},
                onStartLineSelection,
                isUntrackedFile: false,
            }),
        );

        expect(screen.findByTestId('file-details-apply-selected-lines')).toBeNull();
        expect(screen.findByTestId('file-details-edit-line-selection')).toBeTruthy();

        await screen.pressByTestIdAsync('file-details-edit-line-selection');

        expect(onStartLineSelection).toHaveBeenCalledTimes(1);
    });

    it('offers editing in the header overflow when editor is enabled', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        const onStartEditingFile = vi.fn();

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
                theme,
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
                isEditingFile: false,
                onStartEditingFile,
            }),
        );

        const menu = screen.findAllByType('DropdownMenu' as never).find((node) => node.props.items.some((item: { id: string }) => item.id === 'edit'));
        expect(menu).toBeTruthy();
        await act(async () => { menu?.props.onSelect('edit'); });
        expect(onStartEditingFile).toHaveBeenCalledTimes(1);
    });

    it('hides Diff/File toggles when only one mode is available', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
                theme,
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
                showDiffToggle: false,
                showFileToggle: true,
            }),
        );

        expect(screen.findByTestId('file-details-toggle-diff')).toBeNull();
        expect(screen.findByTestId('file-details-toggle-file')).toBeNull();
    });

    it('uses one compact display mode menu when file and diff modes are both available', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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
                showDiffToggle: true,
                showFileToggle: true,
            }),
        );

        // Two or three short views: one segmented choice, all visible (control decision table).
        const segmented = screen.findAll((node) => Array.isArray(node.props?.tabs) && typeof node.props?.onSelectTab === 'function')[0];
        expect(segmented?.props.tabs.map((tab: any) => tab.id)).toEqual(['diff', 'file']);
    });

    it('adds Markdown to the display mode menu when markdown preview is available', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        const onDisplayMode = vi.fn();

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
                theme,
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
                showDiffToggle: true,
                showFileToggle: true,
                showMarkdownToggle: true,
            }),
        );

        const segmented = screen.findAll((node) => Array.isArray(node.props?.tabs) && typeof node.props?.onSelectTab === 'function')[0];
        expect(segmented?.props.tabs.map((tab: any) => tab.id)).toEqual(['diff', 'file', 'markdown']);
        expect(segmented?.props.activeTabId).toBe('markdown');

        segmented?.props.onSelectTab('markdown');
        expect(onDisplayMode).toHaveBeenCalledWith('markdown');
    });

    it('shows the single diff area without offering an unavailable choice', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        const singleAreaScreen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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
        expect(singleAreaScreen.findByTestId('file-details-diff-area-menu.trigger')?.props.disabled).toBe(true);

        const multipleAreaScreen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
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

        expect(multipleAreaScreen.findByTestId('file-details-diff-area-menu')).toBeTruthy();
        const menus = multipleAreaScreen.findAllByType('DropdownMenu' as any);
        expect(menus.at(-1)?.props.items.map((item: any) => item.id)).toEqual(['pending', 'included', 'both']);
    });

    it('names the diff areas after the index when staging is real, and keeps the selection names for a virtual selection', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
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
        const areaTitles = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
            const menu = screen.findAllByType('DropdownMenu' as any)
                .find((node: any) => (node.props.items ?? []).some((item: any) => item.id === 'pending'));
            return (menu?.props.items ?? []).map((item: any) => item.title);
        };

        const indexScreen = await renderScreen(React.createElement(FileActionToolbar as any, { ...baseProps, virtualSelectionEnabled: false }));
        expect(areaTitles(indexScreen)).toEqual([
            'detailsSurface.file.areaUnstaged',
            'detailsSurface.file.areaStaged',
            'detailsSurface.file.areaBoth',
        ]);

        const virtualScreen = await renderScreen(React.createElement(FileActionToolbar as any, { ...baseProps, virtualSelectionEnabled: true }));
        expect(areaTitles(virtualScreen)).toEqual([
            'files.diffModes.pending',
            'files.diffModes.included',
            'files.diffModes.combined',
        ]);
    });

    it('hosts file path and file-level actions in the command bar', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
                theme,
                fileName: 'env.ts',
                filePathDir: 'src',
                rightElement: React.createElement('View', { testID: 'file-download-action' }),
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
            }),
        );

        // The file is the header's title and its folder leads the live line.
        expect(screen.getTextContent()).toContain('env.ts');
        expect(screen.getTextContent()).toContain('src/');
        expect(screen.findByTestId('file-details-right')).toBeTruthy();
        expect(screen.findByTestId('file-download-action')).toBeTruthy();
    });

    it('keeps compact file actions grouped when the toolbar is narrow', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
                theme,
                fileName: 'logger.ts',
                filePathDir: 'src/middleware',
                rightElement: React.createElement('View', { testID: 'file-discard-action' }),
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
                showDiffToggle: true,
                showFileToggle: true,
                fileEditorEnabled: true,
                isEditingFile: false,
                onStartEditingFile: () => {},
            }),
        );

        const toolbar = screen.findByTestId('file-action-toolbar')!;
        act(() => {
            toolbar.props.onLayout({ nativeEvent: { layout: { width: 360 } } });
        });

        // Narrow panes keep one header: the quiet toggles and the labelled Stage stay in the band,
        // the whole-file action named for what it does (a virtual commit selection here).
        const stageAction = screen.findByTestId('file-details-stage-file')!;
        expect(stageAction.props.accessibilityLabel).toBe('files.fileActions.selectEntireFileForCommit');
        const viewActions = screen.findByTestId('file-details-view-actions')!;
        const findChildByTestId = (node: any, testID: string): unknown => {
            try {
                return node.findByProps({ testID });
            } catch {
                return null;
            }
        };
        expect(screen.findByTestId('file-details-header.menu.trigger')).toBeTruthy();
        expect(findChildByTestId(viewActions, 'file-discard-action')).toBeTruthy();
    });

    it('repurposes the view dropdown into the Raw/Rich edit-mode menu when editing a markdown file (I3)', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        const onMarkdownEditMode = vi.fn();
        const onDisplayMode = vi.fn();

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
                theme,
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
                fileEditorDirty: false,
                onSaveEditingFile: () => {},
                onCancelEditingFile: () => {},
                showMarkdownEditToggle: true,
                markdownEditMode: 'rich',
                onMarkdownEditMode,
                markdownRichEligible: true,
                markdownRichDisabledReason: undefined,
            }),
        );

        // The dropdown is now the edit-mode selector (Raw/Rich), not the view menu.
        expect(screen.findByTestId('markdown-edit-mode-menu')).toBeTruthy();
        expect(screen.findByTestId('file-details-view-mode-menu')).toBeNull();

        const menu = screen.findByType('DropdownMenu' as any);
        expect(menu?.props.items.map((item: any) => item.id)).toEqual(['raw', 'rich']);
        expect(menu?.props.selectedId).toBe('rich');
        // Rich is eligible -> not disabled.
        expect(menu?.props.items.find((item: any) => item.id === 'rich')?.disabled).toBeFalsy();

        menu?.props.onSelect('raw');
        expect(onMarkdownEditMode).toHaveBeenCalledWith('raw');
        // The view (file/diff/markdown) cannot be changed via this menu while editing.
        expect(onDisplayMode).not.toHaveBeenCalled();
    });

    it('disables the Rich option with the reason as a subtitle when rich is ineligible', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
                theme,
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
                isEditingFile: true,
                onSaveEditingFile: () => {},
                onCancelEditingFile: () => {},
                showMarkdownEditToggle: true,
                // Rich is the stored PREFERENCE but the file is ineligible, so the
                // editor renders Raw — the dropdown must reflect the effective mode.
                markdownEditMode: 'rich',
                onMarkdownEditMode: () => {},
                markdownRichEligible: false,
                markdownRichDisabledReason: 'footnotes',
            }),
        );

        const menu = screen.findByType('DropdownMenu' as any);
        const richItem = menu?.props.items.find((item: any) => item.id === 'rich');
        expect(richItem?.disabled).toBe(true);
        expect(richItem?.subtitle).toBe('settingsSourceControl.markdownEditMode.disabledReason.footnotes');
        // Effective mode is Raw (rich ineligible) — NOT the 'rich' preference.
        expect(menu?.props.selectedId).toBe('raw');
    });

    it('does not repurpose the dropdown into edit-mode when showMarkdownEditToggle is false', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
                theme,
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
                isEditingFile: true,
                onSaveEditingFile: () => {},
                onCancelEditingFile: () => {},
                showMarkdownEditToggle: false,
                markdownEditMode: 'rich',
                onMarkdownEditMode: () => {},
            }),
        );

        expect(screen.findByTestId('markdown-edit-mode-menu')).toBeNull();
    });

    it('does not repurpose the dropdown into edit-mode when not editing', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
                theme,
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
                isEditingFile: false,
                onStartEditingFile: () => {},
                showMarkdownEditToggle: true,
                markdownEditMode: 'rich',
                onMarkdownEditMode: () => {},
            }),
        );

        expect(screen.findByTestId('markdown-edit-mode-menu')).toBeNull();
    });
});
