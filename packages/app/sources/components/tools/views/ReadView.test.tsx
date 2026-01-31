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

describe('ReadView', () => {
    it('truncates long reads by default', async () => {
        const { ReadView } = await import('./ReadView');

        const content = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
        const tool: ToolCall = {
            name: 'Read',
            state: 'completed',
            input: { file_path: '/tmp/a.txt' } as any,
            result: { content } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ReadView, { tool, metadata: null } as any));
        });

        const codeNodes = tree.root.findAllByType('CodeView' as any);
        expect(codeNodes).toHaveLength(1);
        expect(codeNodes[0].props.code).toContain('line-0');
        expect(codeNodes[0].props.code).toContain('line-19');
        expect(codeNodes[0].props.code).not.toContain('line-20');

        // Ellipsis marker should be shown when truncated.
        const textNodes = tree.root.findAllByType('Text' as any);
        expect(textNodes.map((n) => n.props.children).join('')).toContain('…');
    });

    it('shows substantially more content when detailLevel=full', async () => {
        const { ReadView } = await import('./ReadView');

        const content = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
        const tool: ToolCall = {
            name: 'Read',
            state: 'completed',
            input: { file_path: '/tmp/a.txt' } as any,
            result: { content } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ReadView, { tool, metadata: null, detailLevel: 'full' } as any));
        });

        const codeNodes = tree.root.findAllByType('CodeView' as any);
        expect(codeNodes).toHaveLength(1);
        expect(codeNodes[0].props.code).toContain('line-0');
        expect(codeNodes[0].props.code).toContain('line-99');
        expect(codeNodes[0].props.code).not.toContain('…');

        const textNodes = tree.root.findAllByType('Text' as any);
        expect(textNodes.map((n) => n.props.children).join('')).not.toContain('…');
    });
});

