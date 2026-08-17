import { describe, expect, it } from 'vitest';

import {
    ITEM_GROUP_COLUMN_GAP_PX,
    ITEM_GROUP_COLUMN_MIN_WIDTH_PX,
    resolveItemGroupColumnCountForWidth,
} from './itemGroupColumnLayout';

describe('resolveItemGroupColumnCountForWidth', () => {
    it('keeps a single column when the width cannot fit two minimum-width columns', () => {
        // Phone-width content: 2 columns would need 2*320 + 12 = 652px.
        expect(resolveItemGroupColumnCountForWidth({
            availableWidthPx: 651,
            requestedColumns: 2,
        })).toBe(1);
    });

    it('opens the requested columns once every column clears the minimum width', () => {
        expect(resolveItemGroupColumnCountForWidth({
            availableWidthPx: 652,
            requestedColumns: 2,
        })).toBe(2);
    });

    it('caps the count at what actually fits rather than honouring the request blindly', () => {
        // 3 columns would need 3*320 + 2*12 = 984px; 800px only fits 2.
        expect(resolveItemGroupColumnCountForWidth({
            availableWidthPx: 800,
            requestedColumns: 3,
        })).toBe(2);
    });

    it('respects a caller-supplied minimum column width', () => {
        expect(resolveItemGroupColumnCountForWidth({
            availableWidthPx: 700,
            requestedColumns: 2,
            minColumnWidthPx: 400,
        })).toBe(1);
    });

    it('never returns less than one column for degenerate widths', () => {
        for (const availableWidthPx of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(resolveItemGroupColumnCountForWidth({
                availableWidthPx,
                requestedColumns: 2,
            })).toBeGreaterThanOrEqual(1);
        }
    });

    it('exposes the shared minimum width and gap it measures against', () => {
        expect(ITEM_GROUP_COLUMN_MIN_WIDTH_PX).toBeGreaterThan(0);
        expect(ITEM_GROUP_COLUMN_GAP_PX).toBeGreaterThan(0);
    });
});
