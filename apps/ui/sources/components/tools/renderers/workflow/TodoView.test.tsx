import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { makeToolViewProps } from '@/dev/testkit';
import { makeCompletedTool, normalizedHostText } from '../core/truncationView.testHelpers';
import { renderScreen } from '@/dev/testkit';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('TodoView', () => {
    function makeTodoList(count: number) {
        return Array.from({ length: count }).map((_, i) => ({ content: `Item ${i + 1}`, status: 'pending' as const }));
    }

    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { TodoView } = await import('./TodoView');
        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(React.createElement(
                    TodoView,
                    makeToolViewProps(tool, { messages: [], ...(detailLevel ? { detailLevel } : {}) }),
                ))).tree;
        return tree!;
    }

    it('renders todos from TodoRead result.todos', async () => {
        const tree = await renderView(
            makeCompletedTool('TodoRead', {}, { todos: [{ content: 'Hello', status: 'pending' }] }),
        );

        expect(normalizedHostText(tree)).toContain('Hello');
    });

    it('renders a compact summary by default and shows a +more indicator', async () => {
        const tree = await renderView(
            makeCompletedTool('TodoRead', {}, { todos: makeTodoList(10) }),
        );

        const text = normalizedHostText(tree);
        expect(text).toContain('Item 1');
        expect(text).toContain('Item 6');
        expect(text).not.toContain('Item 7');
        expect(text).toContain('+4 more');
    });

    it('renders more items when detailLevel=full', async () => {
        const tree = await renderView(
            makeCompletedTool('TodoRead', {}, { todos: makeTodoList(10) }),
            'full',
        );

        const text = normalizedHostText(tree);
        expect(text).toContain('Item 10');
        expect(text).not.toContain('more');
    });

    it('supports legacy/new fallback todo payload locations', async () => {
        const fromLegacy = await renderView(
            makeCompletedTool('TodoRead', {}, { newTodos: [{ content: 'Legacy', status: 'pending' }] }),
        );
        expect(normalizedHostText(fromLegacy)).toContain('Legacy');

        const fromInput = await renderView(
            makeCompletedTool('TodoRead', { todos: [{ content: 'FromInput', status: 'pending' }] }, {}),
        );
        expect(normalizedHostText(fromInput)).toContain('FromInput');
    });

    it('finds and decorates a todo beyond both summary and full-view limits without indexing metadata', async () => {
        const module = await import('./TodoView');
        const todos = makeTodoList(55);
        const tool = makeCompletedTool('TodoRead', { hidden: 'private needle' }, { todos, hidden: 'private needle' });
        const blocks = module.projectTodoDisplayText(tool);
        expect(blocks).toHaveLength(55);
        expect(blocks.at(-1)?.text).toBe('☐ Item 55');
        expect(blocks.some((block) => block.text.includes('private'))).toBe(false);
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['m1', { blocks: [{ id: 'tool-todo-54', sourceRanges: [{ start: 2, end: 9, current: true }] }] }]]));
        const { tree } = await renderScreen(<TranscriptFindProvider store={store}>
            <module.TodoView {...makeToolViewProps(tool, { messageId: 'm1' })} />
        </TranscriptFindProvider>);
        expect(normalizedHostText(tree)).toContain('Item 55');
        expect(tree.findByTestId('find-match-current')?.props.children).toBe('Item 55');
    });
});
