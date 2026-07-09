import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { View } from 'react-native';
import { afterEach, describe, expect, it } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

import { TranscriptHotTail } from './TranscriptHotTail';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HotItem = Readonly<{ id: string }>;

const CANONICAL_HOT_ITEMS: readonly HotItem[] = [
    { id: 'c0' },
    { id: 'c1' },
    { id: 'c2' },
];
const FOOTER = React.createElement(View, { testID: 'hot-footer' });
const TEST_ID_PREFIX = 'transcript-native-hot-tail';

function hotRowDomOrder(scope: ReactTestInstance, testIDPrefix: string): string[] {
    const prefix = `${testIDPrefix}-item-`;
    return scope
        .findAll((node) =>
            typeof node.type === 'string'
            && typeof node.props?.testID === 'string'
            && node.props.testID.startsWith(prefix))
        .map((node) => (node.props.testID as string).slice(prefix.length));
}

describe('TranscriptHotTail invertedEdgeSlot contract', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders a multi-row native edge slot in chronological order', async () => {
        const screen = await renderScreen(
            React.createElement(TranscriptHotTail, {
                hotItems: CANONICAL_HOT_ITEMS,
                startIndex: CANONICAL_HOT_ITEMS.length - 1,
                displayIndexMode: 'invertedEdgeSlot',
                renderItemAtIndex: (item: HotItem) =>
                    React.createElement(View, { testID: `hot-content-${item.id}` }),
                footer: FOOTER,
                testIDPrefix: TEST_ID_PREFIX,
            }),
        );

        expect(hotRowDomOrder(screen.root, TEST_ID_PREFIX)).toEqual(['c0', 'c1', 'c2']);
        expect(screen.findByTestId('hot-footer')).toBeTruthy();
    });

    it('passes each native edge-slot row the display index for its original canonical item', async () => {
        const newestFirstDisplayItems = [...CANONICAL_HOT_ITEMS].reverse();
        const renderedByItem: Record<string, Readonly<{ displayIndex: number; displayItemId: string | undefined }>> = {};

        await renderScreen(
            React.createElement(TranscriptHotTail, {
                hotItems: CANONICAL_HOT_ITEMS,
                startIndex: CANONICAL_HOT_ITEMS.length - 1,
                displayIndexMode: 'invertedEdgeSlot',
                renderItemAtIndex: (item: HotItem, index: number) => {
                    renderedByItem[item.id] = {
                        displayIndex: index,
                        displayItemId: newestFirstDisplayItems[index]?.id,
                    };

                    return React.createElement(View, { testID: `hot-content-${item.id}` });
                },
                footer: FOOTER,
                testIDPrefix: TEST_ID_PREFIX,
            }),
        );

        expect(renderedByItem).toEqual({
            c0: { displayIndex: 2, displayItemId: 'c0' },
            c1: { displayIndex: 1, displayItemId: 'c1' },
            c2: { displayIndex: 0, displayItemId: 'c2' },
        });
    });

    it('renders a single native edge-slot row normally', async () => {
        const renderedByItem: Record<string, number> = {};
        const screen = await renderScreen(
            React.createElement(TranscriptHotTail, {
                hotItems: [{ id: 'only' }],
                startIndex: 0,
                displayIndexMode: 'invertedEdgeSlot',
                renderItemAtIndex: (item: HotItem, index: number) => {
                    renderedByItem[item.id] = index;
                    return React.createElement(View, { testID: `hot-content-${item.id}` });
                },
                footer: FOOTER,
                testIDPrefix: TEST_ID_PREFIX,
            }),
        );

        expect(screen.findByTestId(TEST_ID_PREFIX)).toBeTruthy();
        expect(hotRowDomOrder(screen.root, TEST_ID_PREFIX)).toEqual(['only']);
        expect(screen.findByTestId('hot-content-only')).toBeTruthy();
        expect(screen.findByTestId('hot-footer')).toBeTruthy();
        expect(renderedByItem).toEqual({ only: 0 });
    });
});
