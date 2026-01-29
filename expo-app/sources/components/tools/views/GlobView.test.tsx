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

describe('GlobView', () => {
    it('shows a compact subset of matches by default', async () => {
        const { GlobView } = await import('./GlobView');

        const matches = Array.from({ length: 50 }, (_, i) => `/path/${i}.ts`);
        const tool: ToolCall = {
            name: 'Glob',
            state: 'completed',
            input: { pattern: '**/*.ts' } as any,
            result: { matches } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(GlobView, { tool, metadata: null } as any));
        });

        const renderedText = tree.root
            .findAllByType('Text' as any)
            .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
            .join('\n');

        expect(renderedText).toContain('/path/0.ts');
        expect(renderedText).toContain('/path/7.ts');
        expect(renderedText).not.toContain('/path/8.ts');
        expect(renderedText).toContain('+42 more');
    });

    it('expands to show more matches when detailLevel=full', async () => {
        const { GlobView } = await import('./GlobView');

        const matches = Array.from({ length: 50 }, (_, i) => `/path/${i}.ts`);
        const tool: ToolCall = {
            name: 'Glob',
            state: 'completed',
            input: { pattern: '**/*.ts' } as any,
            result: { matches } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(GlobView, { tool, metadata: null, detailLevel: 'full' } as any));
        });

        const renderedText = tree.root
            .findAllByType('Text' as any)
            .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
            .join('\n');

        expect(renderedText).toContain('/path/0.ts');
        expect(renderedText).toContain('/path/39.ts');
        expect(renderedText).not.toContain('/path/40.ts');
        expect(renderedText).toContain('+10 more');
    });
});
