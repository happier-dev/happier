import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: {
        select: ({ default: value }: { default: number }) => value,
    },
    View: 'View',
    Pressable: 'Pressable',
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

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

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
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
                })
            );
        });

        const texts = tree!.root.findAllByType('Text' as any);
        expect(texts.some((node) => node.props.children === 'Stage file')).toBe(true);
    });

    it('hides include/exclude controls when backend does not support them', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
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
                })
            );
        });

        const texts = tree!.root.findAllByType('Text' as any);
        expect(texts.some((node) => node.props.children === 'Stage file')).toBe(false);
        expect(texts.some((node) => node.props.children === 'Unstage file')).toBe(false);
    });

    it('keeps Stage file action enabled when conflicts are present', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
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
                })
            );
        });

        const stageButton = tree!.root
            .findAllByType('Pressable' as any)
            .find((pressable) =>
                pressable.findAllByType('Text' as any).some((textNode) => textNode.props.children === 'Stage file')
            );
        expect(stageButton?.props.disabled).toBe(false);
    });

    it('shows virtual commit selection actions when live staging is disabled', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
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
                })
            );
        });

        const texts = tree!.root.findAllByType('Text' as any);
        expect(texts.some((node) => node.props.children === 'Select for commit')).toBe(true);
        expect(texts.some((node) => node.props.children === 'Remove from selection')).toBe(true);
    });

    it('shows an Edit button in file mode when editor is enabled', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        const onStartEditingFile = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
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
        });

        const editButton = tree!.root
            .findAllByType('Pressable' as any)
            .find((pressable) =>
                pressable.findAllByType('Text' as any).some((textNode) => textNode.props.children === 'Edit')
            );
        expect(editButton).toBeTruthy();

        act(() => {
            editButton!.props.onPress();
        });
        expect(onStartEditingFile).toHaveBeenCalledTimes(1);
    });
});
