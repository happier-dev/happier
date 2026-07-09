import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { View } from 'react-native';
import { renderScreen, standardCleanup } from '@/dev/testkit';

import { TranscriptHotTail } from './TranscriptHotTail';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HOT_ITEMS = [{ id: 'a' }, { id: 'b' }];
const renderItemAtIndex = (item: { id: string }) =>
    React.createElement(View, { testID: `hot-content-${item.id}` });
const FOOTER = React.createElement(View, { testID: 'hot-footer' });

/** Pre-order (DOM) list of the hot-row wrapper item ids under a `*-rows`/host scope. */
function hotRowDomOrder(scope: ReactTestInstance, testIDPrefix: string): string[] {
    const prefix = `${testIDPrefix}-item-`;
    return scope
        .findAll((node) =>
            typeof node.type === 'string'
            && typeof node.props?.testID === 'string'
            && node.props.testID.startsWith(prefix))
        .map((node) => (node.props.testID as string).slice(prefix.length));
}

describe('TranscriptHotTail measurement structure', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('wraps ONLY the hot rows in a measured -rows view (footer excluded) when native folds the height', async () => {
        const screen = await renderScreen(
            React.createElement(TranscriptHotTail, {
                hotItems: HOT_ITEMS,
                startIndex: 0,
                renderItemAtIndex,
                footer: FOOTER,
                testIDPrefix: 'transcript-native-hot-tail',
                onHeightChange: () => {},
            }),
        );

        // The measured rows wrapper exists and contains the hot rows. The footer must render
        // OUTSIDE it so the composer-inset spacer is not double-counted by the bottom command.
        const rows = screen.findByTestId('transcript-native-hot-tail-rows');
        expect(rows).toBeTruthy();
        expect(screen.findByTestId('hot-content-a')).toBeTruthy();
        expect(screen.findByTestId('hot-content-b')).toBeTruthy();
        expect(screen.findByTestId('hot-footer')).toBeTruthy();
    });

    it('keeps a flat structure with NO measured rows wrapper on web (no height folding)', async () => {
        const screen = await renderScreen(
            React.createElement(TranscriptHotTail, {
                hotItems: HOT_ITEMS,
                startIndex: 0,
                renderItemAtIndex,
                footer: FOOTER,
                testIDPrefix: 'transcript-web-hot-tail',
            }),
        );

        // Web stays byte-identical to before the fix: no extra rows wrapper.
        expect(screen.findByTestId('transcript-web-hot-tail-rows')).toBeNull();
        expect(screen.findByTestId('hot-content-a')).toBeTruthy();
        expect(screen.findByTestId('hot-footer')).toBeTruthy();
    });

    it('renders only the footer (no host view) when there are no hot items', async () => {
        const screen = await renderScreen(
            React.createElement(TranscriptHotTail, {
                hotItems: [],
                startIndex: 0,
                renderItemAtIndex,
                footer: FOOTER,
                testIDPrefix: 'transcript-native-hot-tail',
                onHeightChange: () => {},
            }),
        );

        expect(screen.findByTestId('transcript-native-hot-tail')).toBeNull();
        expect(screen.findByTestId('transcript-native-hot-tail-rows')).toBeNull();
        expect(screen.findByTestId('hot-footer')).toBeTruthy();
    });
});

describe('TranscriptHotTail display-index mapping', () => {
    afterEach(() => {
        standardCleanup();
    });

    // The hot slice is ALWAYS canonical oldest-first. These three rows are the chronological
    // turn [c0(oldest), c1, c2(newest)].
    const CANONICAL_HOT = [{ id: 'c0' }, { id: 'c1' }, { id: 'c2' }];

    it('web (sequential) renders oldest->newest in DOM and counts the display index UP from startIndex', async () => {
        const indexByItem: Record<string, number> = {};
        const screen = await renderScreen(
            React.createElement(TranscriptHotTail, {
                hotItems: CANONICAL_HOT,
                // coldCount = 4: the oldest hot row is at display index 4 in the oldest-first list.
                startIndex: 4,
                displayIndexMode: 'sequential',
                renderItemAtIndex: (item: { id: string }, index: number) => {
                    indexByItem[item.id] = index;
                    return React.createElement(View, { testID: `hot-content-${item.id}` });
                },
                footer: FOOTER,
                testIDPrefix: 'transcript-web-hot-tail',
            }),
        );

        // DOM order is chronological (oldest at top) — the web footer reads upright.
        expect(hotRowDomOrder(screen.root, 'transcript-web-hot-tail')).toEqual(['c0', 'c1', 'c2']);
        // Display index counts UP from startIndex: c0->4, c1->5, c2->6 (its index in the
        // oldest-first displayed list).
        expect(indexByItem).toEqual({ c0: 4, c1: 5, c2: 6 });
    });

    it('native inverted edge slot renders oldest->newest in DOM (newest at the VISUAL bottom) and counts the display index DOWN from startIndex', async () => {
        const indexByItem: Record<string, number> = {};
        const screen = await renderScreen(
            React.createElement(TranscriptHotTail, {
                hotItems: CANONICAL_HOT,
                // hotCount - 1 = 2: the oldest hot row (array position 0) is at display index 2 in
                // the newest-first displayItems; the newest hot row is at display index 0.
                startIndex: 2,
                displayIndexMode: 'invertedEdgeSlot',
                renderItemAtIndex: (item: { id: string }, index: number) => {
                    indexByItem[item.id] = index;
                    return React.createElement(View, { testID: `hot-content-${item.id}` });
                },
                footer: FOOTER,
                testIDPrefix: 'transcript-native-hot-tail',
                onHeightChange: () => {},
            }),
        );

        // DOM order stays chronological (oldest at top); under the edge slot's order-preserving
        // scaleY(-1) translation this puts the NEWEST row (c2) at the visual bottom — the fix for
        // the multi-row reversal. (jsdom cannot apply the transform, so we assert the DOM contract
        // the device transform composes with.)
        expect(hotRowDomOrder(screen.root, 'transcript-native-hot-tail')).toEqual(['c0', 'c1', 'c2']);
        // Display index counts DOWN from startIndex: c0->2, c1->1, c2->0 — each row's index in the
        // newest-first displayItems, exactly what the cold list would assign, so the host's
        // older-neighbor lookup resolves the same entry.
        expect(indexByItem).toEqual({ c0: 2, c1: 1, c2: 0 });
    });

    it('defaults to sequential mapping when displayIndexMode is omitted (web byte-compat)', async () => {
        const indexByItem: Record<string, number> = {};
        const screen = await renderScreen(
            React.createElement(TranscriptHotTail, {
                hotItems: CANONICAL_HOT,
                startIndex: 4,
                renderItemAtIndex: (item: { id: string }, index: number) => {
                    indexByItem[item.id] = index;
                    return React.createElement(View, { testID: `hot-content-${item.id}` });
                },
                footer: FOOTER,
                testIDPrefix: 'transcript-web-hot-tail',
            }),
        );

        expect(hotRowDomOrder(screen.root, 'transcript-web-hot-tail')).toEqual(['c0', 'c1', 'c2']);
        expect(indexByItem).toEqual({ c0: 4, c1: 5, c2: 6 });
    });
});
