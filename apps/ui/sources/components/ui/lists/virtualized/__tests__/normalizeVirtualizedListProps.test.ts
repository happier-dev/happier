import { describe, expect, it } from 'vitest';

import { normalizeVirtualizedListProps } from '../normalizeVirtualizedListProps';
import type { VirtualizedListProps } from '../virtualizedListTypes';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

type Row = { id: string };

function baseProps(overrides: Partial<VirtualizedListProps<Row>> = {}): VirtualizedListProps<Row> {
    return {
        data: [{ id: 'a' }],
        renderItem: () => null,
        keyExtractor: (item) => item.id,
        ...overrides,
    };
}

describe('normalizeVirtualizedListProps', () => {
    it('delivers the first handled row tap with the keyboard open unless the caller opts out', () => {
        expect(normalizeVirtualizedListProps(baseProps()).shared.keyboardShouldPersistTaps).toBe('handled');
        expect(normalizeVirtualizedListProps(baseProps({ keyboardShouldPersistTaps: 'never' })).shared.keyboardShouldPersistTaps).toBe('never');
    });
    it('places a row nobody sized at the collection row height, not the backend default slot', () => {
        // Legend places an unmeasured cell at its estimate; its own default (100) spaced arriving rows far apart.
        expect(normalizeVirtualizedListProps(baseProps()).virtualization.estimatedItemSize)
            .toBe(HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight);
        expect(normalizeVirtualizedListProps(baseProps({ estimatedItemSize: 60 })).virtualization.estimatedItemSize).toBe(60);
    });

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
