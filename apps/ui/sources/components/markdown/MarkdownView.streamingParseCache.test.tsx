import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

describe('MarkdownView streaming parse cache', () => {
    it('reuses prepared render segments across remounts for the same message revision key', async () => {
        const splitter = await import('./rendering/splitMarkdownRenderSegments');
        const splitMarkdownRenderSegmentsSpy = vi.spyOn(splitter, 'splitMarkdownRenderSegments');
        const { MarkdownView } = await import('./MarkdownView');
        try {
            await renderScreen(
                <MarkdownView
                    markdown="Stable **markdown**"
                    profile="transcript"
                    streamingMode="streaming"
                    renderCacheKey="message-1:7"
                />,
            );
            standardCleanup();

            await renderScreen(
                <MarkdownView
                    markdown="Stable **markdown**"
                    profile="transcript"
                    streamingMode="streaming"
                    renderCacheKey="message-1:7"
                />,
            );
            standardCleanup();

            await renderScreen(
                <MarkdownView
                    markdown="Stable **markdown**"
                    profile="transcript"
                    streamingMode="streaming"
                    renderCacheKey="message-1:8"
                />,
            );

            expect(splitMarkdownRenderSegmentsSpy).toHaveBeenCalledTimes(2);
        } finally {
            splitMarkdownRenderSegmentsSpy.mockRestore();
        }
    });

    it('never reuses an earlier paced frame when prepared content changes under one revision key', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const common = {
            profile: 'transcript',
            streamingMode: 'streaming',
            renderCacheKey: 'message-paced:7',
        } as const;

        const screen = await renderScreen(
            <MarkdownView markdown="Hello" {...common} />,
        );
        expect(screen.findByType('EnrichedMarkdownText').props.markdown).toBe('Hello');

        await screen.update(
            <MarkdownView markdown="Hello paced world" {...common} />,
        );
        expect(screen.findByType('EnrichedMarkdownText').props.markdown).toBe('Hello paced world');

        await screen.update(
            <MarkdownView markdown="Hello rewrite" {...common} />,
        );
        expect(screen.findByType('EnrichedMarkdownText').props.markdown).toBe('Hello rewrite');
    });
});
