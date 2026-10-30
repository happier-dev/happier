import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';


declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./MermaidRenderer', () => ({
    MermaidRenderer: () => null,
}));

installMarkdownCommonModuleMocks({
    storage: () => vi.importActual('@/sync/domains/state/storage'),
});

const { CodeBlockView } = await import('@/components/ui/code/blocks/CodeBlockView');
const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
const { storage } = await import('@/sync/domains/state/storage');

describe('MarkdownView (diff code fences)', () => {
    beforeEach(() => storage.getState().applySettingsLocal({
        filesDiffTokenizationMaxBytes: 1_000_000,
        wrapLinesInDiffs: false,
        showLineNumbersInToolViews: false,
        filesDiffFileListVirtualizationMinFiles: 20,
        filesDiffSyntaxHighlightingMode: 'off',
    }));
    it('renders ```diff fenced blocks as a diff viewer by default', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const diffContent = [
            'diff --git a/a.ts b/a.ts',
            'index 1111111..2222222 100644',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1 +1 @@',
            '-const a = 1',
            '+const a = 2',
        ].join('\n');
        const markdown = [
            '```diff',
            diffContent,
            '```',
        ].join('\n');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            const screen = await renderScreen(<MarkdownView markdown={markdown} />);
            tree = screen.tree;

            const diffView = screen.findByType(DiffFilesListView);
            expect(diffView).not.toBeNull();
            expect(diffView.props.virtualizedListLayout).toBe('intrinsic');
            expect(screen.findAllByType(CodeBlockView)).toHaveLength(0);

            expect(screen.findByTestId('markdown-code-block-toggle:code')).not.toBeNull();
            await screen.pressByTestIdAsync('markdown-code-block-toggle:code');

            expect(screen.findAllByType(DiffFilesListView)).toHaveLength(0);
            const codeView = screen.findByType(CodeBlockView);
            expect(codeView).not.toBeNull();
            expect(codeView.props.code).toBe(diffContent);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    }, 60_000);

    it('falls back to CodeBlockView when diff fenced block exceeds tokenization budget', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        storage.getState().applySettingsLocal({ filesDiffTokenizationMaxBytes: 10 });
        const codeContent = ['diff --git a/a.ts b/a.ts', '+const a = 2'].join('\n');
        const markdown = ['```diff', codeContent, '```'].join('\n');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            const screen = await renderScreen(<MarkdownView markdown={markdown} />);
            tree = screen.tree;

            expect(screen.findAllByType(DiffFilesListView)).toHaveLength(0);
            expect(screen.findAllByType(CodeBlockView)).toHaveLength(1);
            expect(screen.findByType(CodeBlockView).props.code).toBe(codeContent);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    }, 60_000);

    it('keeps non-diff fenced blocks using CodeBlockView', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const codeContent = 'export const x = 1;';
        const markdown = ['```ts', codeContent, '```'].join('\n');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            const screen = await renderScreen(<MarkdownView markdown={markdown} />);
            tree = screen.tree;

            expect(screen.findAllByType(DiffFilesListView)).toHaveLength(0);
            expect(screen.findAllByType(CodeBlockView)).toHaveLength(1);
            expect(screen.findByType(CodeBlockView).props.code).toBe(codeContent);
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
            const screen = await renderScreen(React.createElement(MarkdownView as any, { markdown, variant: 'thinking' }));
            tree = screen.tree;

            expect(screen.findAllByType(DiffFilesListView)).toHaveLength(0);
            expect(screen.findAllByType(CodeBlockView)).toHaveLength(0);

            const textContent = screen.getTextContent();
            const hasDiffLine = textContent.includes('diff --git a/a.ts b/a.ts');
            const hasPlusLine = textContent.includes('+const a = 2');
            expect(hasDiffLine).toBe(true);
            expect(hasPlusLine).toBe(true);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    }, 60_000);
});
