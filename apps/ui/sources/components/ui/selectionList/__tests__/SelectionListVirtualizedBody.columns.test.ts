/**
 * Lane G5 — grouping virtualized option rows into visual grid rows.
 *
 * The grouping happens ABOVE the virtualized backend on purpose: the neutral
 * virtualized-list seam excludes backend-only escape hatches such as
 * `numColumns` / `overrideItemLayout`, and grouping keeps `estimatedItemSize`
 * meaningful because one virtualized item is one visual row.
 */

import { describe, expect, it } from 'vitest';

import {
    flattenRenderPlanForVirtualizedList,
    groupVirtualizedItemsIntoColumnRows,
    type SelectionListBodyVirtualizedItem,
} from '../SelectionListVirtualizedBody';
import type { SectionRenderPlan } from '../SelectionListRenderPlan';

function makeSection(id: string, optionCount: number): SectionRenderPlan {
    return {
        id,
        title: id.toUpperCase(),
        options: Array.from({ length: optionCount }, (_, index) => ({
            id: `${id}-${index}`,
            label: `${id} ${index}`,
        })),
    };
}

function describeItems(
    items: ReadonlyArray<SelectionListBodyVirtualizedItem>,
): ReadonlyArray<string> {
    return items.map((item) => {
        if (item.kind === 'option') return `option:${item.option.id}`;
        if (item.kind === 'option-row') {
            return `row[${item.options.map((cell) => cell.option.id).join(',')}]`;
        }
        return item.kind;
    });
}

describe('groupVirtualizedItemsIntoColumnRows', () => {
    it('returns the very same array at one column — not a rebuilt equivalent', () => {
        const items = flattenRenderPlanForVirtualizedList([makeSection('models', 4)]);
        expect(groupVirtualizedItemsIntoColumnRows(items, 1)).toBe(items);
        expect(groupVirtualizedItemsIntoColumnRows(items, 0)).toBe(items);
        expect(groupVirtualizedItemsIntoColumnRows(items, Number.NaN)).toBe(items);
    });

    it('folds consecutive options into rows of columnCount, row-major', () => {
        const items = flattenRenderPlanForVirtualizedList([makeSection('models', 5)]);
        expect(describeItems(groupVirtualizedItemsIntoColumnRows(items, 2))).toEqual([
            'section-header',
            'row[models-0,models-1]',
            'row[models-2,models-3]',
            'row[models-4]',
        ]);
    });

    it('keeps headers full-width and never spans a row across two sections', () => {
        const items = flattenRenderPlanForVirtualizedList([
            makeSection('fast', 3),
            makeSection('deep', 2),
        ]);
        expect(describeItems(groupVirtualizedItemsIntoColumnRows(items, 2))).toEqual([
            'section-header',
            'row[fast-0,fast-1]',
            'row[fast-2]',
            'section-header',
            'row[deep-0,deep-1]',
        ]);
    });

    it('keeps skeleton, error and hint rows as their own full-width items', () => {
        const items = flattenRenderPlanForVirtualizedList([
            { id: 'loading', dynamicState: 'loading', skeletonRowCount: 2, options: [] },
            { id: 'broken', dynamicState: 'error', options: [] },
            { id: 'nothing', dynamicState: 'empty', hint: 'No matches', options: [] },
        ]);
        expect(describeItems(groupVirtualizedItemsIntoColumnRows(items, 2))).toEqual([
            'section-header',
            'loading-skeleton',
            'loading-skeleton',
            'section-header',
            'error',
            'section-header',
            'empty-hint',
        ]);
    });

    it('breaks the run at the skeleton boundary when stale options follow', () => {
        const stale: SectionRenderPlan = {
            id: 'models',
            dynamicState: 'loading',
            isStale: true,
            skeletonRowCount: 1,
            options: [
                { id: 'm-0', label: 'M0' },
                { id: 'm-1', label: 'M1' },
                { id: 'm-2', label: 'M2' },
            ],
        };
        expect(describeItems(groupVirtualizedItemsIntoColumnRows(
            flattenRenderPlanForVirtualizedList([stale]),
            2,
        ))).toEqual([
            'section-header',
            'loading-skeleton',
            'row[m-0,m-1]',
            'row[m-2]',
        ]);
    });

    it('gives each visual row a stable key derived from its leading cell', () => {
        const grouped = groupVirtualizedItemsIntoColumnRows(
            flattenRenderPlanForVirtualizedList([makeSection('models', 4)]),
            2,
        );
        const rowKeys = grouped
            .filter((item) => item.kind === 'option-row')
            .map((item) => item.rowKey);
        expect(new Set(rowKeys).size).toBe(rowKeys.length);
        expect(rowKeys).toEqual([
            'models::option::models-0::row',
            'models::option::models-2::row',
        ]);
    });

    it('preserves per-cell staleness so a refetching section still dims correctly', () => {
        const grouped = groupVirtualizedItemsIntoColumnRows(
            flattenRenderPlanForVirtualizedList([{
                id: 'models',
                dynamicState: 'error',
                options: [
                    { id: 'm-0', label: 'M0' },
                    { id: 'm-1', label: 'M1' },
                ],
            }]),
            2,
        );
        const row = grouped.find((item) => item.kind === 'option-row');
        expect(row?.kind).toBe('option-row');
        if (row?.kind !== 'option-row') throw new Error('expected an option-row');
        expect(row.options.map((cell) => cell.isStale)).toEqual([true, true]);
    });
});
