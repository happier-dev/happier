import type { TriageEntryRefV1, TriageSourceInstanceIdV1 } from '@happier-dev/triage-protocol/v1';

/**
 * The ONE PRs & Issues selection/focus/lens reducer (`core/SURFACE.md` §3.1).
 *
 * Focus and selection are two independent cursors: neither derives from the
 * other, keyboard traversal never opens a different detail, and corpus movement
 * (scan, refresh, watch invalidation, source result) never steals either one.
 * The data layer cannot dispatch a focus or selection action — every action here
 * originates from a user input or from the shell reporting what is now visible.
 *
 * Deliberately absent, and blocked on the Corpus lane rather than approximated
 * here: `filters: SurfaceFilterSelectionV1`, `smartPolicy: CorpusSmartPolicyV1`
 * and `selectedViewId`. Their canonical types are owned by
 * `packages/plugins/triage/src/corpus/**` and `src/settings/savedViews.ts`
 * (`core/CORPUS.md` §6.1, §6.3), which do not exist yet. Restating them here
 * would create exactly the second filter-vocabulary owner the contract forbids,
 * so they are added to this same reducer once that producer publishes.
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
 */
export type TriageSurfaceSelectionV1 = Readonly<{
  sectionId: string;
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

export type TriageSurfaceStateV1 = Readonly<{
  focus: TriageFocusV1 | null;
  selection: TriageSurfaceSelectionV1 | null;
  grouping: 'lane' | 'scope' | 'kind';
  order: 'newest' | 'oldest' | 'smart';
  search: TriageSearchStateV1;
  /** Collapsed ids persist so a section the user has never seen defaults open. */
  collapsedSectionIds: readonly string[];
}>;

export type TriageSurfaceActionV1 =
  /** Pointer/touch or programmatic focus of one row; selection is untouched. */
  | Readonly<{ kind: 'rowFocused'; sectionId: string; entryRef: TriageEntryRefV1 }>
  | Readonly<{ kind: 'sectionHeaderFocused'; sectionId: string }>
  | Readonly<{
      kind: 'focusMoved';
      movement: 'next' | 'previous' | 'first' | 'last';
      visibleOrder: readonly TriageVisibleRowV1[];
    }>
  /**
   * Enter/Space. The caller supplies the qualification result — the current
   * instance observing the focused entry — because instance resolution is a
   * Corpus read, not a reducer decision.
   */
  | Readonly<{ kind: 'focusedRowActivated'; sourceInstanceId: TriageSourceInstanceIdV1 }>
  /**
   * Pointer/touch row activation, and the same action a validated direct-launch
   * selection dispatches (`core/SURFACE.md` §3.2) so both reach one reducer.
   */
  | Readonly<{
      kind: 'rowActivated';
      sectionId: string;
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
  | Readonly<{ kind: 'searchComposing'; text: string }>
  | Readonly<{ kind: 'searchChanged'; query: string }>
  | Readonly<{ kind: 'searchCleared' }>;

const EMPTY_SEARCH: TriageSearchStateV1 = Object.freeze({ query: '', composing: null });

export const TRIAGE_SURFACE_INITIAL_STATE_V1: TriageSurfaceStateV1 = Object.freeze({
  focus: null,
  selection: null,
  grouping: 'lane',
  order: 'newest',
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
    && left.source.pluginId === right.source.pluginId
    && left.source.localId === right.source.localId;
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

    case 'focusMoved': {
      const moved = resolveMovedFocus(state.focus, action.movement, action.visibleOrder);
      return moved === null ? state : withFocus(state, moved);
    }

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
      const focused = withFocus(state, { sectionId: action.sectionId, entryRef: action.entryRef });
      return withSelection(focused, {
        sectionId: action.sectionId,
        entryRef: action.entryRef,
        sourceInstanceId: action.sourceInstanceId,
      });
    }

    case 'detailDismissed': {
      const dismissed = state.selection;
      if (dismissed === null) return state;
      const stillVisible = action.visibleOrder.some(
        (visible) => sameTriageEntryRefV1(visible.entryRef, dismissed.entryRef),
      );
      const returned = stillVisible
        ? withFocus(state, { sectionId: dismissed.sectionId, entryRef: dismissed.entryRef })
        : state;
      return { ...returned, selection: null };
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

function resolveMovedFocus(
  focus: TriageFocusV1 | null,
  movement: 'next' | 'previous' | 'first' | 'last',
  visibleOrder: readonly TriageVisibleRowV1[],
): TriageFocusV1 | null {
  if (visibleOrder.length === 0) return null;
  if (movement === 'first') return toFocus(visibleOrder[0]);
  if (movement === 'last') return toFocus(visibleOrder[visibleOrder.length - 1]);

  const current = focus?.entryRef ?? null;
  const index = current === null
    ? -1
    : visibleOrder.findIndex((visible) => sameTriageEntryRefV1(visible.entryRef, current));

  // With no row focused yet, the first movement lands on the near end of the
  // flattened order rather than doing nothing.
  if (index < 0) return toFocus(movement === 'next' ? visibleOrder[0] : visibleOrder[visibleOrder.length - 1]);

  // Traversal is over the whole section-flattened order, so it crosses section
  // boundaries and clamps at both ends instead of wrapping.
  const nextIndex = movement === 'next' ? index + 1 : index - 1;
  const next = visibleOrder[nextIndex];
  return next === undefined ? null : toFocus(next);
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
