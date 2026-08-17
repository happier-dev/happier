import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from '../markdownTestHelpers';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

function revealedWords(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
    return screen
        .findAll((node) => node.props?.['data-happier-streaming-text-reveal'] === 'word')
        .map((node) => String(node.props.children));
}

describe('StreamingTextReveal (mount baseline)', () => {
    // The plain streaming surface remounts constantly: list windowing, segment
    // re-splits while markdown streams, and the enriched/legacy segment routing all
    // replace the instance while the text it renders is already on screen. A fresh
    // instance has no baseline to diff against, so classifying everything it renders
    // as "appended" replays the opacity keyframe over the whole run — the same defect
    // that was fixed for the enriched surface at its range owner.
    it('reveals only appended words after mounting onto already-streamed text', async () => {
        const { StreamingTextReveal } = await import('./StreamingTextReveal');
        const alreadyStreamed = 'Prose that was already visible before this instance mounted.';
        const appendedChunk = ' Newly appended words.';

        const screen = await renderScreen(
            React.createElement(StreamingTextReveal, { text: alreadyStreamed, animated: true }),
        );

        expect(revealedWords(screen)).toEqual([]);

        await screen.update(
            React.createElement(StreamingTextReveal, {
                text: `${alreadyStreamed}${appendedChunk}`,
                animated: true,
            }),
        );

        // The intended per-word effect still runs for genuinely appended text.
        expect(revealedWords(screen)).toEqual(['Newly', 'appended', 'words.']);
    }, 60_000);
});
