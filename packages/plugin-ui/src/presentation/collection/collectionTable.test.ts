import { describe, expect, it } from 'vitest';

import {
  HAPPIER_COLLECTION_TRANSITION_TIMELINE,
  planHappierCollectionTransitionOffsets,
  resolveHappierCollectionComposition,
  resolveHappierCollectionGridGeometry,
  resolveHappierCollectionTableColumns,
  resolveHappierCollectionTransitionPhase,
} from './collectionTable.js';
import { resolveHappierCollectionKeyCommand } from './collectionModel.js';

const columns = [
  { key: 'title', minWidth: 240, priority: Number.POSITIVE_INFINITY, flex: true },
  { key: 'where', minWidth: 150, priority: 4 },
  { key: 'reason', minWidth: 170, priority: 5 },
  { key: 'signal', minWidth: 120, priority: 2 },
  { key: 'agent', minWidth: 150, priority: 3 },
  { key: 'age', minWidth: 46, priority: 6 },
] as const;

describe('table columns', () => {
  it('keeps every column, in declared order, while they all fit', () => {
    const visible = resolveHappierCollectionTableColumns({ columns, availableWidth: 2000, gap: 12 });
    expect(visible.map((column) => column.key)).toEqual(['title', 'where', 'reason', 'signal', 'agent', 'age']);
  });

  it('drops the lowest priority first as the width narrows, never by position', () => {
    // 240+150+170+120+150+46 = 876 plus 5 gaps of 12 = 936.
    const justUnder = resolveHappierCollectionTableColumns({ columns, availableWidth: 935, gap: 12 });
    expect(justUnder.map((column) => column.key)).toEqual(['title', 'where', 'reason', 'agent', 'age']);
    const narrower = resolveHappierCollectionTableColumns({ columns, availableWidth: 700, gap: 12 });
    expect(narrower.map((column) => column.key)).toEqual(['title', 'where', 'reason', 'age']);
  });

  it('never drops the title, even when nothing else fits', () => {
    const visible = resolveHappierCollectionTableColumns({ columns, availableWidth: 100, gap: 12 });
    expect(visible.map((column) => column.key)).toEqual(['title']);
  });
});

describe('detail auto composition', () => {
  const wide = { presentation: 'table' as const, detail: 'auto' as const, splitFits: true };
  const narrow = { presentation: 'table' as const, detail: 'auto' as const, splitFits: false };

  it('rests as the full-width table with nothing open, and becomes list + detail when a row opens', () => {
    expect(resolveHappierCollectionComposition({ ...wide, open: false })).toBe('table');
    expect(resolveHappierCollectionComposition({ ...wide, open: true })).toBe('split');
  });

  it('never shows the table where both panes do not fit: the list is the page and the detail pushes', () => {
    expect(resolveHappierCollectionComposition({ ...narrow, open: false })).toBe('list');
    expect(resolveHappierCollectionComposition({ ...narrow, open: true })).toBe('detail');
  });

  it('is the narrow composition before the first measurement, so it never claims a width it has not seen', () => {
    expect(resolveHappierCollectionComposition({ ...wide, splitFits: null, open: true })).toBe('detail');
    expect(resolveHappierCollectionComposition({ ...wide, splitFits: null, open: false })).toBe('list');
  });

  it('opens nothing with detail none', () => {
    expect(resolveHappierCollectionComposition({ ...wide, detail: 'none', open: true })).toBe('table');
  });

  it('keeps a board or a grid on screen, and pushes its detail where the host has no pane beside the page', () => {
    for (const presentation of ['board', 'grid'] as const) {
      expect(resolveHappierCollectionComposition({ ...wide, presentation, open: false })).toBe('cards');
      expect(resolveHappierCollectionComposition({ ...wide, presentation, open: true })).toBe('detail');
      expect(resolveHappierCollectionComposition({ ...narrow, presentation, open: false })).toBe('cards');
      expect(resolveHappierCollectionComposition({ ...narrow, presentation, open: true })).toBe('detail');
      expect(resolveHappierCollectionComposition({ ...wide, presentation, detail: 'none', open: true })).toBe('cards');
    }
  });

  it('with the host details pane, opening an item keeps the resting view: the detail opens in the pane', () => {
    const pane = { detail: 'auto' as const, pane: true };
    for (const presentation of ['board', 'grid'] as const) {
      expect(resolveHappierCollectionComposition({ ...pane, presentation, splitFits: true, tableFits: true, open: true })).toBe('cards');
    }
    // Beside the open pane the narrowed page reads as the two-line list (the lab's Desk list), never a
    // squeezed table; at rest the table stands wherever its list minimum fits.
    expect(resolveHappierCollectionComposition({ ...pane, presentation: 'table', splitFits: true, tableFits: true, open: true })).toBe('list');
    expect(resolveHappierCollectionComposition({ ...pane, presentation: 'table', splitFits: false, tableFits: true, open: true })).toBe('list');
    expect(resolveHappierCollectionComposition({ ...pane, presentation: 'table', splitFits: false, tableFits: true, open: false })).toBe('table');
    expect(resolveHappierCollectionComposition({ ...pane, presentation: 'table', splitFits: false, tableFits: false, open: true })).toBe('list');
    expect(resolveHappierCollectionComposition({ ...pane, presentation: 'list', splitFits: true, tableFits: true, open: true })).toBe('list');
    // Never a split and never a pushed detail while the pane is beside the page.
    expect(resolveHappierCollectionComposition({ ...pane, presentation: 'table', splitFits: null, tableFits: null, open: true })).toBe('list');
  });

  it('in a pane host whose pane is not beside the page, pushes the detail however wide the page, never splitting in it', () => {
    // A phone, or side panes turned off: the page's pane host still decides where details go.
    const off = { detail: 'auto' as const, pane: false, paneHost: true };
    expect(resolveHappierCollectionComposition({ ...off, presentation: 'table', splitFits: true, tableFits: true, open: true })).toBe('detail');
    // Resting, the table stands wherever its own list minimum fits: no detail minimum is reserved beside it.
    expect(resolveHappierCollectionComposition({ ...off, presentation: 'table', splitFits: false, tableFits: true, open: false })).toBe('table');
    expect(resolveHappierCollectionComposition({ ...off, presentation: 'table', splitFits: false, tableFits: false, open: false })).toBe('list');
    expect(resolveHappierCollectionComposition({ ...off, presentation: 'table', splitFits: true, tableFits: true, detail: 'none', open: true })).toBe('table');
    for (const presentation of ['board', 'grid'] as const) {
      expect(resolveHappierCollectionComposition({ ...off, presentation, splitFits: true, tableFits: true, open: true })).toBe('detail');
    }
  });
});

describe('grid geometry', () => {
  it('fits as many columns as the minimum card width allows, sharing the width equally', () => {
    const wideGrid = resolveHappierCollectionGridGeometry({ width: 1200, minCardWidth: 280, gap: 16 });
    // 4 × 280 + 3 × 16 = 1168 fits; 5 would need 1464.
    expect(wideGrid.columns).toBe(4);
    expect(wideGrid.cardWidth).toBe((1200 - 3 * 16) / 4);
  });

  it('is one full-width column on a phone, and never zero columns', () => {
    expect(resolveHappierCollectionGridGeometry({ width: 358, minCardWidth: 280, gap: 16 })).toEqual({ columns: 1, cardWidth: 358 });
    expect(resolveHappierCollectionGridGeometry({ width: 120, minCardWidth: 280, gap: 16 }).columns).toBe(1);
  });
});

describe('the table ⇄ split timeline', () => {
  it('fades the other columns, moves the rows, then brings in the detail and the second lines, in that order', () => {
    const early = resolveHappierCollectionTransitionPhase(0.1);
    expect(early.columns).toBeGreaterThan(0);
    expect(early.columns).toBeLessThan(1);
    expect(early.travel).toBe(0);
    expect(early.detail).toBe(0);
    const late = resolveHappierCollectionTransitionPhase(0.75);
    expect(late.columns).toBe(0);
    expect(late.travel).toBeGreaterThan(0);
    expect(late.detail).toBeGreaterThan(0);
    expect(late.secondLine).toBeGreaterThan(0);
    expect(resolveHappierCollectionTransitionPhase(1)).toEqual({ columns: 0, travel: 1, detail: 1, secondLine: 1 });
    expect(resolveHappierCollectionTransitionPhase(0)).toEqual({ columns: 1, travel: 0, detail: 0, secondLine: 0 });
  });

  it('is the spec timeline: 0–120 ms columns, 60–320 ms travel, 120–320 ms detail, 160–320 ms second line', () => {
    const at = (ms: number) => ms / 320;
    expect(HAPPIER_COLLECTION_TRANSITION_TIMELINE.columns).toEqual([at(0), at(120)]);
    expect(HAPPIER_COLLECTION_TRANSITION_TIMELINE.travel).toEqual([at(60), at(320)]);
    expect(HAPPIER_COLLECTION_TRANSITION_TIMELINE.detail).toEqual([at(120), at(320)]);
    expect(HAPPIER_COLLECTION_TRANSITION_TIMELINE.secondLine).toEqual([at(160), at(320)]);
  });
});

describe('the shared-element travel', () => {
  // A group header then three rows: 34 high in both geometries, rows 42 in the table and 62 in the list.
  const cells = [
    { key: 'g', table: 34, list: 34 },
    { key: 'a', table: 42, list: 62 },
    { key: 'b', table: 42, list: 62 },
    { key: 'c', table: 42, list: 62 },
  ];

  it('anchors the opened row: it keeps its screen y and every other visible row travels from its table place', () => {
    // b's table top is 34 + 2 × 42 = 118 and its list top 34 + 2 × 62 = 158.
    const aligned = [
      { key: 'g', table: 34, list: 34, header: true },
      { key: 'a', table: 42, list: 62 },
      { key: 'x', table: 42, list: 62 },
      { key: 'b', table: 42, list: 62 },
      { key: 'c', table: 42, list: 62 },
    ];
    const plan = planHappierCollectionTransitionOffsets({
      cells: aligned, anchorKey: 'b', scroll: { geometry: 'table', offset: 22 }, viewportHeight: 800,
    });
    // At table scroll 22, b sits at screen y 96, so the list scrolls 62 to keep it there, which
    // also puts x's top right below the sticky band (62 + 34 = 96).
    expect(plan.listScroll).toBe(62);
    expect(plan.offsets.get('b')).toBe(0);
    // c: table screen y 160 - 22 = 138, list screen y 220 - 62 = 158, so it starts 20 higher.
    expect(plan.offsets.get('c')).toBe(-20);
  });

  it('never leaves a row half under the sticky group band: the list snaps to the nearest whole row', () => {
    const plan = planHappierCollectionTransitionOffsets({
      cells: cells.map((cell) => (cell.key === 'g' ? { ...cell, header: true } : cell)),
      anchorKey: 'b',
      scroll: { geometry: 'table', offset: 0 },
      viewportHeight: 800,
    });
    // Keeping b's screen y exactly (76) would scroll the list 20, leaving a 20 points under the 34-point band.
    // The nearest whole-row offset is 0: a sits right below the band and b moves 20 down.
    expect(plan.listScroll).toBe(0);
    expect(plan.offsets.get('b')).toBe(-20);
    expect(plan.offsets.get('a')).toBe(0);
  });

  it('snaps the table it restores the same way on close', () => {
    const tall = [
      { key: 'g', table: 34, list: 34, header: true },
      ...Array.from({ length: 12 }, (_, index) => ({ key: `r${index}`, table: 42, list: 62 })),
    ];
    // r6's list top is 34 + 6 × 62 = 406; at list scroll 300 it shows at 106. Its table top is 286, so the exact
    // table scroll would be 180, putting 180 + 34 = 214 (r4 spans 202–244) under the band edge.
    const plan = planHappierCollectionTransitionOffsets({
      cells: tall, anchorKey: 'r6', scroll: { geometry: 'list', offset: 300 }, viewportHeight: 600,
    });
    // Whole rows: r4's top under the band (202 - 34 = 168) is 12 away; r5's (244 - 34 = 210) is 30 away.
    expect(plan.tableScroll).toBe(168);
    expect(plan.listScroll).toBe(300);
  });

  it('restores the table scroll that keeps the open row where the list shows it, on close', () => {
    const plan = planHappierCollectionTransitionOffsets({
      cells, anchorKey: 'b', scroll: { geometry: 'list', offset: 20 }, viewportHeight: 800,
    });
    expect(plan.tableScroll).toBe(0);
    expect(plan.offsets.get('b')).toBe(0);
  });

  it('animates only the rows visible in either geometry', () => {
    const many = [
      { key: 'g', table: 34, list: 34 },
      ...Array.from({ length: 40 }, (_, index) => ({ key: `r${index}`, table: 42, list: 62 })),
    ];
    const plan = planHappierCollectionTransitionOffsets({
      cells: many, anchorKey: 'r0', scroll: { geometry: 'table', offset: 0 }, viewportHeight: 200,
    });
    expect(plan.offsets.has('r2')).toBe(true);
    expect(plan.offsets.has('r30')).toBe(false);
  });

  it('never scrolls above the top', () => {
    const plan = planHappierCollectionTransitionOffsets({
      cells, anchorKey: 'a', scroll: { geometry: 'list', offset: 0 }, viewportHeight: 800,
    });
    expect(plan.tableScroll).toBe(0);
  });
});

describe('peek availability', () => {
  it('exists only in the table composition', () => {
    expect(resolveHappierCollectionComposition({ presentation: 'table', detail: 'auto', splitFits: true, open: false }))
      .toBe('table');
    // The Collection passes `expandable` only while it is the table, so space never peeks in split or on a phone.
    const base = { keys: ['a', 'b'], focusKey: 'a', openKey: null, rtl: false, key: ' ' };
    expect(resolveHappierCollectionKeyCommand({ ...base, expandable: true })).toEqual({ kind: 'toggleExpanded', key: 'a' });
    expect(resolveHappierCollectionKeyCommand({ ...base, expandable: false })).toBeNull();
  });
});
