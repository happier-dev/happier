import { describe, expect, it } from 'vitest';

import {
    SESSION_LIST_ROW_HEIGHT_COMPACT,
    SESSION_LIST_ROW_HEIGHT_DEFAULT,
    SESSION_LIST_ROW_HEIGHT_MINIMAL,
    SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_PHONE,
} from './sessionListRowHeights';
import { resolveSessionListDensityViewState } from './resolveSessionListDensityViewState';
import { SessionListRowSubtitle, SessionListRowTitle } from './row/SessionListRowPresentation';

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

    it('keeps native and web phone narrow rows readable without changing tablet row height', () => {
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
            windowWidth: 390,
        })).toEqual({
            compact: true,
            compactMinimal: true,
            rowHeight: SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_PHONE,
        });

        expect(resolveSessionListDensityViewState('narrow', {
            isTablet: false,
            platform: 'web',
            windowWidth: 800,
        }).rowHeight).toBe(SESSION_LIST_ROW_HEIGHT_MINIMAL);

        expect(resolveSessionListDensityViewState('narrow', {
            isTablet: true,
            platform: 'ios',
        })).toEqual({
            compact: true,
            compactMinimal: true,
            rowHeight: SESSION_LIST_ROW_HEIGHT_MINIMAL,
        });
    });

    it('raises the row floor for large UI text without changing the density choice', () => {
        expect(resolveSessionListDensityViewState('detailed', {
            isTablet: false,
            platform: 'web',
            uiFontScale: 1.3,
        }).rowHeight).toBeGreaterThan(SESSION_LIST_ROW_HEIGHT_DEFAULT);
        expect(resolveSessionListDensityViewState('detailed', {
            isTablet: false,
            platform: 'web',
            uiFontScale: 1,
        }).rowHeight).toBe(SESSION_LIST_ROW_HEIGHT_DEFAULT);
    });

    it('allows long localized row title and context lines to reflow at large text scale', () => {
        const title = SessionListRowTitle({
            density: 'default',
            textScale: 1.3,
            children: 'A long localized session title that must remain readable',
        });
        const subtitle = SessionListRowSubtitle({
            density: 'default',
            textScale: 1.3,
            children: 'Home · Team · Project · a duplicated context label',
        });

        expect(title).toHaveProperty('props.numberOfLines', 2);
        expect(subtitle).toHaveProperty('props.numberOfLines', 2);
    });
});
