import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    ScrollView: 'ScrollView',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

const diffSpy = vi.fn();
vi.mock('@/components/diff/DiffView', () => ({
    DiffView: (props: any) => {
        diffSpy(props);
        return React.createElement('DiffView', props);
    },
}));

vi.mock('@/text', () => ({
    t: (key: string, vars?: any) => {
        if (key === 'tools.multiEdit.editNumber') return `Edit ${vars.index}/${vars.total}`;
        if (key === 'tools.multiEdit.replaceAll') return 'Replace all';
        return key;
    },
}));

vi.mock('@/sync/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'showLineNumbersInToolViews') return false;
        if (key === 'wrapLinesInDiffs') return true;
        return undefined;
    },
}));

describe('MultiEditView', () => {
    it('renders a compact summary by default (first edit only)', async () => {
        diffSpy.mockClear();
        const { MultiEditView } = await import('./MultiEditView');

        const tool: ToolCall = {
            name: 'MultiEdit',
            state: 'completed',
            input: {
                edits: [
                    { old_string: 'a', new_string: 'b' },
                    { old_string: 'c', new_string: 'd', replace_all: true },
                    { old_string: 'e', new_string: 'f' },
                ],
            } as any,
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(MultiEditView as any, { tool, metadata: null }));
        });

        expect(diffSpy).toHaveBeenCalledTimes(1);
        const textNodes = tree.root.findAllByType('Text' as any);
        const renderedText = textNodes
            .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
            .join('\n');
        expect(renderedText).toContain('+2 more');
        expect(renderedText).not.toContain('Replace all');
    });

    it('renders all edits with headers when detailLevel=full', async () => {
        diffSpy.mockClear();
        const { MultiEditView } = await import('./MultiEditView');

        const tool: ToolCall = {
            name: 'MultiEdit',
            state: 'completed',
            input: {
                edits: [
                    { old_string: 'a', new_string: 'b' },
                    { old_string: 'c', new_string: 'd', replace_all: true },
                    { old_string: 'e', new_string: 'f' },
                ],
            } as any,
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(MultiEditView as any, { tool, metadata: null, detailLevel: 'full' })
            );
        });

        expect(diffSpy).toHaveBeenCalledTimes(3);
        const textNodes = tree.root.findAllByType('Text' as any);
        const renderedText = textNodes
            .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
            .join('\n');
        expect(renderedText).toContain('Edit 1/3');
        expect(renderedText).toContain('Edit 2/3');
        expect(renderedText).toContain('Replace all');
        expect(renderedText).not.toContain('+2 more');
    });
});

