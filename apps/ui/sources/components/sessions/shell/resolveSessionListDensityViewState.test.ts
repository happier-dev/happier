import { describe, expect, it } from 'vitest';

import {
    SESSION_LIST_ROW_HEIGHT_COMPACT,
    SESSION_LIST_ROW_HEIGHT_DEFAULT,
    SESSION_LIST_ROW_HEIGHT_MINIMAL,
} from './sessionListRowHeights';
import { resolveSessionListDensityViewState } from './resolveSessionListDensityViewState';

describe('resolveSessionListDensityViewState', () => {
    it('uses the default row height and expanded flags for detailed or unknown density values', () => {
        expect(resolveSessionListDensityViewState('detailed')).toEqual({
            compact: false,
            compactMinimal: false,
            rowHeight: SESSION_LIST_ROW_HEIGHT_DEFAULT,
        });
        expect(resolveSessionListDensityViewState('comfortable')).toEqual({
            compact: false,
            compactMinimal: false,
            rowHeight: SESSION_LIST_ROW_HEIGHT_DEFAULT,
        });
        expect(resolveSessionListDensityViewState(null)).toEqual({
            compact: false,
            compactMinimal: false,
            rowHeight: SESSION_LIST_ROW_HEIGHT_DEFAULT,
        });
    });

    it('maps cozy density to compact rows without minimal layout', () => {
        expect(resolveSessionListDensityViewState('cozy')).toEqual({
            compact: true,
            compactMinimal: false,
            rowHeight: SESSION_LIST_ROW_HEIGHT_COMPACT,
        });
    });

    it('maps narrow density to the minimal row layout', () => {
        expect(resolveSessionListDensityViewState('narrow')).toEqual({
            compact: true,
            compactMinimal: true,
            rowHeight: SESSION_LIST_ROW_HEIGHT_MINIMAL,
        });
    });
});
