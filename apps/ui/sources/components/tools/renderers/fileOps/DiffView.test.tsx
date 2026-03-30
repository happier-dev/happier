import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { collectHostText, findPressableByText, makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { ToolHeaderActionsContext } from '../../shell/presentation/ToolHeaderActionsContext';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installFileOpsRendererCommonModuleMocks } from './fileOpsRendererTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const codeLinesSpy = vi.fn();
const syntaxHookSpy = vi.fn();

installFileOpsRendererCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useSetting: (key: string) => {
                if (key === 'showLineNumbersInToolViews') return false;
                if (key === 'wrapLinesInDiffs') return true;
                return undefined;
            },
        });
    },
});

vi.doMock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
    Ionicons: 'Ionicons',
}));

function getUniqueCodeLinesViews() {
    const unique = new Map<string, any>();
    for (const [props] of codeLinesSpy.mock.calls) {
        const key = JSON.stringify(props?.lines ?? []);
        if (!unique.has(key)) unique.set(key, props);
    }
    return [...unique.values()];
}

vi.mock('@/components/ui/code/view/CodeLinesView', () => ({
    CodeLinesView: (props: any) => {
        codeLinesSpy(props);
        return React.createElement('CodeLinesView', props);
    },
}));

vi.mock('@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting', () => ({
    useCodeLinesSyntaxHighlighting: (filePath: string | null) => {
        syntaxHookSpy(filePath);
        return {
            mode: 'simple',
            language: filePath?.endsWith('.txt') ? 'text' : 'typescript',
            maxBytes: 250_000,
            maxLines: 5_000,
            maxLineLength: 2_000,
        };
    },
}));

type DiffFileInput = { file_path: string; unified_diff?: string; oldText?: string; newText?: string };

function makeDiffTool(files: DiffFileInput[]): ToolCall {
    return makeToolCall({
        name: 'Diff',
        state: 'completed',
        input: { files },
        result: null,
    });
}

function wrapWithToolHeaderActions(child: React.ReactElement) {
    function Wrapper() {
        const [actions, setActions] = React.useState<React.ReactNode | null>(null);
        return React.createElement(
            ToolHeaderActionsContext.Provider,
            { value: { setHeaderActions: setActions } },
            React.createElement(React.Fragment, null, actions, child),
        );
    }
    return React.createElement(Wrapper);
}

describe('DiffView', () => {
    it('renders per-file diffs from old/new text pairs when unified diffs are unavailable', async () => {
        codeLinesSpy.mockClear();
        syntaxHookSpy.mockClear();
        const { DiffView } = await import('./DiffView');

        const tool = makeDiffTool([
            { file_path: 'foo.txt', oldText: 'old', newText: 'new' },
            { file_path: 'bar.txt', oldText: '', newText: 'created' },
        ]);

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(wrapWithToolHeaderActions(React.createElement(DiffView, makeToolViewProps(tool, { detailLevel: 'full' }))))).tree;

        const codeLinesViews = getUniqueCodeLinesViews();
        expect(codeLinesViews).toHaveLength(2);
        expect(syntaxHookSpy).toHaveBeenCalledWith('foo.txt');
        expect(syntaxHookSpy).toHaveBeenCalledWith('bar.txt');
        expect(codeLinesSpy).toHaveBeenCalledWith(expect.objectContaining({ syntaxHighlighting: expect.any(Object) }));
    });

    it('renders a compact per-file summary by default and expands a file inline on tap', async () => {
        codeLinesSpy.mockClear();
        const { DiffView } = await import('./DiffView');

        const files = [
            {
                file_path: 'foo.txt',
                unified_diff: ['--- a/foo.txt', '+++ b/foo.txt', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
            },
            {
                file_path: 'bar.txt',
                unified_diff: ['--- a/bar.txt', '+++ b/bar.txt', '@@ -1 +1 @@', '-a', '+b'].join('\n'),
            },
        ];

        const tool = makeDiffTool(files);

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(wrapWithToolHeaderActions(React.createElement(DiffView, makeToolViewProps(tool, { detailLevel: 'summary' }))))).tree;

        expect(codeLinesSpy).toHaveBeenCalledTimes(0);

        const combined = collectHostText(tree).join(' ').replace(/,/g, '');
        expect(combined).toContain('foo.txt');
        expect(combined).toContain('bar.txt');
        expect(combined).toContain('+');
        expect(combined).toContain('-');

        const fooRow = findPressableByText(tree, 'foo.txt', ['Pressable']);
        expect(fooRow).toBeTruthy();

        codeLinesSpy.mockClear();
        await pressTestInstanceAsync(fooRow!, 'foo row');

        expect(getUniqueCodeLinesViews()).toHaveLength(1);
    });

    it('shows all file diffs by default when detailLevel=full and allows collapsing/expanding', async () => {
        codeLinesSpy.mockClear();
        syntaxHookSpy.mockClear();
        const { DiffView } = await import('./DiffView');

        const files = [
            {
                file_path: 'foo.txt',
                unified_diff: ['--- a/foo.txt', '+++ b/foo.txt', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
            },
            {
                file_path: 'bar.txt',
                unified_diff: ['--- a/bar.txt', '+++ b/bar.txt', '@@ -1 +1 @@', '-a', '+b'].join('\n'),
            },
        ];

        const tool = makeDiffTool(files);

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(wrapWithToolHeaderActions(React.createElement(DiffView, makeToolViewProps(tool, { detailLevel: 'full' }))))).tree;

        expect(getUniqueCodeLinesViews()).toHaveLength(2);
        expect(syntaxHookSpy).toHaveBeenCalledWith('foo.txt');
        expect(syntaxHookSpy).toHaveBeenCalledWith('bar.txt');
        expect(codeLinesSpy).toHaveBeenCalledWith(expect.objectContaining({ syntaxHighlighting: expect.any(Object) }));

        const collapseAll = findPressableByText(tree, 'machineLauncher.showLess', ['Pressable']);
        expect(collapseAll).toBeTruthy();

        codeLinesSpy.mockClear();
        await pressTestInstanceAsync(collapseAll!, 'collapse all');
        expect(getUniqueCodeLinesViews()).toHaveLength(0);

        const expandAll = findPressableByText(tree, 'machineLauncher.showAll', ['Pressable']);
        expect(expandAll).toBeTruthy();

        codeLinesSpy.mockClear();
        await pressTestInstanceAsync(expandAll!, 'expand all');
        expect(getUniqueCodeLinesViews()).toHaveLength(2);
    });

    it('virtualizes large inline unified diffs to keep rendering responsive', async () => {
        codeLinesSpy.mockClear();
        const { DiffView } = await import('./DiffView');

        const bigContext: string[] = [];
        bigContext.push('--- a/foo.txt');
        bigContext.push('+++ b/foo.txt');
        bigContext.push('@@ -1,800 +1,800 @@');
        for (let i = 0; i < 800; i++) {
            bigContext.push(` line${i}`);
        }
        bigContext.push('-old');
        bigContext.push('+new');

        const tool = makeDiffTool([
            { file_path: 'foo.txt', unified_diff: bigContext.join('\n') },
        ]);

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(wrapWithToolHeaderActions(React.createElement(DiffView, makeToolViewProps(tool, { detailLevel: 'full' }))))).tree;

        expect(getUniqueCodeLinesViews()).toHaveLength(1);
        expect(codeLinesSpy).toHaveBeenCalledWith(expect.objectContaining({ virtualized: true }));
    });
});
