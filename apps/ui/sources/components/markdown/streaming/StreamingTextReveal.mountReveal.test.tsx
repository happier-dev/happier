import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from '../markdownTestHelpers';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

// This file exercises the host gate at the component level: the animated reveal branch and
// the plain branch a low-capability host (few cores / little memory / reduced motion) gets
// instead. Both host stubs pin reduced motion off — the shared `useReducedMotionPreference`
// store latches the first value it reads, so the file stays pinned to one preference — and
// the per-word assertions never depend on the machine running the suite.
afterEach(() => {
    vi.unstubAllGlobals();
});

function stubCapableRevealHost(): void {
    vi.stubGlobal('window', {
        matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('navigator', { deviceMemory: 8, hardwareConcurrency: 8 });
}

function stubLowCapabilityRevealHost(): void {
    vi.stubGlobal('window', {
        matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('navigator', { deviceMemory: 4, hardwareConcurrency: 4 });
}

function revealedWords(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
    return screen
        .findAll((node) => node.props?.['data-happier-streaming-text-reveal'] === 'word')
        .map((node) => String(node.props.children));
}

function revealedSpans(screen: Awaited<ReturnType<typeof renderScreen>>): ReactTestInstance[] {
    return screen.findAll((node) => node.props?.['data-happier-streaming-text-reveal'] === 'word');
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

    it('renders the plain branch on low-capability hosts and the animated config on capable hosts', async () => {
        stubLowCapabilityRevealHost();
        const { StreamingTextReveal } = await import('./StreamingTextReveal');
        const alreadyStreamed = 'Prose that was already visible before this instance mounted.';
        const appendedText = `${alreadyStreamed} Newly appended words.`;

        const gatedScreen = await renderScreen(
            React.createElement(StreamingTextReveal, { text: alreadyStreamed, animated: true }),
        );
        const plainScreen = await renderScreen(
            React.createElement(StreamingTextReveal, { text: alreadyStreamed, animated: false }),
        );

        await gatedScreen.update(React.createElement(StreamingTextReveal, { text: appendedText, animated: true }));
        await plainScreen.update(React.createElement(StreamingTextReveal, { text: appendedText, animated: false }));

        // A low-capability host takes exactly the animated=false rendering branch: no reveal
        // spans, and an identical tree for identical text.
        expect(revealedWords(gatedScreen)).toEqual([]);
        expect(gatedScreen.tree.toJSON()).toEqual(plainScreen.tree.toJSON());

        // The same append on a capable host resolves the animated config instead.
        stubCapableRevealHost();
        const capableScreen = await renderScreen(
            React.createElement(StreamingTextReveal, { text: alreadyStreamed, animated: true }),
        );
        await capableScreen.update(
            React.createElement(StreamingTextReveal, { text: appendedText, animated: true }),
        );

        const spans = revealedSpans(capableScreen);
        expect(spans.map((node) => String(node.props.children))).toEqual(['Newly', 'appended', 'words.']);
        expect(spans[0].props.style.animationName).toBe('happierMarkdownWordReveal');
    }, 60_000);
});
