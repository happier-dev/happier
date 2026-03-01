import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./MermaidRenderer', () => ({
    MermaidRenderer: () => null,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const actual = await vi.importActual<any>('@/sync/domains/state/storage');
    return {
        ...actual,
        useSetting: (key: string) => {
            if (key === 'filesDiffTokenizationMaxBytes') return tokenizationMaxBytes;
            if (key === 'wrapLinesInDiffs') return false;
            if (key === 'showLineNumbersInToolViews') return false;
            if (key === 'filesDiffFileListVirtualizationMinFiles') return 20;
            return null;
        },
    };
});

vi.mock('@/components/ui/code/blocks/CodeBlockView', () => ({
    CodeBlockView: (props: any) => React.createElement('CodeBlockView', props),
}));

vi.mock('@/components/ui/code/diff/DiffFilesListView', () => ({
    DiffFilesListView: (props: any) => React.createElement('DiffFilesListView', props),
}));

let tokenizationMaxBytes = 1_000_000;

describe('MarkdownView (diff code fences)', () => {
    it('renders ```diff fenced blocks as a diff viewer by default', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            '```diff',
            'diff --git a/a.ts b/a.ts',
            'index 1111111..2222222 100644',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1 +1 @@',
            '-const a = 1',
            '+const a = 2',
            '```',
        ].join('\n');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<MarkdownView markdown={markdown} />);
            });

            expect(tree!.root.findAllByType('DiffFilesListView' as any)).toHaveLength(1);
            expect(tree!.root.findAllByType('CodeBlockView' as any)).toHaveLength(0);

            const toggleButtons = tree!.root.findAll((n) => n.props?.testID === 'markdown-code-block-toggle:code');
            expect(toggleButtons).toHaveLength(1);

            await act(async () => {
                toggleButtons[0]!.props.onPress();
            });

            expect(tree!.root.findAllByType('DiffFilesListView' as any)).toHaveLength(0);
            expect(tree!.root.findAllByType('CodeBlockView' as any)).toHaveLength(1);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    }, 60_000);

    it('falls back to CodeBlockView when diff fenced block exceeds tokenization budget', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        tokenizationMaxBytes = 10;
        const markdown = ['```diff', 'diff --git a/a.ts b/a.ts', '+const a = 2', '```'].join('\n');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<MarkdownView markdown={markdown} />);
            });

            expect(tree!.root.findAllByType('DiffFilesListView' as any)).toHaveLength(0);
            expect(tree!.root.findAllByType('CodeBlockView' as any)).toHaveLength(1);
        } finally {
            tokenizationMaxBytes = 1_000_000;
            act(() => {
                tree?.unmount();
            });
        }
    }, 60_000);

    it('keeps non-diff fenced blocks using CodeBlockView', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = ['```ts', 'export const x = 1;', '```'].join('\n');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<MarkdownView markdown={markdown} />);
            });

            expect(tree!.root.findAllByType('DiffFilesListView' as any)).toHaveLength(0);
            expect(tree!.root.findAllByType('CodeBlockView' as any)).toHaveLength(1);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    }, 60_000);

    it('renders fenced code blocks as plain text when variant="thinking"', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            '```diff',
            'diff --git a/a.ts b/a.ts',
            '@@ -1 +1 @@',
            '-const a = 1',
            '+const a = 2',
            '```',
        ].join('\n');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(React.createElement(MarkdownView as any, { markdown, variant: 'thinking' }));
            });

            expect(tree!.root.findAllByType('DiffFilesListView' as any)).toHaveLength(0);
            expect(tree!.root.findAllByType('CodeBlockView' as any)).toHaveLength(0);

            const textNodes = tree!.root.findAll((n) => typeof n.props?.children === 'string');
            const hasDiffLine = textNodes.some((n) => String(n.props.children).includes('diff --git a/a.ts b/a.ts'));
            const hasPlusLine = textNodes.some((n) => String(n.props.children).includes('+const a = 2'));
            expect(hasDiffLine).toBe(true);
            expect(hasPlusLine).toBe(true);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    }, 60_000);
});
