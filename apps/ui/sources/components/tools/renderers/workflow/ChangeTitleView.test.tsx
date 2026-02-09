import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { collectHostText, makeToolCall, makeToolViewProps } from '../../shell/views/ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('ChangeTitleView', () => {
    it('renders the title from tool.input.title', async () => {
        const { ChangeTitleView } = await import('./ChangeTitleView');

        const tool = makeToolCall({
            name: 'change_title',
            state: 'completed',
            input: { title: 'Hello' },
            result: {},
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ChangeTitleView, makeToolViewProps(tool)));
        });

        const renderedText = collectHostText(tree);
        expect(renderedText).toContain('Title');
        expect(renderedText).toContain('Hello');
    });

    it('renders nothing when detailLevel=title', async () => {
        const { ChangeTitleView } = await import('./ChangeTitleView');

        const tool = makeToolCall({
            name: 'change_title',
            state: 'completed',
            input: { title: 'Hello' },
            result: {},
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ChangeTitleView, makeToolViewProps(tool, { detailLevel: 'title' })),
            );
        });

        expect(tree.root.findAllByType('Text' as any).length).toBe(0);
    });
});
