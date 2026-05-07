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
                                                select: ({ default: value }: { default: number }) => value,
                                            },
                                            View: 'View',
                                            Pressable: 'Pressable',
                                        }
    );
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
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
            divider: '#ddd',
            surface: '#fff',
            surfaceHigh: '#f6f6f6',
            input: { background: '#f2f2f2' },
            text: '#111',
            textSecondary: '#666',
            textLink: '#007AFF',
            success: '#34C759',
            warning: '#FF9500',
        },
    };

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

    it('shows virtual commit selection actions when live staging is disabled', async () => {
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

        expect(screen.findByTestId('file-details-stage-file')).toBeTruthy();
        expect(screen.findByTestId('file-details-unstage-file')).toBeTruthy();
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
                showMarkdownToggle: true,
            }),
        );

        const menu = screen.findByType('DropdownMenu' as any);
        expect(menu?.props.items.map((item: any) => item.id)).toEqual(['diff', 'file', 'markdown']);

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
});
