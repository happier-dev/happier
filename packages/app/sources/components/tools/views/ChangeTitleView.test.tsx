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

describe('ChangeTitleView', () => {
    it('renders the title from tool.input.title', async () => {
        const { ChangeTitleView } = await import('./ChangeTitleView');

        const tool: ToolCall = {
            name: 'change_title',
            state: 'completed',
            input: { title: 'Hello' } as any,
            result: {} as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ChangeTitleView, { tool, metadata: null } as any));
        });

        const textNodes = tree.root.findAllByType('Text' as any);
        const renderedText = textNodes.map((n) => n.props.children).join(' ');
        expect(renderedText).toContain('Hello');
    });

    it('renders nothing when detailLevel=title', async () => {
        const { ChangeTitleView } = await import('./ChangeTitleView');

        const tool: ToolCall = {
            name: 'change_title',
            state: 'completed',
            input: { title: 'Hello' } as any,
            result: {} as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ChangeTitleView, { tool, metadata: null, detailLevel: 'title' } as any));
        });

        expect(tree.root.findAllByType('Text' as any).length).toBe(0);
    });
});
