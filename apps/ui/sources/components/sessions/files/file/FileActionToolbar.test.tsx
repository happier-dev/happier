import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
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

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

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
});
