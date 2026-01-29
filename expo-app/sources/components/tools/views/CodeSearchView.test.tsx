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

describe('CodeSearchView', () => {
    it('shows a compact subset of matches by default', async () => {
        const { CodeSearchView } = await import('./CodeSearchView');

        const matches = Array.from({ length: 10 }, (_, i) => ({ excerpt: `match-${i}` }));
        const tool: ToolCall = {
            name: 'CodeSearch',
            state: 'completed',
            input: { query: 'test' } as any,
            result: { matches } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(CodeSearchView, { tool, metadata: null } as any));
        });

        const textNodes = tree.root.findAllByType('Text' as any);
        const renderedText = textNodes
            .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
            .join('\n');

        expect(renderedText).toContain('match-0');
        expect(renderedText).toContain('match-5');
        expect(renderedText).not.toContain('match-6');
        expect(renderedText).toContain('+4 more');
    });

    it('expands to show more matches when detailLevel=full', async () => {
        const { CodeSearchView } = await import('./CodeSearchView');

        const matches = Array.from({ length: 10 }, (_, i) => ({ excerpt: `match-${i}` }));
        const tool: ToolCall = {
            name: 'CodeSearch',
            state: 'completed',
            input: { query: 'test' } as any,
            result: { matches } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(CodeSearchView, { tool, metadata: null, detailLevel: 'full' } as any));
        });

        const textNodes = tree.root.findAllByType('Text' as any);
        const renderedText = textNodes
            .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
            .join('\n');

        expect(renderedText).toContain('match-0');
        expect(renderedText).toContain('match-9');
        expect(renderedText).not.toContain('+4 more');
    });
});
