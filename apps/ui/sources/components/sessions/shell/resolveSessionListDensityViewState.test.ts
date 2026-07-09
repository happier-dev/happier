import { describe, expect, it } from 'vitest';

import {
    SESSION_LIST_ROW_HEIGHT_COMPACT,
    SESSION_LIST_ROW_HEIGHT_DEFAULT,
    SESSION_LIST_ROW_HEIGHT_MINIMAL,
    SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_PHONE,
} from './sessionListRowHeights';
import { resolveSessionListDensityViewState } from './resolveSessionListDensityViewState';

describe('resolveSessionListDensityViewState', () => {
    it('uses the default row height and expanded flags for detailed or unknown density values', () => {
        const first = resolveSessionListDensityViewState('detailed');
        const second = resolveSessionListDensityViewState('comfortable');
        const third = resolveSessionListDensityViewState(null);

        expect(first).toEqual({
            compact: false,
            compactMinimal: false,
            rowHeight: SESSION_LIST_ROW_HEIGHT_DEFAULT,
        });
        expect(first).toBe(second);
        expect(second).toBe(third);
    });

    it('maps cozy density to compact rows without minimal layout', () => {
        const first = resolveSessionListDensityViewState('cozy');
        const second = resolveSessionListDensityViewState('cozy');

        expect(first).toEqual({
            compact: true,
            compactMinimal: false,
            rowHeight: SESSION_LIST_ROW_HEIGHT_COMPACT,
        });
        expect(first).toBe(second);
    });

    it('maps narrow density to the minimal row layout', () => {
        const first = resolveSessionListDensityViewState('narrow');
        const second = resolveSessionListDensityViewState('narrow');

        expect(first).toEqual({
            compact: true,
            compactMinimal: true,
            rowHeight: SESSION_LIST_ROW_HEIGHT_MINIMAL,
        });
        expect(first).toBe(second);
    });

    it('keeps native phone narrow rows readable without changing web/tablet row height', () => {
        expect(resolveSessionListDensityViewState('narrow', {
            isTablet: false,
            platform: 'ios',
        })).toEqual({
            compact: true,
            compactMinimal: true,
            rowHeight: SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_PHONE,
        });

        expect(resolveSessionListDensityViewState('narrow', {
            isTablet: false,
            platform: 'web',
        })).toEqual({
            compact: true,
            compactMinimal: true,
            rowHeight: SESSION_LIST_ROW_HEIGHT_MINIMAL,
        });

        expect(resolveSessionListDensityViewState('narrow', {
            isTablet: true,
            platform: 'ios',
        })).toEqual({
            compact: true,
            compactMinimal: true,
            rowHeight: SESSION_LIST_ROW_HEIGHT_MINIMAL,
        });
    });
});
