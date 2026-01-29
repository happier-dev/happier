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

vi.mock('@/components/CodeView', () => ({
    CodeView: ({ code }: any) => React.createElement('CodeView', { code }),
}));

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('WebFetchView', () => {
    it('shows HTTP status when present', async () => {
        const { WebFetchView } = await import('./WebFetchView');

        const tool: ToolCall = {
            name: 'WebFetch',
            state: 'completed',
            input: { url: 'https://example.com' } as any,
            result: { status: 200, text: 'ok' } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(WebFetchView, { tool, metadata: null } as any));
        });

        const textNodes = tree.root.findAllByType('Text' as any);
        const renderedText = textNodes.map((n) => n.props.children).join(' ');
        expect(renderedText).toContain('HTTP 200');
    });

    it('does not truncate content when detailLevel=full', async () => {
        const { WebFetchView } = await import('./WebFetchView');

        const longText = 'x'.repeat(3000);
        const tool: ToolCall = {
            name: 'WebFetch',
            state: 'completed',
            input: { url: 'https://example.com' } as any,
            result: { status: 200, text: longText } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(WebFetchView, { tool, metadata: null, detailLevel: 'full' } as any));
        });

        const codeNodes = tree.root.findAllByType('CodeView' as any);
        expect(codeNodes).toHaveLength(1);
        expect(codeNodes[0].props.code).toBe(longText);
    });
});
