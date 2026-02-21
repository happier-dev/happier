import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { collectHostText, findPressableByText, makeToolCall, makeToolViewProps } from '../../shell/views/ToolView.testHelpers';
import { ToolHeaderActionsContext } from '../../shell/presentation/ToolHeaderActionsContext';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const diffSpy = vi.fn();
const codeLinesSpy = vi.fn();


vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/tools/shell/presentation/ToolDiffView', () => ({
    ToolDiffView: (props: any) => {
        diffSpy(props);
        return React.createElement('ToolDiffView', props);
    },
}));

vi.mock('@/components/ui/code/view/CodeLinesView', () => ({
    CodeLinesView: (props: any) => {
        codeLinesSpy(props);
        return React.createElement('CodeLinesView', props);
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'showLineNumbersInToolViews') return false;
        if (key === 'wrapLinesInDiffs') return true;
        return undefined;
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => {
        if (key === 'machineLauncher.showLess') return 'Show less';
        if (key === 'machineLauncher.showAll') return 'Show all';
        if (key === 'common.create') return 'Create';
        if (key === 'common.delete') return 'Delete';
        if (key === 'common.rename') return 'Rename';
        return key;
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
        diffSpy.mockClear();
        codeLinesSpy.mockClear();
        const { DiffView } = await import('./DiffView');

        const tool = makeDiffTool([
            { file_path: 'foo.txt', oldText: 'old', newText: 'new' },
            { file_path: 'bar.txt', oldText: '', newText: 'created' },
        ]);

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(wrapWithToolHeaderActions(React.createElement(DiffView, makeToolViewProps(tool, { detailLevel: 'full' }))));
        });

        expect(tree.root.findAllByType('ToolDiffView' as any)).toHaveLength(2);
        expect(tree.root.findAllByType('CodeLinesView' as any)).toHaveLength(0);
        expect(diffSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                oldText: 'old',
                newText: 'new',
            }),
        );
        expect(diffSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                oldText: '',
                newText: 'created',
            }),
        );
    });

    it('renders a compact per-file summary by default and expands a file inline on tap', async () => {
        diffSpy.mockClear();
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
        await act(async () => {
            tree = renderer.create(wrapWithToolHeaderActions(React.createElement(DiffView, makeToolViewProps(tool, { detailLevel: 'summary' }))));
        });

        expect(diffSpy).toHaveBeenCalledTimes(0);
        expect(codeLinesSpy).toHaveBeenCalledTimes(0);

        const combined = collectHostText(tree).join(' ').replace(/,/g, '');
        expect(combined).toContain('foo.txt');
        expect(combined).toContain('bar.txt');
        expect(combined).toContain('+');
        expect(combined).toContain('-');

        const fooRow = findPressableByText(tree, 'foo.txt', ['Pressable']);
        expect(fooRow).toBeTruthy();

        await act(async () => {
            fooRow!.props.onPress();
        });

        expect(tree.root.findAllByType('CodeLinesView' as any)).toHaveLength(1);
        expect(codeLinesSpy).toHaveBeenCalledTimes(1);
    });

    it('shows all file diffs by default when detailLevel=full and allows collapsing/expanding', async () => {
        diffSpy.mockClear();
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
        await act(async () => {
            tree = renderer.create(wrapWithToolHeaderActions(React.createElement(DiffView, makeToolViewProps(tool, { detailLevel: 'full' }))));
        });

        expect(tree.root.findAllByType('CodeLinesView' as any)).toHaveLength(2);

        const collapseAll = findPressableByText(tree, 'Show less', ['Pressable']);
        expect(collapseAll).toBeTruthy();

        await act(async () => {
            collapseAll!.props.onPress();
        });
        expect(tree.root.findAllByType('CodeLinesView' as any)).toHaveLength(0);

        const expandAll = findPressableByText(tree, 'Show all', ['Pressable']);
        expect(expandAll).toBeTruthy();

        await act(async () => {
            expandAll!.props.onPress();
        });
        expect(tree.root.findAllByType('CodeLinesView' as any)).toHaveLength(2);
    });
});
