import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';
import { makeToolCall, makeToolViewProps } from '../ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const markdownViewSpy = vi.fn();

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => {
        markdownViewSpy(props);
        return React.createElement('MarkdownView', props);
    },
}));

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('ReasoningView', () => {
    function makeTool(result: ToolCall['result']): ToolCall {
        return makeToolCall({
            name: 'GeminiReasoning',
            state: 'completed',
            input: { title: 'Thinking' },
            result,
        });
    }

    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { ReasoningView } = await import('./ReasoningView');
        await act(async () => {
            renderer.create(
                React.createElement(
                    ReasoningView,
                    makeToolViewProps(tool, { sessionId: 's1', ...(detailLevel ? { detailLevel } : {}) }),
                ),
            );
        });
    }

    it('renders tool.result.content as markdown', async () => {
        markdownViewSpy.mockReset();
        await renderView(makeTool({ content: 'Hello **world**' }));

        expect(markdownViewSpy).toHaveBeenCalled();
        const lastCall = markdownViewSpy.mock.calls.at(-1)?.[0];
        expect(lastCall?.markdown).toBe('Hello **world**');
    });

    it('truncates long reasoning by default and preserves full content when detailLevel=full', async () => {
        markdownViewSpy.mockReset();
        const long = 'x'.repeat(2000);
        const tool = makeTool({ content: long });
        await renderView(tool);
        const summaryCall = markdownViewSpy.mock.calls.at(-1)?.[0];
        expect(typeof summaryCall?.markdown).toBe('string');
        expect(summaryCall?.markdown.length).toBeLessThan(long.length);
        expect(summaryCall?.markdown.endsWith('…')).toBe(true);

        markdownViewSpy.mockReset();
        await renderView(tool, 'full');
        const fullCall = markdownViewSpy.mock.calls.at(-1)?.[0];
        expect(fullCall?.markdown).toBe(long);
    });

    it('supports string/text/reasoning result fallbacks and ignores malformed payloads', async () => {
        markdownViewSpy.mockReset();
        await renderView(makeTool('plain text result'));
        expect(markdownViewSpy.mock.calls.at(-1)?.[0]?.markdown).toBe('plain text result');

        markdownViewSpy.mockReset();
        await renderView(makeTool({ text: 'text field' }));
        expect(markdownViewSpy.mock.calls.at(-1)?.[0]?.markdown).toBe('text field');

        markdownViewSpy.mockReset();
        await renderView(makeTool({ reasoning: 'reasoning field' }));
        expect(markdownViewSpy.mock.calls.at(-1)?.[0]?.markdown).toBe('reasoning field');

        markdownViewSpy.mockReset();
        await renderView(makeTool({ content: 123 }));
        expect(markdownViewSpy).not.toHaveBeenCalled();
    });
});
