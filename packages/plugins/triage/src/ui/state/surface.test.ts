import type { TriageEntryRefV1, TriageSourceInstanceIdV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
  TRIAGE_SURFACE_INITIAL_STATE_V1,
  reduceTriageSurfaceV1,
  type TriageSurfaceStateV1,
  type TriageVisibleRowV1,
} from './surface.js';

const SOURCE = { pluginId: 'happier.example.source', localId: 'example-forge' } as const;
const INSTANCE_A = '1f0d4ab7-6c4a-4f9d-9b2e-0f1a2b3c4d5e' as TriageSourceInstanceIdV1;
const INSTANCE_B = '2f0d4ab7-6c4a-4f9d-9b2e-0f1a2b3c4d5e' as TriageSourceInstanceIdV1;

function entry(entryId: string, collisionScope = 'example/repository'): TriageEntryRefV1 {
  return { source: SOURCE, kindId: 'pull-request', collisionScope, entryId };
}

function row(sectionId: string, entryId: string): TriageVisibleRowV1 {
  return { sectionId, entryRef: entry(entryId) };
}

const OPEN_ROWS: readonly TriageVisibleRowV1[] = [
  row('2-open', '11'),
  row('2-open', '12'),
  row('2-open', '13'),
];
const VISIBLE: readonly TriageVisibleRowV1[] = [
  row('1-pinned', '07'),
  ...OPEN_ROWS,
  row('3-done', '21'),
];

function focusedOn(entryId: string, sectionId = '2-open'): TriageSurfaceStateV1 {
  return reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
    kind: 'rowFocused',
    sectionId,
    entryRef: entry(entryId),
  });
}

function selectedAndFocused(): TriageSurfaceStateV1 {
  return reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
    kind: 'rowActivated',
    sectionId: '2-open',
    entryRef: entry('12'),
    sourceInstanceId: INSTANCE_A,
  });
}

describe('Triage surface reducer — focus and selection are independent cursors', () => {
  it('moves focus through the section-flattened visible order without touching selection', () => {
    const selected = selectedAndFocused();

    const moved = reduceTriageSurfaceV1(selected, {
      kind: 'focusMoved',
      movement: 'next',
      visibleOrder: VISIBLE,
    });

    expect(moved.focus).toEqual({ sectionId: '2-open', entryRef: entry('13') });
    // The whole point of the split: arrowing does not open a different detail.
    expect(moved.selection).toBe(selected.selection);
  });

  it('crosses a section boundary in flattened order rather than stopping at the section edge', () => {
    const atSectionEnd = focusedOn('13');

    const forward = reduceTriageSurfaceV1(atSectionEnd, {
      kind: 'focusMoved',
      movement: 'next',
      visibleOrder: VISIBLE,
    });
    const backward = reduceTriageSurfaceV1(focusedOn('07', '1-pinned'), {
      kind: 'focusMoved',
      movement: 'next',
      visibleOrder: VISIBLE,
    });

    expect(forward.focus).toEqual({ sectionId: '3-done', entryRef: entry('21') });
    expect(backward.focus).toEqual({ sectionId: '2-open', entryRef: entry('11') });
  });

  it('clamps at both ends and lands Home/End on the flattened extremes', () => {
    const first = reduceTriageSurfaceV1(focusedOn('07', '1-pinned'), {
      kind: 'focusMoved',
      movement: 'previous',
      visibleOrder: VISIBLE,
    });
    const last = reduceTriageSurfaceV1(focusedOn('21', '3-done'), {
      kind: 'focusMoved',
      movement: 'next',
      visibleOrder: VISIBLE,
    });

    expect(first.focus).toEqual({ sectionId: '1-pinned', entryRef: entry('07') });
    expect(last.focus).toEqual({ sectionId: '3-done', entryRef: entry('21') });
    expect(reduceTriageSurfaceV1(focusedOn('12'), {
      kind: 'focusMoved',
      movement: 'last',
      visibleOrder: VISIBLE,
    }).focus).toEqual({ sectionId: '3-done', entryRef: entry('21') });
    expect(reduceTriageSurfaceV1(focusedOn('12'), {
      kind: 'focusMoved',
      movement: 'first',
      visibleOrder: VISIBLE,
    }).focus).toEqual({ sectionId: '1-pinned', entryRef: entry('07') });
  });

  it('takes the qualified selection from the CURRENT focus when the focused row is activated', () => {
    const focused = focusedOn('13');

    const activated = reduceTriageSurfaceV1(focused, {
      kind: 'focusedRowActivated',
      sourceInstanceId: INSTANCE_B,
    });

    expect(activated.selection).toEqual({
      sectionId: '2-open',
      entryRef: entry('13'),
      sourceInstanceId: INSTANCE_B,
    });
    // Enter/Space selects; it must not additionally move the focus cursor.
    expect(activated.focus).toBe(focused.focus);
  });

  it('refuses to select from a section-header focus that names no entry', () => {
    const onHeader = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'sectionHeaderFocused',
      sectionId: '2-open',
    });

    const activated = reduceTriageSurfaceV1(onHeader, {
      kind: 'focusedRowActivated',
      sourceInstanceId: INSTANCE_A,
    });

    expect(activated).toBe(onHeader);
  });

  it('makes pointer activation move both cursors to that one row', () => {
    const activated = selectedAndFocused();

    expect(activated.focus).toEqual({ sectionId: '2-open', entryRef: entry('12') });
    expect(activated.selection).toEqual({
      sectionId: '2-open',
      entryRef: entry('12'),
      sourceInstanceId: INSTANCE_A,
    });
  });

  it('clears selection on detail dismissal while returning focus to the row that was selected', () => {
    const arrowedAway = reduceTriageSurfaceV1(selectedAndFocused(), {
      kind: 'focusMoved',
      movement: 'next',
      visibleOrder: VISIBLE,
    });

    const dismissed = reduceTriageSurfaceV1(arrowedAway, {
      kind: 'detailDismissed',
      visibleOrder: VISIBLE,
    });

    expect(dismissed.selection).toBe(null);
    expect(dismissed.focus).toEqual({ sectionId: '2-open', entryRef: entry('12') });
  });

  it('leaves focus where it is when the dismissed selection is no longer a visible row', () => {
    const withoutSelectedRow = VISIBLE.filter((visible) => visible.entryRef.entryId !== '12');
    const arrowedAway = reduceTriageSurfaceV1(selectedAndFocused(), {
      kind: 'focusMoved',
      movement: 'next',
      visibleOrder: VISIBLE,
    });

    const dismissed = reduceTriageSurfaceV1(arrowedAway, {
      kind: 'detailDismissed',
      visibleOrder: withoutSelectedRow,
    });

    expect(dismissed.selection).toBe(null);
    expect(dismissed.focus).toBe(arrowedAway.focus);
  });
});

describe('Triage surface reducer — corpus movement never steals a cursor', () => {
  it('retains both cursors when a scan, refresh or watch invalidation delivers new rows', () => {
    const selected = selectedAndFocused();

    const settled = reduceTriageSurfaceV1(selected, {
      kind: 'visibleRowsChanged',
      previousOrder: VISIBLE,
      visibleOrder: [row('2-open', '10'), ...VISIBLE],
    });

    expect(settled).toBe(selected);
  });

  it('repairs focus to the nearest surviving row when the focused row disappears', () => {
    const focused = focusedOn('12');

    const settled = reduceTriageSurfaceV1(focused, {
      kind: 'visibleRowsChanged',
      previousOrder: VISIBLE,
      visibleOrder: VISIBLE.filter((visible) => visible.entryRef.entryId !== '12'),
    });

    // '13' took '12's index, so it is the nearest surviving row in flattened order.
    expect(settled.focus).toEqual({ sectionId: '2-open', entryRef: entry('13') });
  });

  it('falls back to the section header when the focused row\'s whole section empties', () => {
    const focused = focusedOn('12');

    const settled = reduceTriageSurfaceV1(focused, {
      kind: 'visibleRowsChanged',
      previousOrder: VISIBLE,
      visibleOrder: [row('1-pinned', '07')],
    });

    expect(settled.focus).toEqual({ sectionId: '2-open', entryRef: null });
  });

  it('retains a selection whose entry disappears so the detail slot can tell the truth about it', () => {
    const selected = selectedAndFocused();

    const settled = reduceTriageSurfaceV1(selected, {
      kind: 'visibleRowsChanged',
      previousOrder: VISIBLE,
      visibleOrder: [row('1-pinned', '07')],
    });

    // Clearing here would silently swap a truthful cached/unavailable detail for
    // an empty pane the user never asked for (`core/SURFACE.md` §2.3, §3.1).
    expect(settled.selection).toEqual(selected.selection);
  });

  it('distinguishes two entries whose scope/id components a delimiter join would merge', () => {
    const left: TriageVisibleRowV1 = {
      sectionId: '2-open',
      entryRef: { source: SOURCE, kindId: 'issue', collisionScope: 'origin␟region', entryId: '42' },
    };
    const right: TriageVisibleRowV1 = {
      sectionId: '2-open',
      entryRef: { source: SOURCE, kindId: 'issue', collisionScope: 'origin', entryId: 'region␟42' },
    };
    const focusedOnLeft = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'rowFocused',
      sectionId: left.sectionId,
      entryRef: left.entryRef,
    });

    // `core/CORPUS.md` §6 records this exact contract-valid pair: a `␟`-joined
    // key returns one string for both. Only `right` survives here, so a joined
    // key would consider the focused row still present and leave focus on a row
    // that is gone; component comparison repairs to the section header.
    const settled = reduceTriageSurfaceV1(focusedOnLeft, {
      kind: 'visibleRowsChanged',
      previousOrder: [left],
      visibleOrder: [right],
    });

    expect(settled.focus).toEqual({ sectionId: '2-open', entryRef: null });
  });
});

describe('Triage surface reducer — collapse, lens and search', () => {
  it('keeps collapsed section ids so an unseen section defaults open', () => {
    const collapsed = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'sectionCollapseToggled',
      sectionId: '3-done',
      previousOrder: VISIBLE,
      visibleOrder: VISIBLE.filter((visible) => visible.sectionId !== '3-done'),
    });

    expect(collapsed.collapsedSectionIds).toEqual(['3-done']);
    expect(TRIAGE_SURFACE_INITIAL_STATE_V1.collapsedSectionIds).toEqual([]);
    expect(reduceTriageSurfaceV1(collapsed, {
      kind: 'sectionCollapseToggled',
      sectionId: '3-done',
      previousOrder: VISIBLE.filter((visible) => visible.sectionId !== '3-done'),
      visibleOrder: VISIBLE,
    }).collapsedSectionIds).toEqual([]);
  });

  it('repairs focus out of a section the user just collapsed, without changing selection', () => {
    const selected = selectedAndFocused();

    const collapsed = reduceTriageSurfaceV1(selected, {
      kind: 'sectionCollapseToggled',
      sectionId: '2-open',
      previousOrder: VISIBLE,
      visibleOrder: VISIBLE.filter((visible) => visible.sectionId !== '2-open'),
    });

    expect(collapsed.focus).toEqual({ sectionId: '2-open', entryRef: null });
    expect(collapsed.selection).toEqual(selected.selection);
  });

  it('changes order and grouping explicitly and never as a side effect of selection', () => {
    const ordered = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'orderChanged',
      order: 'smart',
    });

    expect(TRIAGE_SURFACE_INITIAL_STATE_V1.order).toBe('newest');
    expect(ordered.order).toBe('smart');
    expect(reduceTriageSurfaceV1(ordered, {
      kind: 'groupingChanged',
      grouping: 'scope',
    }).grouping).toBe('scope');
    expect(selectedAndFocused().order).toBe('newest');
  });

  it('keeps IME-intermediate text out of the settled query the walk and route consume', () => {
    const composing = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'searchComposing',
      text: 'ふぁ',
    });

    expect(composing.search).toEqual({ query: '', composing: 'ふぁ' });

    const settled = reduceTriageSurfaceV1(composing, { kind: 'searchChanged', query: 'ファイル' });

    expect(settled.search).toEqual({ query: 'ファイル', composing: null });
  });

  it('never persists a query or cursor across an explicit clear', () => {
    const settled = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'searchChanged',
      query: 'auth',
    });

    expect(reduceTriageSurfaceV1(settled, { kind: 'searchCleared' }).search)
      .toEqual({ query: '', composing: null });
  });

  it('returns the same state object for an action that changes nothing', () => {
    const settled = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'orderChanged',
      order: 'newest',
    });

    // Referential stability is what keeps the list container from re-rendering
    // on every settled corpus result at 2,000 rows.
    expect(settled).toBe(TRIAGE_SURFACE_INITIAL_STATE_V1);
  });
});
