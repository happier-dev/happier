import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

const splitMarkdownRenderSegmentsSpy = vi.hoisted(() => vi.fn((params: Record<string, unknown>) => [{
    key: 'segment:0',
    kind: 'prose',
    markdown: params.markdown,
    sourceRange: null,
}]));

vi.mock('./rendering/splitMarkdownRenderSegments', () => ({
    splitMarkdownRenderSegments: splitMarkdownRenderSegmentsSpy,
}));

vi.mock('./rendering/MarkdownSegmentView', () => ({
    MarkdownSegmentView: (props: Record<string, unknown>) => React.createElement('MarkdownSegmentView', props),
}));

describe('MarkdownView streaming parse cache', () => {
    it('reuses prepared render segments across remounts for the same message revision key', async () => {
        const { MarkdownView } = await import('./MarkdownView');

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
        expect(screen.findByType('MarkdownSegmentView').props.segment.markdown).toBe('Hello');

        await screen.update(
            <MarkdownView markdown="Hello paced world" {...common} />,
        );
        expect(screen.findByType('MarkdownSegmentView').props.segment.markdown).toBe('Hello paced world');

        await screen.update(
            <MarkdownView markdown="Hello rewrite" {...common} />,
        );
        expect(screen.findByType('MarkdownSegmentView').props.segment.markdown).toBe('Hello rewrite');
    });
});
