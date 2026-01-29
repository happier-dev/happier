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
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#999', surfaceHigh: '#000' } } }),
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/utils/pathUtils', () => ({
    resolvePath: (p: string) => p,
}));

vi.mock('@/sync/storage', () => ({
    useSetting: () => true,
}));

vi.mock('@/components/tools/ToolDiffView', () => ({
    ToolDiffView: () => React.createElement('ToolDiffView', null),
}));

describe('PatchView', () => {
    it('shows an applied indicator when result.applied=true', async () => {
        const { PatchView } = await import('./PatchView');

        const tool: ToolCall = {
            name: 'Patch',
            state: 'completed',
            input: { changes: { '/tmp/a.txt': { type: 'add', add: { content: 'hi' } } } } as any,
            result: { applied: true } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(PatchView, { tool, metadata: null } as any));
        });

        const textNodes = tree.root.findAllByType('Text' as any);
        const renderedText = textNodes.map((n) => n.props.children).join(' ');
        expect(renderedText).toContain('Applied');
    });

    it('shows a deleted indicator when all changes are delete operations', async () => {
        const { PatchView } = await import('./PatchView');

        const tool: ToolCall = {
            name: 'Patch',
            state: 'completed',
            input: {
                changes: {
                    '/tmp/a.txt': { type: 'delete', delete: { content: '' } },
                    '/tmp/b.txt': { type: 'delete', delete: { content: '' } },
                },
            } as any,
            result: { applied: true } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(PatchView, { tool, metadata: null } as any));
        });

        const textNodes = tree.root.findAllByType('Text' as any);
        const renderedText = textNodes.map((n) => n.props.children).join(' ');
        expect(renderedText).toContain('Deleted');
    });

    it('renders a diff preview when detailLevel=full', async () => {
        const { PatchView } = await import('./PatchView');

        const tool: ToolCall = {
            name: 'Patch',
            state: 'completed',
            input: {
                changes: {
                    '/tmp/a.txt': {
                        type: 'modify',
                        modify: { old_content: 'a\n', new_content: 'b\n' },
                    },
                },
            } as any,
            result: { applied: true } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(PatchView, { tool, metadata: null, detailLevel: 'full' } as any));
        });

        expect(tree.root.findAllByType('ToolDiffView' as any)).toHaveLength(1);
    });
});
