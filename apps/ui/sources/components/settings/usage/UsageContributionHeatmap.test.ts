import { describe, expect, it } from 'vitest';

import { resolveHorizontalChartInitialOffset } from '@/components/ui/charts';

import { buildDayStrip, buildHeatmapGrid, resolveFirstFullyVisibleColumn } from './UsageContributionHeatmap';

// Wed 2024-04-24 UTC noon — deterministic anchor.
const NOW = Date.UTC(2024, 3, 24, 12, 0, 0);
const DAY = 86_400_000;

describe('buildHeatmapGrid', () => {
    it('lays out `weeks` columns of 7 weekday rows ending on the current week', () => {
        const grid = buildHeatmapGrid([], NOW, 'daily', 4);
        expect(grid.columns).toHaveLength(4);
        for (const column of grid.columns) {
            expect(column.cells).toHaveLength(7);
        }
        // Last column contains today and marks days after today out of range.
        const lastColumn = grid.columns[grid.columns.length - 1]!;
        const todayIso = new Date(Date.UTC(2024, 3, 24)).toISOString().slice(0, 10);
        const todayCell = lastColumn.cells.find((cell) => cell.isoDate === todayIso);
        expect(todayCell?.inRange).toBe(true);
        // 2024-04-24 is a Wednesday (row 3); Thu–Sat are in the future.
        expect(lastColumn.cells[4]?.inRange).toBe(false);
    });

    it('daily mode uses each day own event count', () => {
        const iso = new Date(NOW - 2 * DAY).toISOString().slice(0, 10);
        const grid = buildHeatmapGrid([{ date: iso, eventCount: 7 }], NOW, 'daily', 4);
        const cell = grid.columns.flatMap((column) => column.cells).find((c) => c.isoDate === iso);
        expect(cell?.value).toBe(7);
    });

    it('weekly mode gives every in-range cell of a column the week total', () => {
        const isoA = new Date(NOW - 1 * DAY).toISOString().slice(0, 10);
        const isoB = new Date(NOW - 2 * DAY).toISOString().slice(0, 10);
        const grid = buildHeatmapGrid(
            [{ date: isoA, eventCount: 3 }, { date: isoB, eventCount: 4 }],
            NOW,
            'weekly',
            4,
        );
        const lastColumn = grid.columns[grid.columns.length - 1]!;
        const inRangeValues = lastColumn.cells.filter((cell) => cell.inRange).map((cell) => cell.value);
        // Both days are in the current week → every in-range cell reads the total (7).
        expect(new Set(inRangeValues)).toEqual(new Set([7]));
    });

    it('cumulative mode is monotonically non-decreasing across the window', () => {
        const isoA = new Date(NOW - 8 * DAY).toISOString().slice(0, 10);
        const isoB = new Date(NOW - 2 * DAY).toISOString().slice(0, 10);
        const grid = buildHeatmapGrid(
            [{ date: isoA, eventCount: 2 }, { date: isoB, eventCount: 5 }],
            NOW,
            'cumulative',
            4,
        );
        const inRange = grid.columns.flatMap((column) => column.cells).filter((cell) => cell.inRange);
        for (let i = 1; i < inRange.length; i += 1) {
            expect(inRange[i]!.value).toBeGreaterThanOrEqual(inRange[i - 1]!.value);
        }
        expect(inRange[inRange.length - 1]!.value).toBe(7);
    });

    it('labels a column when its first day starts a new month', () => {
        const grid = buildHeatmapGrid([], NOW, 'daily', 10);
        const labelled = grid.columns.filter((column) => column.monthLabel !== null);
        expect(labelled.length).toBeGreaterThan(0);
    });

    it('D-R3-1 regression: the rolling window includes the current month and ends at today (today = last in-range cell)', () => {
        const grid = buildHeatmapGrid([], NOW, 'daily');
        const inRange = grid.columns.flatMap((column) => column.cells).filter((cell) => cell.inRange);
        const todayIso = new Date(Date.UTC(2024, 3, 24)).toISOString().slice(0, 10);
        // Today is the LAST in-range cell of the whole grid — nothing beyond it,
        // nothing missing before it.
        expect(inRange[inRange.length - 1]?.isoDate).toBe(todayIso);
        // The current month appears in the month axis (window may never stop
        // one-or-more months short of now).
        const labels = grid.columns.map((column) => column.monthLabel).filter((label) => label !== null);
        expect(labels).toContain('Apr');
        // Rolling 12 months: the first column starts ~52 weeks before today.
        const firstIso = grid.columns[0]!.cells[0]!.isoDate;
        expect(firstIso.slice(0, 4)).toBe('2023');
    });
});

describe('buildDayStrip', () => {
    it('produces exactly `dayCount` cells, oldest→newest, ending at today', () => {
        const strip = buildDayStrip([], NOW, 7);
        expect(strip).toHaveLength(7);
        const todayIso = new Date(Date.UTC(2024, 3, 24)).toISOString().slice(0, 10);
        expect(strip[strip.length - 1]?.isoDate).toBe(todayIso);
        expect(strip[strip.length - 1]?.isToday).toBe(true);
        expect(strip[0]?.isoDate).toBe(new Date(Date.UTC(2024, 3, 18)).toISOString().slice(0, 10));
        // Strictly ascending by day.
        for (let i = 1; i < strip.length; i += 1) {
            expect(strip[i]!.isoDate > strip[i - 1]!.isoDate).toBe(true);
        }
    });

    it('binds per-day event counts and zero-fills missing days', () => {
        const iso = new Date(NOW - 2 * DAY).toISOString().slice(0, 10);
        const strip = buildDayStrip([{ date: iso, eventCount: 9 }], NOW, 30);
        expect(strip).toHaveLength(30);
        expect(strip.find((cell) => cell.isoDate === iso)?.value).toBe(9);
        expect(strip.filter((cell) => cell.value === 0)).toHaveLength(29);
    });
});

describe('month-label culling (deterministic, no left-partial at any width, C-3)', () => {
    const STRIDE = 11 + 3; // CELL + GAP
    const grid = buildHeatmapGrid([], NOW, 'daily'); // 53 columns, real month labels
    const contentWidth = grid.columns.length * STRIDE;

    // narrow (banner pane) · medium · wide-enough-to-fit
    for (const viewportWidth of [280, 440, contentWidth + 200]) {
        it(`the leftmost rendered month label starts inside the viewport (viewport ${viewportWidth})`, () => {
            const visibleLeft = resolveHorizontalChartInitialOffset({ contentWidth, viewportWidth, columnStride: STRIDE });
            const firstVisible = resolveFirstFullyVisibleColumn(visibleLeft, STRIDE);

            const rendered = grid.columns
                .map((column, index) => ({ index, label: column.monthLabel }))
                .filter((entry) => entry.label != null && entry.index >= firstVisible);

            // A label renders → its column's LEFT edge is at/right of the visible
            // edge, so the full word is on-screen (never a clipped "Sep"→"ep").
            for (const entry of rendered) {
                expect(entry.index * STRIDE).toBeGreaterThanOrEqual(visibleLeft);
            }
            // And there IS a leftmost label to read.
            expect(rendered.length).toBeGreaterThan(0);
        });
    }

    it('shows every label when the grid fits (visibleLeft 0)', () => {
        expect(resolveFirstFullyVisibleColumn(0, STRIDE)).toBe(0);
    });

    it('actually culls the off-screen-left label columns at a narrow width', () => {
        // Narrow width that forces a positive, column-snapped offset.
        const visibleLeft = resolveHorizontalChartInitialOffset({ contentWidth, viewportWidth: 200, columnStride: STRIDE });
        expect(visibleLeft).toBeGreaterThan(0);
        const firstVisible = resolveFirstFullyVisibleColumn(visibleLeft, STRIDE);
        // The first-visible column sits exactly on the snapped boundary.
        expect(firstVisible * STRIDE).toBe(visibleLeft);
        // Culling is real: at least one labelled column before the boundary is dropped…
        const droppedLabels = grid.columns.filter((c, i) => c.monthLabel != null && i < firstVisible);
        expect(droppedLabels.length).toBeGreaterThan(0);
        // …and every dropped column genuinely starts left of the viewport edge.
        for (let i = 0; i < firstVisible; i += 1) {
            expect(i * STRIDE).toBeLessThan(visibleLeft);
        }
    });
});
