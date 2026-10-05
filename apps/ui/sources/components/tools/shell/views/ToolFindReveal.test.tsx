import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen, createTestSessionTranscriptSource, wrapWithSessionTranscriptSource, makeToolCall } from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from './ToolView.testHelpers';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { ToolCodeViewWithClamp } from './ToolInlineBody';
import { ToolView } from './ToolView';
import { ToolTimelineRow } from './ToolTimelineRow';
import { ToolError } from '../presentation/ToolError';

installToolShellCommonModuleMocks();

describe('Find tool owner reveal', () => {
    it('decorates the actual parsed error text and opens its height clamp for the current result', async () => {
        const store = createTranscriptFindRowStore();
        const screen = await renderScreen(<TranscriptFindProvider store={store}>
            <ToolError message="<tool_use_error>prefix needle</tool_use_error>" {...{messageId: 'm1', blockId: 'tool-error-append'}} />
        </TranscriptFindProvider>);
        await act(() => store.publish(new Map([['m1', { blocks: [{ id: 'tool-error-append', sourceRanges: [{ start: 7, end: 13, current: true }] }], reveal: { blockId: 'tool-error-append', requestId: 1 } }]])));
        expect(screen.findAllHostsByTestId('find-match-current').map((node) => node.children.join(''))).toEqual(['needle']);
        const container = screen.findByTestId('tool-error-body');
        expect(container?.props.style.flat().at(-1).maxHeight).toBeUndefined();
    });
    it('opens the code clamp for a selected hidden range and still allows user collapse', async () => {
        const store = createTranscriptFindRowStore();
        const screen = await renderScreen(<TranscriptFindProvider store={store}>
            <ToolCodeViewWithClamp value="prefix needle" maxChars={4} sourceId="test" {...{ messageId: 'm1', blockId: 'tool-output' }} />
        </TranscriptFindProvider>);
        expect(screen.findAllHostsByTestId('find-match-current')).toHaveLength(0);
        await act(() => store.publish(new Map([['m1', { blocks: [{ id: 'tool-output', sourceRanges: [{ start: 7, end: 13, current: true }] }], reveal: { blockId: 'tool-output', requestId: 1 } }]])));
        expect(screen.findAllHostsByTestId('find-match-current').map((node) => node.children.join(''))).toEqual(['needle']);
        await act(() => screen.findByTestId('tool-code-clamp:test')?.props.onPress());
        expect(screen.findAllHostsByTestId('find-match-current')).toHaveLength(0);
    });

    it.each([ToolView, ToolTimelineRow])('opens a collapsed real tool body at full detail without changing preferences (%#)', async (ToolShell) => {
        const store = createTranscriptFindRowStore();
        const source = createTestSessionTranscriptSource({ sessionId: 's1' });
        const tool = makeToolCall({ name: 'mcp__example__operation', input: { value: 'needle' }, state: 'completed', result: 'finished' });
        const screen = await renderScreen(wrapWithSessionTranscriptSource(<TranscriptFindProvider store={store}>
            <ToolShell tool={tool} metadata={null} messageId="m1" sessionId="s1" />
        </TranscriptFindProvider>, source));
        expect(screen.findAllHostsByTestId('find-match-current')).toHaveLength(0);
        await act(() => store.publish(new Map([['m1', { blocks: [{ id: 'tool-input', sourceRanges: [{ start: 14, end: 20, current: true }] }], reveal: { blockId: 'tool-input', requestId: 1 } }]])));
        expect(screen.findAllHostsByTestId('find-match-current').length).toBeGreaterThan(0);
    });

    it('reveals a thinking-as-tool card using its original message text block, without a synthetic duplicate', async () => {
        const store = createTranscriptFindRowStore();
        const source = createTestSessionTranscriptSource({ sessionId: 's1' });
        const markdown = `${'prefix '.repeat(150)}needle`;
        const tool = makeToolCall({ name: 'Reasoning', state: 'completed', result: markdown });
        const screen = await renderScreen(wrapWithSessionTranscriptSource(<TranscriptFindProvider store={store}>
            <ToolView tool={tool} metadata={null} messageId="thinking-original" sessionId="s1" findBodyBlockId="text" />
        </TranscriptFindProvider>, source));
        await act(() => store.publish(new Map([['thinking-original', {
            blocks: [{ id: 'text', sourceRanges: [{ start: markdown.length - 6, end: markdown.length, current: true }] }],
            reveal: { blockId: 'text', requestId: 1 },
        }]])));
        expect(screen.findAllHostsByTestId('find-match-current').map((node) => node.children.join(''))).toEqual(['needle']);
    });
});
