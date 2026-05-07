import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

vi.mock('./MermaidRenderer', () => ({
    MermaidRenderer: () => null,
}));

describe('MarkdownView (streaming enriched prose)', () => {
    it('keeps streaming prose in one enriched run to maximize native selection range', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const screen = await renderScreen(
            React.createElement(MarkdownView, {
                markdown: ['Stable block', 'Draft one'].join('\n'),
                streamingMode: 'streaming',
            }),
        );

        let enrichedRuns = screen.findAllByType('EnrichedMarkdownText');
        expect(enrichedRuns.map((node) => node.props.markdown)).toEqual(['Stable block\nDraft one']);

        await act(async () => {
            await screen.update(
                React.createElement(MarkdownView, {
                    markdown: ['Stable block', 'Draft one plus more'].join('\n'),
                    streamingMode: 'streaming',
                }),
            );
        });

        enrichedRuns = screen.findAllByType('EnrichedMarkdownText');
        expect(enrichedRuns.map((node) => node.props.markdown)).toEqual(['Stable block\nDraft one plus more']);
    }, 60_000);
});
