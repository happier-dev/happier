import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { collectHostText, makeToolCall, makeToolViewProps } from '../../shell/views/ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    ScrollView: 'ScrollView',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('../../shell/presentation/ToolSectionView', () => ({
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

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'showLineNumbersInToolViews') return false;
        if (key === 'wrapLinesInDiffs') return true;
        return undefined;
    },
}));

describe('MultiEditView', () => {
    function makeTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'MultiEdit',
            state: 'completed',
            input: {
                edits: [
                    { old_string: 'a', new_string: 'b' },
                    { old_string: 'c', new_string: 'd', replace_all: true },
                    { old_string: 'e', new_string: 'f' },
                ],
            },
            result: null,
            ...overrides,
        });
    }

    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { MultiEditView } = await import('./MultiEditView');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    MultiEditView,
                    makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
                ),
            );
        });
        return tree;
    }

    it('renders a compact summary by default (first edit only)', async () => {
        diffSpy.mockClear();
        const tree = await renderView(makeTool());

        expect(diffSpy).toHaveBeenCalledTimes(1);
        expect(diffSpy.mock.calls[0]?.[0]).toMatchObject({
            oldText: 'a',
            newText: 'b',
            showLineNumbers: false,
            wrapLines: true,
        });
        const renderedText = collectHostText(tree).join('\n').replace(/\s+/g, ' ');
        expect(renderedText).toContain('+2 more');
        expect(renderedText).not.toContain('Replace all');
    });

    it('renders all edits with headers when detailLevel=full', async () => {
        diffSpy.mockClear();
        const tree = await renderView(makeTool(), 'full');

        expect(diffSpy).toHaveBeenCalledTimes(3);
        expect(diffSpy.mock.calls[0]?.[0]).toMatchObject({
            oldText: 'a',
            newText: 'b',
            showLineNumbers: true,
            wrapLines: true,
        });
        const renderedText = collectHostText(tree).join('\n').replace(/\s+/g, ' ');
        expect(renderedText).toContain('Edit 1/3');
        expect(renderedText).toContain('Edit 2/3');
        expect(renderedText).toContain('Replace all');
        expect(renderedText).not.toContain('+2 more');
    });
});
