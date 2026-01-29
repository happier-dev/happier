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
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#999' } } }),
}));

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('LSView', () => {
    it('shows a compact subset of entries by default', async () => {
        const { LSView } = await import('./LSView');

        const entries = Array.from({ length: 50 }, (_, i) => `entry-${i}`);
        const tool: ToolCall = {
            name: 'LS',
            state: 'completed',
            input: { path: '/tmp' } as any,
            result: { entries } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(LSView, { tool, metadata: null } as any));
        });

        const renderedText = tree.root
            .findAllByType('Text' as any)
            .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
            .join('\n');

        expect(renderedText).toContain('entry-0');
        expect(renderedText).toContain('entry-7');
        expect(renderedText).not.toContain('entry-8');
        expect(renderedText).toContain('+42 more');
    });

    it('expands to show more entries when detailLevel=full', async () => {
        const { LSView } = await import('./LSView');

        const entries = Array.from({ length: 50 }, (_, i) => `entry-${i}`);
        const tool: ToolCall = {
            name: 'LS',
            state: 'completed',
            input: { path: '/tmp' } as any,
            result: { entries } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(LSView, { tool, metadata: null, detailLevel: 'full' } as any));
        });

        const renderedText = tree.root
            .findAllByType('Text' as any)
            .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
            .join('\n');

        expect(renderedText).toContain('entry-0');
        expect(renderedText).toContain('entry-39');
        expect(renderedText).not.toContain('entry-40');
        expect(renderedText).toContain('+10 more');
    });
});
