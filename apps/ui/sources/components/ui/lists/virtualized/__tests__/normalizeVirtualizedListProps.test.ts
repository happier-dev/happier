import * as React from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import {
    createFlatListStartReachedHandler,
    normalizeVirtualizedListProps,
} from '../normalizeVirtualizedListProps';
import type { VirtualizedListProps } from '../virtualizedListTypes';

type Row = { id: string };

function baseProps(overrides: Partial<VirtualizedListProps<Row>> = {}): VirtualizedListProps<Row> {
    return {
        data: [{ id: 'a' }],
        renderItem: () => null,
        keyExtractor: (item) => item.id,
        ...overrides,
    };
}

function scrollEvent(offsetY: number): NativeSyntheticEvent<NativeScrollEvent> {
    return { nativeEvent: { contentOffset: { y: offsetY } } } as NativeSyntheticEvent<NativeScrollEvent>;
}

describe('normalizeVirtualizedListProps', () => {
    it('splits shared props from virtualization-only tuning', () => {
        const getItemType = () => 'row';
        const { shared, virtualization } = normalizeVirtualizedListProps(baseProps({
            testID: 'list',
            estimatedItemSize: 44,
            getItemType,
            drawDistance: 200,
        }));

        expect(shared.testID).toBe('list');
        expect(shared.data).toHaveLength(1);
        expect(virtualization.estimatedItemSize).toBe(44);
        expect(virtualization.getItemType).toBe(getItemType);
        expect(virtualization.drawDistance).toBe(200);
        // Tuning props must not leak into the shared FlatList-safe set.
        expect('estimatedItemSize' in shared).toBe(false);
        expect('getItemType' in shared).toBe(false);
    });

    it('coerces nullish data to an empty array', () => {
        const { shared } = normalizeVirtualizedListProps(baseProps({ data: null }));
        expect(shared.data).toEqual([]);
    });
});

describe('createFlatListStartReachedHandler', () => {
    it('returns the original onScroll when no onStartReached is provided', () => {
        const onScroll = vi.fn();
        const { shared, virtualization } = normalizeVirtualizedListProps(baseProps({ onScroll }));
        const handler = createFlatListStartReachedHandler(shared, virtualization, { current: false });
        expect(handler).toBe(onScroll);
    });

    it('fires onStartReached once near the top and re-arms after scrolling away', () => {
        const onStartReached = vi.fn();
        const onScroll = vi.fn();
        const { shared, virtualization } = normalizeVirtualizedListProps(baseProps({
            onScroll,
            onStartReached,
            onStartReachedThreshold: 0,
        }));
        const ref = { current: false } as React.MutableRefObject<boolean>;
        const handler = createFlatListStartReachedHandler(shared, virtualization, ref);

        handler?.(scrollEvent(0));
        handler?.(scrollEvent(0));
        expect(onScroll).toHaveBeenCalledTimes(2);
        expect(onStartReached).toHaveBeenCalledTimes(1);

        handler?.(scrollEvent(500));
        handler?.(scrollEvent(0));
        expect(onStartReached).toHaveBeenCalledTimes(2);
    });
});
