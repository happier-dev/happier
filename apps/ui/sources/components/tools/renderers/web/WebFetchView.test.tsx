import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { makeToolViewProps } from '@/dev/testkit';
import { makeCompletedTool } from '../core/truncationView.testHelpers';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('WebFetchView', () => {
    it('indexes only displayed fields and reveals a match beyond the compact body cap with source ranges', async () => {
        const { WebFetchView, projectWebFetchDisplayText } = await import('./WebFetchView');
        const body = 'x'.repeat(3000) + 'needle';
        const tool = makeCompletedTool('WebFetch', { url: 'https://example.com', secret: 'hidden-input' }, { text: body, metadata: 'hidden-result' });
        const blocks = projectWebFetchDisplayText(tool);
        expect(blocks.find((block) => block.id === 'tool-fetch-body')?.text).toBe(body);
        expect(blocks.map((block) => block.text).join('\n')).not.toContain('hidden');
        const ranges = [{ start: 3000, end: 3006, current: true }];
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['fetch', { blocks: [{ id: 'tool-fetch-body', sourceRanges: ranges }] }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}><WebFetchView {...makeToolViewProps(tool, { messageId: 'fetch' })} /></TranscriptFindProvider>);
        expect(screen.getTextContent()).toContain('x'.repeat(3000));
        const highlighted = screen.findAllHostsByTestId('find-match-current');
        expect(highlighted).toHaveLength(1);
        expect(highlighted[0].props.children).toBe('needle');
    });
    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { WebFetchView } = await import('./WebFetchView');
        return renderScreen(React.createElement(
            WebFetchView,
            makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
        ));
    }

    it('shows HTTP status when present', async () => {
        const screen = await renderView(
            makeCompletedTool('WebFetch', { url: 'https://example.com' }, { status: 200, text: 'ok' }),
        );
        const renderedText = screen.getTextContent();
        expect(renderedText).toContain('HTTP 200');
    });

    it('does not truncate content when detailLevel=full', async () => {
        const longText = 'x'.repeat(3000);
        const screen = await renderView(
            makeCompletedTool('WebFetch', { url: 'https://example.com' }, { status: 200, text: longText }),
            'full',
        );

        expect(screen.getTextContent()).toContain(longText);
    });

    it('supports plain-string result payloads and returns null when both url and text are missing', async () => {
        const stringScreen = await renderView(
            makeCompletedTool('WebFetch', { url: 'https://example.com' }, 'plain body'),
        );
        expect(stringScreen.getTextContent()).toContain('plain body');

        const emptyScreen = await renderView(
            makeCompletedTool('WebFetch', {}, { status: 204 }),
        );
        expect(emptyScreen.findAllByType('Text' as any)).toHaveLength(0);
    });
});
