import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from '../markdownTestHelpers';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks({
    storage: () => vi.importActual('@/sync/domains/state/storage'),
});

describe('MarkdownTableViewerModal', () => {
    it('shows only the table in a titled card, scrolls both axes and pins the header row above the scrolling body', async () => {
        const { MarkdownTableViewerModal } = await import('./MarkdownTableViewerModal');
        const setChrome = vi.fn();

        const rows = Array.from({ length: 60 }, (_, index) => [`row ${index}`, `https://example.com/${index}/a/long/path`]);
        const screen = await renderScreen(
            <MarkdownTableViewerModal
                onClose={() => {}}
                setChrome={setChrome}
                headers={['Name', 'Link']}
                rows={rows}
                alignments={['left', 'default']}
                selectable
                profile="transcript"
                agentTexMath={false}
            />,
        );

        expect(setChrome).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'card',
            title: expect.any(String),
            layout: 'fill',
        }));

        const horizontal = screen.findByTestId('markdown-table-viewer-scroll-x')!;
        expect(horizontal.props.horizontal).toBe(true);
        const vertical = screen.findByTestId('markdown-table-viewer-scroll-y')!;
        expect(vertical.props.horizontal).toBeFalsy();
        expect(vertical.props.stickyHeaderIndices).toEqual([0]);

        // The pinned child is the header row; every body row follows it in the same scroller.
        const texts = screen.findAllByType('Text' as any).map((node) => node.props.children);
        expect(texts.slice(0, 2)).toEqual(['Name', 'Link']);
        expect(texts).toContain('row 59');
    }, 60_000);
});
