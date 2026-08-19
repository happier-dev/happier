import { describe, expect, it, vi } from 'vitest';

import { toLegendListProps } from './toLegendListProps';

describe('toLegendListProps', () => {
    it('passes the shared virtualization surface straight through', () => {
        // Legend accepts every prop the compat surface exposes except the four FlashList internals
        // below, so the adapter must not re-implement or rename anything that already lines up —
        // a renamed prop here is a silently dropped behaviour at the call site.
        const renderItem = vi.fn();
        const getItemType = vi.fn();
        const mapped = toLegendListProps({
            data: [1, 2, 3],
            renderItem,
            keyExtractor: (item: number) => String(item),
            extraData: { a: 1 },
            getItemType,
            estimatedItemSize: 64,
            drawDistance: 250,
            onStartReached: vi.fn(),
            onStartReachedThreshold: 0.2,
            onEndReached: vi.fn(),
            onLoad: vi.fn(),
            maintainVisibleContentPosition: { minIndexForVisible: 0 },
        } as never) as Record<string, unknown>;

        expect(mapped.data).toEqual([1, 2, 3]);
        expect(mapped.renderItem).toBe(renderItem);
        expect(mapped.getItemType).toBe(getItemType);
        expect(mapped.estimatedItemSize).toBe(64);
        expect(mapped.drawDistance).toBe(250);
        expect(mapped.onStartReachedThreshold).toBe(0.2);
        expect(mapped.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
    });

    it('drops the FlashList-only props Legend has no counterpart for', () => {
        const mapped = toLegendListProps({
            data: [],
            renderItem: vi.fn(),
            overrideItemLayout: vi.fn(),
            initialScrollIndexParams: { viewOffset: 10 },
            happierPauseOffsetCorrection: true,
        } as never) as Record<string, unknown>;

        // Forwarding these to Legend would put unknown props on a ScrollView; they exist only to
        // drive FlashList's own layout pipeline.
        expect('overrideItemLayout' in mapped).toBe(false);
        expect('initialScrollIndexParams' in mapped).toBe(false);
        expect('happierPauseOffsetCorrection' in mapped).toBe(false);
    });

    it('spreads the web escape hatch instead of forwarding it as a prop', () => {
        const onWheel = vi.fn();
        const mapped = toLegendListProps({
            data: [],
            renderItem: vi.fn(),
            overrideProps: { onWheel },
        } as never) as Record<string, unknown>;

        // `overrideProps` is how the web list attaches DOM handlers. Passed through by name it would
        // reach Legend as an unknown prop and the handlers would never attach.
        expect('overrideProps' in mapped).toBe(false);
        expect(mapped.onWheel).toBe(onWheel);
    });

    it('recycles by default so the swap does not silently change cell lifecycle', () => {
        const mapped = toLegendListProps({ data: [], renderItem: vi.fn() } as never) as Record<string, unknown>;

        // FlashList always recycles. Legend can be told not to, and leaving that to its default
        // would change how often rows mount — the exact behaviour this migration must hold steady.
        expect(mapped.recycleItems).toBe(true);
    });
});
