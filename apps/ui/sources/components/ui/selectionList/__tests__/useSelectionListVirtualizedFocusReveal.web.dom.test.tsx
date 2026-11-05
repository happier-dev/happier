/** @vitest-environment jsdom */
import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

const { useSelectionListVirtualizedFocusReveal } = await import('../useSelectionListVirtualizedFocusReveal');

function Harness(props: Readonly<{
    scrollToIndex: (params: unknown) => void;
    focusedKey: string;
    focusedCellDomId: string | null;
}>) {
    const listRef = React.useRef({ scrollToIndex: props.scrollToIndex } as never);
    useSelectionListVirtualizedFocusReveal({
        listRef,
        focusedItemIndex: 1,
        focusedKey: props.focusedKey,
        focusedCellDomId: props.focusedCellDomId,
        reducedMotion: true,
    });
    return null;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('useSelectionListVirtualizedFocusReveal — a card inside a column block', () => {
    it('reveals the mounted card itself, because a block can be taller than the viewport', async () => {
        const card = document.createElement('div');
        card.id = 'card-7';
        card.scrollIntoView = vi.fn();
        document.body.append(card);
        const scrollToIndex = vi.fn();

        await act(async () => {
            create(<Harness scrollToIndex={scrollToIndex} focusedKey="m-7" focusedCellDomId="card-7" />);
        });

        expect(card.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
        expect(scrollToIndex).not.toHaveBeenCalled();
    });

    it('scrolls to the block when the card is not mounted yet', async () => {
        const scrollToIndex = vi.fn();

        await act(async () => {
            create(<Harness scrollToIndex={scrollToIndex} focusedKey="m-70" focusedCellDomId="card-70" />);
        });

        expect(scrollToIndex).toHaveBeenCalledWith({ index: 1, viewPosition: 0.5, animated: false });
    });
});
