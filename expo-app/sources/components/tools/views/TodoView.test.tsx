import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

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
    it('renders todos from TodoRead result.todos', async () => {
        const { TodoView } = await import('./TodoView');

        const tool: ToolCall = {
            name: 'TodoRead',
            state: 'completed',
            input: {},
            result: { todos: [{ content: 'Hello', status: 'pending' }] } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(TodoView, { tool, metadata: null, messages: [] } as any));
        });

        const texts = tree!.root.findAllByType('Text' as any).map((n: any) => n.props.children);
        const flattened = texts.flatMap((c: any) => Array.isArray(c) ? c : [c]).filter((c: any) => typeof c === 'string');
        expect(flattened.join(' ')).toContain('Hello');
    });

    it('renders a compact summary by default and shows a +more indicator', async () => {
        const { TodoView } = await import('./TodoView');

        const tool: ToolCall = {
            name: 'TodoRead',
            state: 'completed',
            input: {},
            result: {
                todos: Array.from({ length: 10 }).map((_, i) => ({ content: `Item ${i + 1}`, status: 'pending' })),
            } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(TodoView, { tool, metadata: null, messages: [] } as any));
        });

        const texts = tree!.root.findAllByType('Text' as any).map((n: any) => n.props.children);
        const flattened = texts
            .flatMap((c: any) => Array.isArray(c) ? c : [c])
            .filter((c: any) => typeof c === 'string' || typeof c === 'number')
            .map((c: any) => String(c));
        const joined = flattened.join(' ');
        const normalizedJoined = joined.replace(/\s+/g, ' ').trim();

        expect(normalizedJoined).toContain('Item 1');
        expect(normalizedJoined).toContain('Item 6');
        expect(normalizedJoined).not.toContain('Item 7');
        expect(normalizedJoined).toContain('+ 4 more');
    });

    it('renders more items when detailLevel=full', async () => {
        const { TodoView } = await import('./TodoView');

        const tool: ToolCall = {
            name: 'TodoRead',
            state: 'completed',
            input: {},
            result: {
                todos: Array.from({ length: 10 }).map((_, i) => ({ content: `Item ${i + 1}`, status: 'pending' })),
            } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(TodoView, { tool, metadata: null, messages: [], detailLevel: 'full' } as any));
        });

        const texts = tree!.root.findAllByType('Text' as any).map((n: any) => n.props.children);
        const flattened = texts
            .flatMap((c: any) => Array.isArray(c) ? c : [c])
            .filter((c: any) => typeof c === 'string' || typeof c === 'number')
            .map((c: any) => String(c));
        const joined = flattened.join(' ');

        expect(joined).toContain('Item 10');
        expect(joined).not.toContain('more');
    });
});
