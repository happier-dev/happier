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

describe('WebSearchView', () => {
    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { WebSearchView } = await import('./WebSearchView');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    WebSearchView,
                    makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
                ),
            );
        });
        return tree;
    }

    it('shows a compact subset of results by default', async () => {
        const results = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`);
        const tree = await renderView(
            makeCompletedTool('WebSearch', { query: 'test' }, results),
        );
        const renderedText = normalizedHostText(tree);

        expect(renderedText).toContain('https://example.com/0');
        expect(renderedText).toContain('https://example.com/4');
        expect(renderedText).not.toContain('https://example.com/5');
        expect(renderedText).toContain('+ 5 more');
    });

    it('expands to show more results when detailLevel=full', async () => {
        const results = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`);
        const tree = await renderView(
            makeCompletedTool('WebSearch', { query: 'test' }, results),
            'full',
        );
        const renderedText = normalizedHostText(tree);

        expect(renderedText).toContain('https://example.com/0');
        expect(renderedText).toContain('https://example.com/9');
        expect(renderedText).not.toContain('+ 5 more');
    });

    it('supports item-object payloads and returns null for malformed payloads', async () => {
        const itemsTree = await renderView(
            makeCompletedTool(
                'WebSearch',
                { query: 'x' },
                { items: [{ title: 'Doc', link: 'https://example.com/doc', description: 'helpful' }] },
            ),
        );
        const itemsText = normalizedHostText(itemsTree);
        expect(itemsText).toContain('Doc');
        expect(itemsText).toContain('https://example.com/doc');
        expect(itemsText).toContain('helpful');

        const malformedTree = await renderView(makeCompletedTool('WebSearch', { query: 'x' }, { items: 123 }));
        expect(malformedTree.root.findAllByType('Text' as any)).toHaveLength(0);
    });
});
