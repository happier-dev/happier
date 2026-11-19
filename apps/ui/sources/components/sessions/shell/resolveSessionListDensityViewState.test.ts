import { describe, expect, it } from 'vitest';

import { HAPPIER_COLLECTION_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';

// Lines 3 and 2 estimate the one-line row plus one detail line (lab ideas-1118-shell scene 7); rows are measured once drawn.
const LINED_ROW_ESTIMATE = HAPPIER_COLLECTION_ROW_METRICS.height.compact
    + HAPPIER_COLLECTION_ROW_METRICS.detailLine.minHeight + HAPPIER_COLLECTION_ROW_METRICS.detailLine.gap;
const SESSION_LIST_ROW_HEIGHT_DEFAULT = LINED_ROW_ESTIMATE;
const SESSION_LIST_ROW_HEIGHT_COMPACT = LINED_ROW_ESTIMATE;
const SESSION_LIST_ROW_HEIGHT_MINIMAL = HAPPIER_COLLECTION_ROW_METRICS.height.compact;
const SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_PHONE = HAPPIER_COLLECTION_ROW_METRICS.height.touchCompact;
import { resolveSessionListDensityViewState } from './resolveSessionListDensityViewState';
import { CollectionRowLine as SessionListRowSubtitle, CollectionRowTitle as SessionListRowTitle } from '@/components/ui/lists/collection/CollectionRowContent';

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
            density: 'detailed',
            textScale: 1.3,
            children: 'A long localized session title that must remain readable',
        });
        const subtitle = SessionListRowSubtitle({
            density: 'detailed',
            textScale: 1.3,
            children: 'Home · Team · Project · a duplicated context label',
        });

        expect(title).toHaveProperty('props.numberOfLines', 2);
        expect(subtitle).toHaveProperty('props.numberOfLines', 2);
    });
});

describe('resolveSessionListItemDensity', () => {
    it('gives a minimal Drafts / Scheduled / "Show more" row the session row\'s identity gap, so its title shares their edge', async () => {
        const { resolveSessionListItemDensity } = await import('./resolveSessionListDensityViewState');
        const { ITEM_ICON_MARGIN_RIGHT } = await import('@/components/ui/lists/itemDensityMetrics');
        // Minimal session rows draw on the collection row's compact anatomy (identity slot, then contentGap).
        expect(ITEM_ICON_MARGIN_RIGHT[resolveSessionListItemDensity('minimal')])
            .toBe(HAPPIER_COLLECTION_ROW_METRICS.contentGap.compact);
    });
});
