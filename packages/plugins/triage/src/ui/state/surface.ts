import type { TriageEntryRefV1, TriageSourceInstanceIdV1 } from '@happier-dev/triage-protocol/v1';

import { sameTriageSourceIdentity } from '../../corpus/identity/components.js';
import {
  CORPUS_DEFAULT_SMART_POLICY_V1,
  type CorpusSmartPolicyV1,
} from '../../corpus/query/smartPolicy.js';
import {
  TRIAGE_LIST_NO_FILTERS_V1,
  type CorpusAttentionFilterValueV1,
  type CorpusScopeFilterValueV1,
  type CorpusSourceFilterValueV1,
  type CorpusStateFilterValueV1,
  type CorpusTypeFilterValueV1,
  type SurfaceFilterSelectionV1,
  type TriageListOrderV1,
} from '../../projection/listWindow.js';
import { MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1 } from '../../settings/savedViews.js';
import { hasSelectedTriageFacetV1 } from './narrowing.js';

/**
 * The ONE PRs & Issues selection/focus/lens reducer (`core/SURFACE.md` §3.1).
 *
 * Focus and selection are two independent cursors: neither derives from the
 * other, keyboard traversal never opens a different detail, and corpus movement
 * (scan, refresh, watch invalidation, source result) never steals either one.
 * The data layer cannot dispatch a focus or selection action — every action here
 * originates from a user input or from the shell reporting what is now visible.
 *
 * The lens half — `order`, `filters` and `smartPolicy` — is here for the same
 * reason: it is one state, read once by `ui/shell/lens.ts` into the window's
 * lens and once by `ui/navigation/location.ts` into the shareable location, so
 * the rows on screen and the URL that names them cannot disagree.
 *
 * **`selectedViewId` is carried here**, and it now has a real producer. The
 * list's own compact **Views** control (`ui/views/control.tsx`) is the
 * affordance `settings/savedViewsContribution.ts` describes when it declares
 * the field `presentation: { hidden: true }` — "a user creates, renames,
 * selects and removes views from the list's own lens affordance" — so selecting
 * a view is an explicit Settings mutation whose applied projection becomes this
 * lens, id included.
 *
 * Two rules about it are load-bearing:
 *
 * - **An ordinary lens edit does not clear it.** Editing a facet, the order or
 *   the Smart policy after selecting leaves the id in place and makes the lens
 *   *modified* (`ui/views/divergence.ts`); **Update** is the separate explicit
 *   write. Clearing the id on an edit would look tidy and would silently throw
 *   away which view the reader is a step away from saving into.
 * - **It is cleared only when the view it names is gone.** A deleted or
 *   cross-Account id is cleared through `savedViewSelectionCleared`, which
 *   deliberately leaves the facets, order and policy exactly as they are: the
 *   reader is still looking at that lens, and resetting it would be this
 *   reducer inventing a lens change nobody asked for.
 */

/** One row as the shell currently renders it, in section-flattened order. */
export type TriageVisibleRowV1 = Readonly<{
  sectionId: string;
  entryRef: TriageEntryRefV1;
}>;

/**
 * The keyboard cursor. `entryRef: null` is the section header itself, which is
 * where focus rests when the focused row's whole section disappears or the user
 * collapses it (`core/SURFACE.md` §3.1, "nearest surviving row, else section
 * header"). A section header is a real focus stop because it is the collapse
 * control.
 */
export type TriageFocusV1 = Readonly<{
  sectionId: string;
  entryRef: TriageEntryRefV1 | null;
}>;

/**
 * The detail cursor. `sourceInstanceId` is the target-minted stable UUID for the
 * selected observation; the exact `TriageSourceInstanceRefV1` is materialized by
 * Corpus only at the strict detail boundary, never reconstructed from this UUID.
 *
 * `sectionId` is `null` when the selected entry has no row on this page. A
 * validated direct launch (`core/SURFACE.md` §3.2) names an entry the
 * destination page's own lens may exclude — an ordinary state for a page left
 * carrying a query or a facet — and that ref must still SELECT, behind the
 * honest not-yet-materialized header, rather than produce nothing. Inventing a
 * section for it would be the fabricated header §3.2 forbids. Nothing else
 * needs the id: selection is a reader cursor, never a window fact, and the one
 * thing a section was ever read for — returning the keyboard cursor on
 * dismissal — is read from the order `detailDismissed` is handed, where it is
 * current rather than a snapshot of where the row used to be.
 */
export type TriageSurfaceSelectionV1 = Readonly<{
  sectionId: string | null;
  entryRef: TriageEntryRefV1;
  sourceInstanceId: TriageSourceInstanceIdV1;
}>;

/**
 * `query` is the settled value the bounded corpus walk and the route consume;
 * `composing` is the IME-intermediate text, which reaches neither.
 */
export type TriageSearchStateV1 = Readonly<{
  query: string;
  composing: string | null;
}>;

/**
 * One facet value, named by the facet it belongs to.
 *
 * The pair is one discriminated value rather than five near-identical actions
 * because the rule the reducer enforces is the same for all five — a value
 * composes with the facet it is in and never touches another — and five arms
 * would be five places for that rule to drift.
 */
export type TriageFilterFacetValueV1 =
  | Readonly<{ facet: 'sources'; value: CorpusSourceFilterValueV1 }>
  | Readonly<{ facet: 'types'; value: CorpusTypeFilterValueV1 }>
  | Readonly<{ facet: 'scopes'; value: CorpusScopeFilterValueV1 }>
  | Readonly<{ facet: 'states'; value: CorpusStateFilterValueV1 }>
  | Readonly<{ facet: 'attention'; value: CorpusAttentionFilterValueV1 }>;

export type TriageSurfaceStateV1 = Readonly<{
  focus: TriageFocusV1 | null;
  selection: TriageSurfaceSelectionV1 | null;
  grouping: 'lane' | 'scope' | 'kind';
  /**
   * The exported closed order vocabulary, not a second inline spelling of it.
   * `settings/savedViews.ts` and `settings/effectiveView.ts` already read the
   * same type, so an Order control has one list to bind to rather than two live
   * `order` fields and no rule saying which one is authoritative.
   */
  order: TriageListOrderV1;
  /**
   * Carried whatever the order is. A reader who set the Smart precedence and
   * then looked at the list by date has not withdrawn the preference, so
   * dropping it outside `smart` would reset it behind their back.
   */
  smartPolicy: CorpusSmartPolicyV1;
  /** The five facets of `core/SURFACE.md` §6; they compose by conjunction. */
  filters: SurfaceFilterSelectionV1;
  /**
   * The saved view this lens came from, or `null` for the reader's own unsaved
   * lens. It is durable account preference restored on restart, never a second
   * copy of the view: the facets, order and policy above are the lens, and this
   * only names where they came from.
   */
  selectedViewId: string | null;
  search: TriageSearchStateV1;
  /** Collapsed ids persist so a section the user has never seen defaults open. */
  collapsedSectionIds: readonly string[];
}>;

export type TriageSurfaceActionV1 =
  /**
   * Where the reader's logical focus now is, as reported by the shared `List`
   * — arrow/`j`/`k`/Home/End/Page movement and pointer/touch alike. Selection is
   * untouched. Movement itself is NOT a reducer decision: only the `List` can
   * traverse rows its virtualizer has not mounted, so this surface records the
   * cursor rather than owning a second one.
   */
  | Readonly<{ kind: 'rowFocused'; sectionId: string; entryRef: TriageEntryRefV1 }>
  | Readonly<{ kind: 'sectionHeaderFocused'; sectionId: string }>
  /**
   * Enter/Space. The caller supplies the qualification result — the current
   * instance observing the focused entry — because instance resolution is a
   * Corpus read, not a reducer decision.
   */
  | Readonly<{ kind: 'focusedRowActivated'; sourceInstanceId: TriageSourceInstanceIdV1 }>
  /**
   * Pointer/touch row activation, and the same action a validated direct-launch
   * selection dispatches (`core/SURFACE.md` §3.2) so both reach one reducer.
   *
   * `sectionId: null` is that launch when this page's lens does not list the
   * entry: there is no row to move the keyboard cursor to, so the activation
   * selects without moving focus. A row press always names its own section.
   */
  | Readonly<{
      kind: 'rowActivated';
      sectionId: string | null;
      entryRef: TriageEntryRefV1;
      sourceInstanceId: TriageSourceInstanceIdV1;
    }>
  /** Escape in detail, or generic page Back over a stacked selected detail. */
  | Readonly<{ kind: 'detailDismissed'; visibleOrder: readonly TriageVisibleRowV1[] }>
  | Readonly<{
      kind: 'visibleRowsChanged';
      previousOrder: readonly TriageVisibleRowV1[];
      visibleOrder: readonly TriageVisibleRowV1[];
    }>
  | Readonly<{
      kind: 'sectionCollapseToggled';
      sectionId: string;
      previousOrder: readonly TriageVisibleRowV1[];
      visibleOrder: readonly TriageVisibleRowV1[];
    }>
  | Readonly<{ kind: 'groupingChanged'; grouping: TriageSurfaceStateV1['grouping'] }>
  | Readonly<{ kind: 'orderChanged'; order: TriageSurfaceStateV1['order'] }>
  /** One facet value in or out; every other facet is untouched. */
  | Readonly<{ kind: 'filterValueToggled' } & TriageFilterFacetValueV1>
  | Readonly<{ kind: 'filtersCleared' }>
  | Readonly<{ kind: 'smartPolicyChanged'; smartPolicy: CorpusSmartPolicyV1 }>
  /**
   * One saved view's stored lens, applied whole (`core/SURFACE.md` §6.5).
   *
   * The three lens halves travel together with the id because they are one
   * stored fact: applying the facets without the order, or the order without the
   * policy, would show the reader a list that is not the view they chose and
   * would still be named after it. The values come from the one read-side
   * resolver (`settings/effectiveView.ts`), so nothing here reinterprets a
   * stored view.
   */
  | Readonly<{
      kind: 'savedViewApplied';
      viewId: string | null;
      filters: SurfaceFilterSelectionV1;
      order: TriageListOrderV1;
      smartPolicy: CorpusSmartPolicyV1;
    }>
  /** The named view is gone; the lens it produced is not. */
  | Readonly<{ kind: 'savedViewSelectionCleared' }>
  | Readonly<{ kind: 'searchComposing'; text: string }>
  | Readonly<{ kind: 'searchChanged'; query: string }>
  | Readonly<{ kind: 'searchCleared' }>;

const EMPTY_SEARCH: TriageSearchStateV1 = Object.freeze({ query: '', composing: null });

export const TRIAGE_SURFACE_INITIAL_STATE_V1: TriageSurfaceStateV1 = Object.freeze({
  focus: null,
  selection: null,
  grouping: 'lane',
  order: 'newest',
  smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
  filters: TRIAGE_LIST_NO_FILTERS_V1,
  selectedViewId: null,
  search: EMPTY_SEARCH,
  collapsedSectionIds: Object.freeze([]),
});

/**
 * Structural identity over the four canonical `TriageEntryRefV1` components.
 *
 * Deliberately NOT a joined string. `core/CORPUS.md` §6 records the exact
 * contract-valid pair a delimiter join merges — `collisionScope 'origin␟region'`
 * with `entryId '42'` versus `collisionScope 'origin'` with `entryId '␟42'` —
 * and merging two entries into one row here would leave focus on a row that is
 * gone. Comparing components cannot collide at all.
 */
export function sameTriageEntryRefV1(left: TriageEntryRefV1, right: TriageEntryRefV1): boolean {
  return left.entryId === right.entryId
    && left.collisionScope === right.collisionScope
    && left.kindId === right.kindId
    && sameTriageSourceIdentity(left.source, right.source);
}

/**
 * Whether two values of ONE facet are the same constraint.
 *
 * Componentwise, for the same reason `sameTriageEntryRefV1` is: a facet value
 * carries a contribution identity plus one canonical component, and a delimiter
 * join of those parts can read two contract-valid distinct constraints as one
 * (`core/CORPUS.md` §6). A comparator that merged them would toggle a
 * constraint the reader did not touch.
 *
 * It lives with the reducer that owns the selection rather than with the
 * matcher in `projection/listWindow.ts`: that one asks whether a ROW satisfies a
 * value, which is a different predicate, and the route owner needs this one too.
 */
export function sameTriageFilterValueV1(
  left: TriageFilterFacetValueV1,
  right: TriageFilterFacetValueV1,
): boolean {
  if (left.facet !== right.facet) return false;
  if (left.facet === 'states' || left.facet === 'attention') return left.value === right.value;
  const other = right.value as CorpusSourceFilterValueV1;
  if (left.value.source.pluginId !== other.source.pluginId
    || left.value.source.localId !== other.source.localId) {
    return false;
  }
  if (left.facet === 'types') {
    return left.value.kindId === (right.value as CorpusTypeFilterValueV1).kindId;
  }
  if (left.facet === 'scopes') {
    return left.value.collisionScope === (right.value as CorpusScopeFilterValueV1).collisionScope;
  }
  return true;
}

/**
 * Toggle one value inside its own facet.
 *
 * At the facet bound an addition is refused rather than evicting the oldest
 * selection: the bound is the one the list Action's wire enforces
 * (`actions/listEntriesProtocol.ts`), so a wider facet is a lens no read could
 * carry — and silently dropping a constraint the reader chose is the failure
 * this refusal exists to avoid. A removal at the bound always works, so the
 * rail can never be stuck.
 */
function toggleFilterValue(
  filters: SurfaceFilterSelectionV1,
  selection: TriageFilterFacetValueV1,
): SurfaceFilterSelectionV1 {
  const facet = selection.facet;
  const current = filters[facet] as readonly TriageFilterFacetValueV1['value'][];
  const index = current.findIndex((candidate) => sameTriageFilterValueV1(
    { facet, value: candidate } as TriageFilterFacetValueV1,
    selection,
  ));
  if (index < 0 && current.length >= MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1) return filters;
  const next = index >= 0
    ? [...current.slice(0, index), ...current.slice(index + 1)]
    : [...current, selection.value];
  return Object.freeze({ ...filters, [facet]: Object.freeze(next) }) as SurfaceFilterSelectionV1;
}

export function reduceTriageSurfaceV1(
  state: TriageSurfaceStateV1,
  action: TriageSurfaceActionV1,
): TriageSurfaceStateV1 {
  switch (action.kind) {
    case 'rowFocused':
      return withFocus(state, { sectionId: action.sectionId, entryRef: action.entryRef });

    case 'sectionHeaderFocused':
      return withFocus(state, { sectionId: action.sectionId, entryRef: null });

    case 'focusedRowActivated': {
      const focusedEntry = state.focus?.entryRef;
      // A section-header focus names no entry, so there is nothing to qualify.
      // Silently selecting a neighbouring row would be the wrong-row bug.
      if (focusedEntry === undefined || focusedEntry === null) return state;
      return withSelection(state, {
        sectionId: state.focus!.sectionId,
        entryRef: focusedEntry,
        sourceInstanceId: action.sourceInstanceId,
      });
    }

    case 'rowActivated': {
      // An activation naming no section names no row on this page, so there is
      // no cursor move to make. Parking focus on an invented section would leave
      // `repairFocus` filtering an order that never held it.
      const focused = action.sectionId === null
        ? state
        : withFocus(state, { sectionId: action.sectionId, entryRef: action.entryRef });
      return withSelection(focused, {
        sectionId: action.sectionId,
        entryRef: action.entryRef,
        sourceInstanceId: action.sourceInstanceId,
      });
    }

    case 'detailDismissed': {
      const dismissed = state.selection;
      if (dismissed === null) return state;
      // Focus returns to where the dismissed row is NOW, read from the order the
      // shell just reported rather than from the section the selection was made
      // in. That section is a snapshot: a row regrouped while the detail was
      // open would send the cursor to a section it has left, and a selection
      // this page's lens never listed carries no section at all.
      const returned = action.visibleOrder.find(
        (visible) => sameTriageEntryRefV1(visible.entryRef, dismissed.entryRef),
      );
      return {
        ...(returned === undefined ? state : withFocus(state, toFocus(returned))),
        selection: null,
      };
    }

    case 'visibleRowsChanged':
      // Selection is retained even when its entry disappears, so `detail/slot`
      // can render truthful cached/unavailable content instead of blanking.
      return repairFocus(state, action.previousOrder, action.visibleOrder);

    case 'sectionCollapseToggled': {
      const collapsed = state.collapsedSectionIds.includes(action.sectionId)
        ? state.collapsedSectionIds.filter((id) => id !== action.sectionId)
        : [...state.collapsedSectionIds, action.sectionId];
      return repairFocus(
        { ...state, collapsedSectionIds: collapsed },
        action.previousOrder,
        action.visibleOrder,
      );
    }

    case 'groupingChanged':
      return action.grouping === state.grouping ? state : { ...state, grouping: action.grouping };

    case 'orderChanged':
      return action.order === state.order ? state : { ...state, order: action.order };

    case 'filterValueToggled': {
      const filters = toggleFilterValue(state.filters, action);
      return filters === state.filters ? state : { ...state, filters };
    }

    case 'filtersCleared':
      // The same predicate the rail uses to decide whether to offer **Clear
      // filters** at all, so the control and the reducer cannot disagree about
      // whether there is anything to clear.
      return hasSelectedTriageFacetV1(state.filters)
        ? { ...state, filters: TRIAGE_LIST_NO_FILTERS_V1 }
        : state;

    case 'smartPolicyChanged':
      return action.smartPolicy.precedence[0] === state.smartPolicy.precedence[0]
        ? state
        : { ...state, smartPolicy: action.smartPolicy };

    case 'savedViewApplied':
      return {
        ...state,
        selectedViewId: action.viewId,
        filters: action.filters,
        order: action.order,
        smartPolicy: action.smartPolicy,
      };

    case 'savedViewSelectionCleared':
      // The facets, order and policy survive on purpose: the view is gone, but
      // the reader is still looking at the lens it produced.
      return state.selectedViewId === null ? state : { ...state, selectedViewId: null };

    case 'searchComposing':
      return action.text === state.search.composing
        ? state
        : { ...state, search: { query: state.search.query, composing: action.text } };

    case 'searchChanged':
      return action.query === state.search.query && state.search.composing === null
        ? state
        : { ...state, search: { query: action.query, composing: null } };

    case 'searchCleared':
      return state.search.query === '' && state.search.composing === null
        ? state
        : { ...state, search: EMPTY_SEARCH };
  }
}

function withFocus(state: TriageSurfaceStateV1, focus: TriageFocusV1): TriageSurfaceStateV1 {
  return sameFocus(state.focus, focus) ? state : { ...state, focus };
}

function withSelection(
  state: TriageSurfaceStateV1,
  selection: TriageSurfaceSelectionV1,
): TriageSurfaceStateV1 {
  const current = state.selection;
  const unchanged = current !== null
    && current.sectionId === selection.sectionId
    && current.sourceInstanceId === selection.sourceInstanceId
    && sameTriageEntryRefV1(current.entryRef, selection.entryRef);
  return unchanged ? state : { ...state, selection };
}

function sameFocus(left: TriageFocusV1 | null, right: TriageFocusV1): boolean {
  if (left === null || left.sectionId !== right.sectionId) return false;
  if (left.entryRef === null || right.entryRef === null) return left.entryRef === right.entryRef;
  return sameTriageEntryRefV1(left.entryRef, right.entryRef);
}

/**
 * Focus survives unchanged whenever its row is still visible. Otherwise it moves
 * to the nearest surviving row IN ITS OWN SECTION — forward first, matching the
 * direction a list reads — and rests on that section's header when the section
 * has no surviving rows at all.
 */
function repairFocus(
  state: TriageSurfaceStateV1,
  previousOrder: readonly TriageVisibleRowV1[],
  visibleOrder: readonly TriageVisibleRowV1[],
): TriageSurfaceStateV1 {
  const focus = state.focus;
  if (focus === null || focus.entryRef === null) return state;
  const focusedEntry = focus.entryRef;

  if (visibleOrder.some((visible) => sameTriageEntryRefV1(visible.entryRef, focusedEntry))) {
    return state;
  }

  const sectionRows = previousOrder.filter((visible) => visible.sectionId === focus.sectionId);
  const previousIndex = sectionRows.findIndex(
    (visible) => sameTriageEntryRefV1(visible.entryRef, focusedEntry),
  );
  const survives = (candidate: TriageVisibleRowV1): boolean => visibleOrder.some(
    (visible) => sameTriageEntryRefV1(visible.entryRef, candidate.entryRef),
  );

  if (previousIndex >= 0) {
    for (let offset = previousIndex + 1; offset < sectionRows.length; offset += 1) {
      const candidate = sectionRows[offset];
      if (candidate !== undefined && survives(candidate)) return withFocus(state, toFocus(candidate));
    }
    for (let offset = previousIndex - 1; offset >= 0; offset -= 1) {
      const candidate = sectionRows[offset];
      if (candidate !== undefined && survives(candidate)) return withFocus(state, toFocus(candidate));
    }
  }

  return withFocus(state, { sectionId: focus.sectionId, entryRef: null });
}

function toFocus(visible: TriageVisibleRowV1): TriageFocusV1 {
  return { sectionId: visible.sectionId, entryRef: visible.entryRef };
}
