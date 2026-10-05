import React from 'react';
import { describe, expect, it } from 'vitest';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { makeToolViewProps, renderScreen } from '@/dev/testkit';
import { makeCompletedTool } from '../core/truncationView.testHelpers';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('WebSearchView', () => {
    it('indexes revealable fields only and reveals a highlighted result beyond the full-view cap', async () => {
        const { WebSearchView, projectWebSearchDisplayText } = await import('./WebSearchView');
        const results = Array.from({ length: 25 }, (_, index) => ({ title: `Document ${index}`, snippet: index === 24 ? 'needle' : 'body', secret: 'hidden-result' }));
        const tool = makeCompletedTool('WebSearch', { query: 'hidden-input' }, { results, metadata: 'hidden-metadata' });
        const blocks = projectWebSearchDisplayText(tool);
        expect(blocks.find((block) => block.id === 'tool-search-24-snippet')?.text).toBe('needle');
        expect(blocks.map((block) => block.text).join('\n')).not.toContain('hidden');
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['search', { blocks: [{ id: 'tool-search-24-snippet', sourceRanges: [{ start: 0, end: 6, current: true }] }] }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}><WebSearchView {...makeToolViewProps(tool, { messageId: 'search', detailLevel: 'full' })} /></TranscriptFindProvider>);
        expect(screen.getTextContent()).toContain('Document 24');
        const highlighted = screen.findAllHostsByTestId('find-match-current');
        expect(highlighted).toHaveLength(1);
    });
    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { WebSearchView } = await import('./WebSearchView');
        return renderScreen(React.createElement(
            WebSearchView,
            makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
        ));
    }

    it('shows a compact subset of results by default', async () => {
        const results = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`);
        const screen = await renderView(
            makeCompletedTool('WebSearch', { query: 'test' }, results),
        );
        const renderedText = screen.getTextContent();

        expect(renderedText).toContain('https://example.com/0');
        expect(renderedText).toContain('https://example.com/4');
        expect(renderedText).not.toContain('https://example.com/5');
        expect(renderedText).toContain('+5 more');
    });

    it('expands to show more results when detailLevel=full', async () => {
        const results = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`);
        const screen = await renderView(
            makeCompletedTool('WebSearch', { query: 'test' }, results),
            'full',
        );
        const renderedText = screen.getTextContent();

        expect(renderedText).toContain('https://example.com/0');
        expect(renderedText).toContain('https://example.com/9');
        expect(renderedText).not.toContain('+5 more');
    });

    it('supports item-object payloads and returns null for malformed payloads', async () => {
        const itemsScreen = await renderView(
            makeCompletedTool(
                'WebSearch',
                { query: 'x' },
                { items: [{ title: 'Doc', link: 'https://example.com/doc', description: 'helpful' }] },
            ),
        );
        const itemsText = itemsScreen.getTextContent();
        expect(itemsText).toContain('Doc');
        expect(itemsText).toContain('https://example.com/doc');
        expect(itemsText).toContain('helpful');

        const malformedScreen = await renderView(makeCompletedTool('WebSearch', { query: 'x' }, { items: 123 }));
        expect(malformedScreen.findAllByType('Text' as any)).toHaveLength(0);
    });
});
