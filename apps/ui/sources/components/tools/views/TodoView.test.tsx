import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';
import { makeToolViewProps } from '../ToolView.testHelpers';
import { makeCompletedTool, normalizedHostText } from './truncationView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('TodoView', () => {
    function makeTodoList(count: number) {
        return Array.from({ length: count }).map((_, i) => ({ content: `Item ${i + 1}`, status: 'pending' as const }));
    }

    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { TodoView } = await import('./TodoView');
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    TodoView,
                    makeToolViewProps(tool, { messages: [], ...(detailLevel ? { detailLevel } : {}) }),
                ),
            );
        });
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
        expect(text).toContain('+ 4 more');
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
});
