import { describe, expect, it } from 'vitest';

import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_COLLECTION_RAIL_WIDTH_PX } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { SESSION_LIST_ROW_IDENTITY_METRICS, SESSION_LIST_ROW_WIDTH_METRICS, resolveSessionListRowTitleTextMetrics } from '@/components/sessions/shell/resolveSessionListDensityViewState';
import { resolveFoldAlignedSidebarWidthPx, resolveSidebarDockMaxWidthPx, SIDEBAR_DOCK_MIN_WIDTH_PX } from './sidebarSizing';
import { BUILTIN_COLUMN_MINIMUM_WIDTH_PX } from './appRail/appShellColumnSizing';
import { APP_RAIL_WIDTH_PX } from './appRail/appRailMetrics';
import type { WindowFoldMetrics } from '@/utils/platform/windowFoldMetrics';

describe('sidebar content minimum', () => {
    it('keeps a sixteen-character session title beside identity and compact trailing controls at every density', () => {
        for (const density of ['default', 'compact', 'minimal'] as const) {
            const metrics = SESSION_LIST_ROW_WIDTH_METRICS;
            const titlePx = metrics.titleMinCharacters * resolveSessionListRowTitleTextMetrics({ density, readableNativePhoneMinimal: false }).fontSize / 2;
            const demand = 2 * HAPPIER_COLLECTION_LIST_METRICS.rowInset + 2 * metrics.borderPx + 2 * metrics[density].paddingPx
                + SESSION_LIST_ROW_IDENTITY_METRICS[density].slotSize + metrics[density].contentMarginPx + titlePx + metrics.trailingMarginPx + metrics.trailingMinPx;
            expect(SIDEBAR_DOCK_MIN_WIDTH_PX).toBeGreaterThanOrEqual(demand);
        }
        expect(SIDEBAR_DOCK_MIN_WIDTH_PX).toBeLessThanOrEqual(HAPPIER_COLLECTION_RAIL_WIDTH_PX.standard);
        for (const headerDemand of Object.values(BUILTIN_COLUMN_MINIMUM_WIDTH_PX)) {
            expect(SIDEBAR_DOCK_MIN_WIDTH_PX).toBeGreaterThanOrEqual(headerDemand);
        }
    });
});

describe('resolveSidebarDockMaxWidthPx', () => {
    it('falls back to a safe max width when windowWidthPx is invalid', () => {
        expect(resolveSidebarDockMaxWidthPx(NaN)).toBeGreaterThanOrEqual(480);
        expect(resolveSidebarDockMaxWidthPx(0)).toBeGreaterThanOrEqual(480);
        expect(resolveSidebarDockMaxWidthPx(-10)).toBeGreaterThanOrEqual(480);
    });

    it('scales up max width on larger windows with a cap', () => {
        expect(resolveSidebarDockMaxWidthPx(800)).toBe(480);
        expect(resolveSidebarDockMaxWidthPx(1200)).toBe(600);
        expect(resolveSidebarDockMaxWidthPx(2000)).toBe(720);
    });
});

describe('resolveFoldAlignedSidebarWidthPx', () => {
    const windowMetrics = (divisions: WindowFoldMetrics['divisions']): WindowFoldMetrics => ({
        width: 1000,
        height: 800,
        hasFoldDivision: divisions.length > 0,
        verticalBarEdge: null,
        divisions,
    });
    const sidebarStartPx = 84 + APP_RAIL_WIDTH_PX;
    const resolveAtCrease = (x: number) => resolveFoldAlignedSidebarWidthPx({
        foldMetrics: windowMetrics([{ x, y: 0, width: 0, height: 800 }]),
        sidebarStartPx,
    });

    it('ends the whole rail and navigation column at the crease after the leading safe inset', () => {
        expect(resolveAtCrease(500)).toBe(500 - sidebarStartPx);
    });

    it('accepts the evolved content minimum and dock maximum, falling back outside either bound', () => {
        const max = resolveSidebarDockMaxWidthPx(1000);
        expect(resolveAtCrease(sidebarStartPx + SIDEBAR_DOCK_MIN_WIDTH_PX - 1)).toBeNull();
        expect(resolveAtCrease(sidebarStartPx + SIDEBAR_DOCK_MIN_WIDTH_PX)).toBe(SIDEBAR_DOCK_MIN_WIDTH_PX);
        expect(resolveAtCrease(sidebarStartPx + max)).toBe(max);
        expect(resolveAtCrease(sidebarStartPx + max + 1)).toBeNull();
    });

    it('falls back when there is no single vertical full-height division', () => {
        expect(resolveFoldAlignedSidebarWidthPx({ foldMetrics: null, sidebarStartPx })).toBeNull();
        for (const divisions of [
            [],
            [{ x: 0, y: 400, width: 1000, height: 0 }],
            [{ x: 500, y: 100, width: 0, height: 700 }],
            [{ x: 500, y: 0, width: 0, height: 700 }],
            [{ x: 500, y: 0, width: 0, height: 800 }, { x: 700, y: 0, width: 0, height: 800 }],
        ]) {
            expect(resolveFoldAlignedSidebarWidthPx({ foldMetrics: windowMetrics(divisions), sidebarStartPx })).toBeNull();
        }
    });

    it('compares native floating point height at whole-point precision', () => {
        expect(resolveFoldAlignedSidebarWidthPx({
            foldMetrics: windowMetrics([{ x: 500, y: 0.1, width: 0, height: 799.8 }]),
            sidebarStartPx,
        })).toBe(500 - sidebarStartPx);
    });
});
