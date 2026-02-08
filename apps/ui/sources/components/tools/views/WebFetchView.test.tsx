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

vi.mock('@/components/CodeView', () => ({
    CodeView: ({ code }: any) => React.createElement('CodeView', { code }),
}));

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('WebFetchView', () => {
    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { WebFetchView } = await import('./WebFetchView');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    WebFetchView,
                    makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
                ),
            );
        });
        return tree;
    }

    it('shows HTTP status when present', async () => {
        const tree = await renderView(
            makeCompletedTool('WebFetch', { url: 'https://example.com' }, { status: 200, text: 'ok' }),
        );
        const renderedText = normalizedHostText(tree);
        expect(renderedText).toContain('HTTP 200');
    });

    it('does not truncate content when detailLevel=full', async () => {
        const longText = 'x'.repeat(3000);
        const tree = await renderView(
            makeCompletedTool('WebFetch', { url: 'https://example.com' }, { status: 200, text: longText }),
            'full',
        );

        const codeNodes = tree.root.findAllByType('CodeView' as any);
        expect(codeNodes).toHaveLength(1);
        expect(codeNodes[0].props.code).toBe(longText);
    });

    it('supports plain-string result payloads and returns null when both url and text are missing', async () => {
        const stringTree = await renderView(
            makeCompletedTool('WebFetch', { url: 'https://example.com' }, 'plain body'),
        );
        const codeNodes = stringTree.root.findAllByType('CodeView' as any);
        expect(codeNodes).toHaveLength(1);
        expect(codeNodes[0].props.code).toContain('plain body');

        const emptyTree = await renderView(
            makeCompletedTool('WebFetch', {}, { status: 204 }),
        );
        expect(emptyTree.root.findAllByType('Text' as any)).toHaveLength(0);
    });
});
