import type { TriageEntryRefV1, TriageSourceInstanceIdV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { CORPUS_DEFAULT_SMART_POLICY_V1 } from '../../corpus/query/smartPolicy.js';
import { TRIAGE_LIST_NO_FILTERS_V1 } from '../../projection/listWindow.js';
import { MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1 } from '../../settings/savedViews.js';
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
    // `plugin-ui`'s List owns focus MOVEMENT and reports the result through
    // `onFocusedKeyChange`; this reducer only records it. Landing directly on
    // row 13 is what arrowing off the selected row used to produce.
    const arrowedAway = reduceTriageSurfaceV1(selectedAndFocused(), {
      kind: 'rowFocused',
      sectionId: '2-open',
      entryRef: entry('13'),
    });

    const dismissed = reduceTriageSurfaceV1(arrowedAway, {
      kind: 'detailDismissed',
      visibleOrder: VISIBLE,
    });

    expect(dismissed.selection).toBe(null);
    expect(dismissed.focus).toEqual({ sectionId: '2-open', entryRef: entry('12') });
  });

  it('selects a launched entry this page lists nowhere, without moving the keyboard cursor', () => {
    // `core/SURFACE.md` §3.2: a validated direct launch names an entry the
    // destination page's own lens may exclude, and that ref must still select
    // behind the honest not-yet-materialized header. There is no row for it, so
    // there is nothing for the cursor to move to and no section to name.
    const reading = focusedOn('13');

    const activated = reduceTriageSurfaceV1(reading, {
      kind: 'rowActivated',
      sectionId: null,
      entryRef: entry('99'),
      sourceInstanceId: INSTANCE_B,
    });

    expect(activated.selection).toEqual({
      sectionId: null,
      entryRef: entry('99'),
      sourceInstanceId: INSTANCE_B,
    });
    // The reader's cursor is theirs. An activation with no row of its own must
    // not drag it to an entry that is not on the page.
    expect(activated.focus).toBe(reading.focus);
  });

  it('returns focus to the section the dismissed row is in NOW, not the one it was selected in', () => {
    // The section a selection was made in is a snapshot; the order the shell
    // reports at dismissal is current. A row that changed section while the
    // detail was open would otherwise send the cursor to a section it has left,
    // and `repairFocus` would then filter an order that never held it.
    const selected = selectedAndFocused();
    const regrouped = [row('1-pinned', '07'), row('3-done', '12'), row('2-open', '13')];

    const dismissed = reduceTriageSurfaceV1(selected, {
      kind: 'detailDismissed',
      visibleOrder: regrouped,
    });

    expect(dismissed.selection).toBe(null);
    expect(dismissed.focus).toEqual({ sectionId: '3-done', entryRef: entry('12') });
  });

  it('leaves focus where it is when the dismissed selection is no longer a visible row', () => {
    const withoutSelectedRow = VISIBLE.filter((visible) => visible.entryRef.entryId !== '12');
    // `plugin-ui`'s List owns focus MOVEMENT and reports the result through
    // `onFocusedKeyChange`; this reducer only records it. Landing directly on
    // row 13 is what arrowing off the selected row used to produce.
    const arrowedAway = reduceTriageSurfaceV1(selectedAndFocused(), {
      kind: 'rowFocused',
      sectionId: '2-open',
      entryRef: entry('13'),
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

describe('Triage surface reducer — the five filter facets compose', () => {
  it('adds one facet value and leaves every other facet exactly as it was', () => {
    const filtered = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'filterValueToggled',
      facet: 'sources',
      value: { source: SOURCE },
    });

    expect(filtered.filters.sources).toEqual([{ source: SOURCE }]);
    expect(filtered.filters.types).toEqual([]);
    expect(filtered.filters.scopes).toEqual([]);
    expect(filtered.filters.states).toEqual([]);
    expect(filtered.filters.attention).toEqual([]);
    expect(TRIAGE_SURFACE_INITIAL_STATE_V1.filters.sources).toEqual([]);

    // The same value again is a removal, not a duplicate: one press is one
    // constraint, and a duplicated value would also spend the facet bound.
    expect(reduceTriageSurfaceV1(filtered, {
      kind: 'filterValueToggled',
      facet: 'sources',
      value: { source: SOURCE },
    }).filters.sources).toEqual([]);
  });

  it('never weakens, substitutes or clears one facet when another is selected', () => {
    const sourced = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'filterValueToggled',
      facet: 'sources',
      value: { source: SOURCE },
    });
    const stated = reduceTriageSurfaceV1(sourced, {
      kind: 'filterValueToggled',
      facet: 'states',
      value: 'open',
    });
    const attended = reduceTriageSurfaceV1(stated, {
      kind: 'filterValueToggled',
      facet: 'attention',
      value: 'required',
    });

    expect(attended.filters.sources).toEqual([{ source: SOURCE }]);
    expect(attended.filters.states).toEqual(['open']);
    expect(attended.filters.attention).toEqual(['required']);

    // Clearing one facet leaves the others untouched, which is the half a
    // "reset the rail" implementation gets wrong.
    const clearedAttention = reduceTriageSurfaceV1(attended, {
      kind: 'filterValueToggled',
      facet: 'attention',
      value: 'required',
    });
    expect(clearedAttention.filters.sources).toEqual([{ source: SOURCE }]);
    expect(clearedAttention.filters.states).toEqual(['open']);
  });

  it('compares a facet value componentwise, so two contract-valid values never merge', () => {
    const oneKind = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'filterValueToggled',
      facet: 'types',
      value: { source: SOURCE, kindId: 'pull-request' },
    });
    const twoKinds = reduceTriageSurfaceV1(oneKind, {
      kind: 'filterValueToggled',
      facet: 'types',
      value: { source: SOURCE, kindId: 'issue' },
    });

    // Same source, different kind: a comparator that only read `source` would
    // have toggled the first value off.
    expect(twoKinds.filters.types).toEqual([
      { source: SOURCE, kindId: 'pull-request' },
      { source: SOURCE, kindId: 'issue' },
    ]);

    // The exact pair `core/CORPUS.md` §6 records as unmergeable: a delimiter
    // join of source and scope would read these two as one value.
    const scoped = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'filterValueToggled',
      facet: 'scopes',
      value: { source: SOURCE, collisionScope: 'originregion' },
    });
    const bothScopes = reduceTriageSurfaceV1(scoped, {
      kind: 'filterValueToggled',
      facet: 'scopes',
      value: { source: SOURCE, collisionScope: 'origin' },
    });

    expect(bothScopes.filters.scopes).toEqual([
      { source: SOURCE, collisionScope: 'originregion' },
      { source: SOURCE, collisionScope: 'origin' },
    ]);
  });

  it('refuses a value beyond the one facet bound instead of dropping a selected one', () => {
    let state = TRIAGE_SURFACE_INITIAL_STATE_V1;
    for (let index = 0; index < MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1; index += 1) {
      state = reduceTriageSurfaceV1(state, {
        kind: 'filterValueToggled',
        facet: 'scopes',
        value: { source: SOURCE, collisionScope: `scope-${index}` },
      });
    }
    expect(state.filters.scopes).toHaveLength(MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1);

    const refused = reduceTriageSurfaceV1(state, {
      kind: 'filterValueToggled',
      facet: 'scopes',
      value: { source: SOURCE, collisionScope: 'one-too-many' },
    });

    // The bound is the wire's: a wider facet is a lens the list Action refuses
    // whole, so the honest answer is to keep the sixteen the reader chose
    // rather than silently evict the oldest.
    expect(refused).toBe(state);
    // Removing a value at the bound still works, so the reader is never stuck.
    expect(reduceTriageSurfaceV1(state, {
      kind: 'filterValueToggled',
      facet: 'scopes',
      value: { source: SOURCE, collisionScope: 'scope-0' },
    }).filters.scopes).toHaveLength(MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1 - 1);
  });

  it('clears every facet at once and returns the same state when nothing is selected', () => {
    const filtered = reduceTriageSurfaceV1(reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'filterValueToggled',
      facet: 'sources',
      value: { source: SOURCE },
    }), { kind: 'filterValueToggled', facet: 'states', value: 'done' });

    const cleared = reduceTriageSurfaceV1(filtered, { kind: 'filtersCleared' });

    expect(cleared.filters).toEqual(TRIAGE_LIST_NO_FILTERS_V1);
    expect(reduceTriageSurfaceV1(cleared, { kind: 'filtersCleared' })).toBe(cleared);
  });

  it('retains the Smart precedence across an order change so a preference is not silently reset', () => {
    const policy = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'smartPolicyChanged',
      smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
    });

    expect(TRIAGE_SURFACE_INITIAL_STATE_V1.smartPolicy).toEqual(CORPUS_DEFAULT_SMART_POLICY_V1);
    expect(policy.smartPolicy).toEqual({ v: 1, precedence: ['activity', 'attention'] });

    const backToNewest = reduceTriageSurfaceV1(policy, { kind: 'orderChanged', order: 'newest' });
    expect(backToNewest.smartPolicy).toEqual({ v: 1, precedence: ['activity', 'attention'] });
    expect(reduceTriageSurfaceV1(policy, {
      kind: 'smartPolicyChanged',
      smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
    })).toBe(policy);
  });
});
