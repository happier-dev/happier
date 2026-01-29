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

describe('WebSearchView', () => {
    it('shows a compact subset of results by default', async () => {
        const { WebSearchView } = await import('./WebSearchView');

        const results = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`);
        const tool: ToolCall = {
            name: 'WebSearch',
            state: 'completed',
            input: { query: 'test' } as any,
            result: results as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(WebSearchView, { tool, metadata: null } as any));
        });

        const textNodes = tree.root.findAllByType('Text' as any);
        const renderedText = textNodes
            .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
            .join('\n');

        expect(renderedText).toContain('https://example.com/0');
        expect(renderedText).toContain('https://example.com/4');
        expect(renderedText).not.toContain('https://example.com/5');
        expect(renderedText).toContain('+5 more');
    });

    it('expands to show more results when detailLevel=full', async () => {
        const { WebSearchView } = await import('./WebSearchView');

        const results = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`);
        const tool: ToolCall = {
            name: 'WebSearch',
            state: 'completed',
            input: { query: 'test' } as any,
            result: results as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(WebSearchView, { tool, metadata: null, detailLevel: 'full' } as any));
        });

        const textNodes = tree.root.findAllByType('Text' as any);
        const renderedText = textNodes
            .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
            .join('\n');

        expect(renderedText).toContain('https://example.com/0');
        expect(renderedText).toContain('https://example.com/9');
        expect(renderedText).not.toContain('+5 more');
    });
});
