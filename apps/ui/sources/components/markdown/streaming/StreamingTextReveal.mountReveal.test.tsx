import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from '../markdownTestHelpers';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

// This file asserts the ANIMATED reveal branch. The resolver now disables that branch on
// low-capability hosts (few cores / little memory / reduced motion); pin a capable host so
// the per-word assertions do not depend on the machine running the suite.
afterEach(() => {
    vi.unstubAllGlobals();
});

function stubCapableRevealHost(): void {
    vi.stubGlobal('window', {
        matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('navigator', { deviceMemory: 8, hardwareConcurrency: 8 });
}

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
        stubCapableRevealHost();
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
