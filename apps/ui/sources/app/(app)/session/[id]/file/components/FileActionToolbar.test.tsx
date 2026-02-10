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

    it('shows Stage file for untracked files even when hasUnstagedDelta is false', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                React.createElement(FileActionToolbar as any, {
                    theme,
                    displayMode: 'diff',
                    onDisplayMode: () => {},
                    diffMode: 'unstaged',
                    onDiffMode: () => {},
                    hasUnstagedDelta: false,
                    hasStagedDelta: false,
                    gitWriteEnabled: true,
                    lineSelectionEnabled: false,
                    selectedLineCount: 0,
                    isApplyingStage: false,
                    hasConflicts: false,
                    inFlightGitOperation: null,
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
});

