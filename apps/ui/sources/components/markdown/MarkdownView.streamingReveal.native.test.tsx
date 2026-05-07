import React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks({
    reactNative: () =>
        createReactNativeWebMock({
            Platform: { OS: 'ios' },
        }),
});

describe('MarkdownView (native streaming reveal)', () => {
    it('honors selectable=false for native markdown text roots and table cells', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const screen = await renderScreen(
            <MarkdownView
                markdown={[
                    'Hello [native](https://example.com) `world`',
                    '',
                    '| A |',
                    '|---|',
                    '| 1 |',
                ].join('\n')}
                selectable={false}
            />,
        );

        const selectableTextNodes = screen.findAll((node) => node.props?.selectable === true);
        expect(selectableTextNodes).toHaveLength(0);
    });

    it('renders native prose through one selectable enriched markdown text root', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const screen = await renderScreen(
            <MarkdownView markdown="Hello [native](https://example.com) `world` and $E = mc^2$" />,
        );

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        expect(enrichedRun.props.markdown).toBe('Hello [native](https://example.com) `world` and $E = mc^2$');
        expect(enrichedRun.props.selectable).toBe(true);
        expect(enrichedRun.props.flavor).toBe('commonmark');
        expect(screen.findAllByType('Text')).toHaveLength(0);
    });

    it('uses the native GitHub renderer for display math blocks', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const screen = await renderScreen(
            <MarkdownView
                markdown={[
                    'Display math:',
                    '',
                    '$$',
                    'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
                    '$$',
                ].join('\n')}
                streamingMode="streaming"
                streamingAnimated
            />,
        );

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        expect(enrichedRun.props.flavor).toBe('github');
        expect(enrichedRun.props.streamingAnimation).toBe(false);
    });

    it('keeps native streaming text selectable through the parent text root without per-word wrappers', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const screen = await renderScreen(
            <MarkdownView
                markdown="Hello native world"
                streamingMode="streaming"
                streamingAnimated
            />,
        );

        const revealNodes = screen.findAll((node) => node.props?.['data-happier-streaming-text-reveal'] === 'word');
        expect(revealNodes).toHaveLength(0);
        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        expect(enrichedRun.props.markdown).toBe('Hello native world');
        expect(enrichedRun.props.selectable).toBe(true);
        expect(enrichedRun.props.streamingAnimation).toBe(true);
    });
});
