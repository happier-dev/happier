import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    ScrollView: 'ScrollView',
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/media/SimpleSyntaxHighlighter', () => ({
    SimpleSyntaxHighlighter: 'SimpleSyntaxHighlighter',
}));

vi.mock('@/components/git/diff/GitDiffDisplay', () => ({
    GitDiffDisplay: 'GitDiffDisplay',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('FileContentPanel', () => {
    const theme = {
        colors: {
            textSecondary: '#999',
        },
    };

    it('renders diff view when diff mode is selected and diff exists', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');
        const onToggleLine = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <FileContentPanel
                    theme={theme as any}
                    displayMode="diff"
                    diffContent="diff --git a/a.ts b/a.ts"
                    fileContent="const a = 1;"
                    language="typescript"
                    selectedLineIndexes={new Set([1])}
                    lineSelectionEnabled
                    onToggleLine={onToggleLine}
                />
            );
        });

        expect(tree!.root.findAllByType('GitDiffDisplay' as any)).toHaveLength(1);
        expect(tree!.root.findAllByType('SimpleSyntaxHighlighter' as any)).toHaveLength(0);
    });

    it('renders file content when file mode is selected', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <FileContentPanel
                    theme={theme as any}
                    displayMode="file"
                    diffContent="diff --git a/a.ts b/a.ts"
                    fileContent="const a = 1;"
                    language="typescript"
                    selectedLineIndexes={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                />
            );
        });

        expect(tree!.root.findAllByType('SimpleSyntaxHighlighter' as any)).toHaveLength(1);
    });

    it('renders empty message when file mode has no content', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <FileContentPanel
                    theme={theme as any}
                    displayMode="file"
                    diffContent=""
                    fileContent=""
                    language="typescript"
                    selectedLineIndexes={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                />
            );
        });

        const texts = tree!.root.findAllByType('Text' as any);
        expect(texts.some((node) => node.props.children === 'files.fileEmpty')).toBe(true);
    });

    it('renders no changes message when nothing is available', async () => {
        const { FileContentPanel } = await import('./FileContentPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <FileContentPanel
                    theme={theme as any}
                    displayMode="diff"
                    diffContent={null}
                    fileContent={null}
                    language="typescript"
                    selectedLineIndexes={new Set()}
                    lineSelectionEnabled={false}
                    onToggleLine={vi.fn()}
                />
            );
        });

        const texts = tree!.root.findAllByType('Text' as any);
        expect(texts.some((node) => node.props.children === 'files.noChanges')).toBe(true);
    });
});
