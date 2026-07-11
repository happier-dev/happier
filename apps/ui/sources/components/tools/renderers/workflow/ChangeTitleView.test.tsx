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

    it('renders the title from tool.result.title when normalized input omits it', async () => {
        const { ChangeTitleView } = await import('./ChangeTitleView');

        const tool = makeToolCall({
            name: 'change_title',
            state: 'completed',
            input: {},
            result: { title: 'OpenCode Result Title' },
        });

        const screen = await renderScreen(React.createElement(ChangeTitleView, makeToolViewProps(tool)));
        const renderedText = screen.getTextContent();
        expect(renderedText).toContain('Title');
        expect(renderedText).toContain('OpenCode Result Title');
    });

    it('renders the title from tool.result.output when the provider returns JSON text', async () => {
        const { ChangeTitleView } = await import('./ChangeTitleView');

        const tool = makeToolCall({
            name: 'change_title',
            state: 'completed',
            input: {},
            result: {
                output: '{"success":true,"title":"OpenCode JSON Title"}',
                metadata: { truncated: false },
            },
        });

        const screen = await renderScreen(React.createElement(ChangeTitleView, makeToolViewProps(tool)));
        const renderedText = screen.getTextContent();
        expect(renderedText).toContain('Title');
        expect(renderedText).toContain('OpenCode JSON Title');
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
