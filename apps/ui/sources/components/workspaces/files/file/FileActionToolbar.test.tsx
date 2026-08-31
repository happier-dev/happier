import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';


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

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

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

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
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

        expect(screen.findByTestId('file-details-stage-file')?.props.disabled).toBe(false);
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
        expect(screen.getTextContent()).toContain('files.fileActions.removeFromCommitSelection');
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

    it('enters line selection mode instead of selecting the whole file when line selection is available', async () => {
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

        await screen.pressByTestIdAsync('file-details-stage-file');

        expect(onStartLineSelection).toHaveBeenCalledTimes(1);
        expect(onStageFile).not.toHaveBeenCalled();
    });

    it('starts line selection instead of selecting the whole file from combined diff mode', async () => {
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

        expect(onStartLineSelection).toHaveBeenCalledTimes(1);
        expect(onStageFile).not.toHaveBeenCalled();
    });

    it('uses a compact neutral affordance when Select for commit starts line-selection mode', async () => {
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
                isSelectedForCommit: false,
                lineSelectionEnabled: true,
                lineSelectionActive: false,
                selectedLineCount: 0,
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

        const stageButton = screen.findByTestId('file-details-stage-file');
        expect(flattenStyle(stageButton?.props.style)).toMatchObject({
            width: 32,
            height: 32,
            borderColor: theme.colors.border.default,
        });
        expect(screen.getTextContent()).not.toContain('files.fileActions.selectForCommit');
    });

    it('uses a compact neutral affordance for Select for commit even when only whole-file selection is available', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        const screen = await renderScreen(
            React.createElement(FileActionToolbar as any, {
                theme,
                displayMode: 'file',
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
                lineSelectionActive: false,
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

        const stageButton = screen.findByTestId('file-details-stage-file');
        expect(flattenStyle(stageButton?.props.style)).toMatchObject({
            width: 32,
            height: 32,
            borderColor: theme.colors.border.default,
        });
        expect(stageButton?.props.accessibilityLabel).toBe('files.fileActions.selectForCommit');
        expect(screen.getTextContent()).not.toContain('files.fileActions.selectForCommit');
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

    it('does not fall back to whole-file staging when line selection entry is missing its handler', async () => {
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

        expect(onStageFile).not.toHaveBeenCalled();
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
        expect(screen.getTextContent()).toContain('files.fileActions.selectEntireFileForCommit');
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
        expect(screen.findByTestId('file-details-view-mode-menu')).toBeTruthy();
        expect(screen.findByTestId('file-details-edit')).toBeTruthy();
        expect(screen.findByTestId('file-details-apply-selected-lines')).toBeTruthy();
        expect(screen.findByTestId('file-details-clear-selection')).toBeTruthy();
        expect(screen.findByTestId('file-discard-action')).toBeTruthy();

        const actionScroll = screen.findByTestId('file-details-compact-action-scroll');
        expect(actionScroll?.props.horizontal).toBe(true);
        expect(actionScroll?.props.showsHorizontalScrollIndicator).toBe(false);
        expect(screen.findByTestId('file-details-compact-action-scroll-content')).toBeTruthy();

        act(() => {
            actionScroll?.props.onLayout({ nativeEvent: { layout: { width: 220, height: 32 } } });
            actionScroll?.props.onContentSizeChange(480, 32);
        });
        expect(screen.findByType('ScrollEdgeFades' as any)?.props.edges).toMatchObject({
            left: false,
            right: true,
        });

        act(() => {
            actionScroll?.props.onScroll({
                nativeEvent: {
                    contentOffset: { x: 80, y: 0 },
                    layoutMeasurement: { width: 220, height: 32 },
                    contentSize: { width: 480, height: 32 },
                },
            });
        });
        expect(screen.findByType('ScrollEdgeIndicators' as any)?.props.edges).toMatchObject({
            left: true,
            right: true,
        });
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

    it('shows an Edit button in file mode when editor is enabled', async () => {
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

        const editButton = screen.findByTestId('file-details-edit');
        expect(editButton).toBeTruthy();

        await screen.pressByTestIdAsync('file-details-edit');
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

        expect(screen.findByTestId('file-details-view-mode-menu')).toBeTruthy();
        expect(screen.findByTestId('file-details-toggle-diff')).toBeNull();
        expect(screen.findByTestId('file-details-toggle-file')).toBeNull();

        const menu = screen.findByType('DropdownMenu' as any);
        expect(menu?.props.items.map((item: any) => item.id)).toEqual(['diff', 'file']);
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

        const menu = screen.findByType('DropdownMenu' as any);
        expect(menu?.props.items.map((item: any) => item.id)).toEqual(['diff', 'file', 'markdown']);
        expect(menu?.props.selectedId).toBe('markdown');

        menu?.props.onSelect('markdown');
        expect(onDisplayMode).toHaveBeenCalledWith('markdown');
    });

    it('only shows the diff area menu when more than one diff area is available', async () => {
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
        expect(singleAreaScreen.findByTestId('file-details-diff-area-menu')).toBeNull();

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

        expect(screen.findByTestId('file-details-path')).toBeTruthy();
        expect(screen.getTextContent()).toContain('src/env.ts');
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

        expect(flattenStyle(screen.findByTestId('file-action-toolbar')?.props.style)).toMatchObject({
            flexDirection: 'column',
        });
        expect(flattenStyle(screen.findByTestId('file-details-path')?.props.style)).toMatchObject({
            width: '100%',
            maxWidth: '100%',
        });
        expect(screen.findByTestId('file-details-compact-action-row')).toBeTruthy();

        const viewActions = screen.findByTestId('file-details-view-actions')!;
        const changeActions = screen.findByTestId('file-details-change-actions')!;
        const findChildByTestId = (node: any, testID: string): unknown => {
            try {
                return node.findByProps({ testID });
            } catch {
                return null;
            }
        };

        expect(findChildByTestId(viewActions, 'file-details-view-mode-menu')).toBeTruthy();
        expect(findChildByTestId(viewActions, 'file-details-edit')).toBeTruthy();
        expect(findChildByTestId(changeActions, 'file-details-stage-file')).toBeTruthy();
        expect(findChildByTestId(changeActions, 'file-discard-action')).toBeTruthy();
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
