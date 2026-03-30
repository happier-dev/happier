import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

        const screen = await renderScreen(React.createElement(ChangeTitleView, makeToolViewProps(tool)));
        const renderedText = screen.getTextContent();
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

        const screen = await renderScreen(React.createElement(ChangeTitleView, makeToolViewProps(tool, { detailLevel: 'title' })));

        expect(screen.getTextContent()).toBe('');
    });
});
