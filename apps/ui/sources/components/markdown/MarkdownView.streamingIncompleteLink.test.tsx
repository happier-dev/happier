import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

const openExternalUrl = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl }));

const INCOMPLETE_LINK_HREF = 'streamdown:incomplete-link';

describe('MarkdownView — inline link still streaming its URL', () => {
    it('renders the label as a link from its first appearance instead of as plain prose', async () => {
        // The re-parent is the flicker: while the URL streams, the label rendered as
        // paragraph text and only became a Link when `)` arrived, remounting the live
        // reveal span. Rendering it as a link immediately is what removes the remount,
        // so the placeholder destination must survive link-target sanitization.
        const { MarkdownView } = await import('./MarkdownView');

        const screen = await renderScreen(
            React.createElement(MarkdownView as any, {
                markdown: 'See [zlink-006](https://exa',
                streamingMode: 'streaming',
                profile: 'transcript',
            }),
        );

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        expect(enrichedRun.props.markdown).toBe(`See [zlink-006](${INCOMPLETE_LINK_HREF})`);
    });

    it('keeps a press on the placeholder destination inert', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const onLinkPress = vi.fn();
        openExternalUrl.mockClear();

        const screen = await renderScreen(
            React.createElement(MarkdownView as any, {
                markdown: 'See [zlink-006](https://exa',
                streamingMode: 'streaming',
                profile: 'transcript',
                onLinkPress,
            }),
        );

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        enrichedRun.props.onLinkPress({ url: INCOMPLETE_LINK_HREF });

        expect(onLinkPress).not.toHaveBeenCalled();
        expect(openExternalUrl).not.toHaveBeenCalled();
    });

    it('opens the real destination once the URL has finished streaming', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const onLinkPress = vi.fn();
        openExternalUrl.mockClear();

        const screen = await renderScreen(
            React.createElement(MarkdownView as any, {
                markdown: 'See [zlink-006](https://example.com/docs) and more.',
                streamingMode: 'streaming',
                profile: 'transcript',
                onLinkPress,
            }),
        );

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        expect(enrichedRun.props.markdown).toBe('See [zlink-006](https://example.com/docs) and more.');

        enrichedRun.props.onLinkPress({ url: 'https://example.com/docs' });

        expect(onLinkPress).toHaveBeenCalledWith('https://example.com/docs');
    });
});
