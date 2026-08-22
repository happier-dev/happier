import * as React from 'react';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import type { PluginUiContextEnrichmentV1, PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import {
  Banner,
  Button,
  EmptyState,
  ErrorState,
  Heading,
  List,
  LoadingState,
  Row,
  Screen,
  Stack,
  Status,
  usePluginHostApi,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';

import { TRIAGE_DISPLAY_NAME } from '../../displayName.js';
import type { TriageEntryDetailLaunchInputV1 } from '../../composer/entryDetailLaunchInput.js';
import type { CorpusSmartPolicyV1 } from '../../corpus/query/smartPolicy.js';
import {
  triageEntryRowKey,
  type TriageListLensV1,
  type TriageListRowV1,
} from '../../projection/listWindow.js';
import { resolveTriageEffectiveView } from '../../settings/effectiveView.js';
import type { CorpusSavedViewV1, CorpusSavedViewsReadV1 } from '../../settings/savedViews.js';
import { projectTriageCurrentUiContextV1 } from '../currentContext.js';
import { TriageDetailRegion } from '../detail/region.js';
import { TriageFilterRail } from '../filters/rail.js';
import { planTriageFilterFacetsV1 } from '../filters/plan.js';
import {
  TRIAGE_PINNED_SECTION_KEY,
  planTriageListSections,
  type TriageListSectionItemV1,
} from '../list/sections.js';
import { TriageListContinuationRow, renderTriageListRow } from '../list/rows.js';
import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';
import { useTriagePinnedEntries } from '../marks/useTriagePinnedEntries.js';
import {
  hasTriageRouteLensV1,
  parseTriageRouteSubPathV1,
  preflightTriageRouteLensV1,
  readTriageRouteLensV1,
  writeTriageRouteLensV1,
} from '../navigation/location.js';
import { TriageViewsControl } from '../views/control.js';
import { readTriageSavedViewLensStatusV1 } from '../views/divergence.js';
import {
  triageCreateSavedViewInputV1,
  triageDeleteSavedViewInputV1,
  triageRenameSavedViewInputV1,
  triageSelectSavedViewInputV1,
  triageUpdateSavedViewInputV1,
} from '../views/savedViewsCommand.js';
import { useTriageSavedViews } from '../views/useTriageSavedViews.js';
import { readTriageLensNarrowingV1 } from '../state/narrowing.js';
import {
  TRIAGE_SURFACE_INITIAL_STATE_V1,
  reduceTriageSurfaceV1,
  sameTriageEntryRefV1,
  type TriageFilterFacetValueV1,
  type TriageSurfaceActionV1,
  type TriageSurfaceStateV1,
} from '../state/surface.js';
import { useTriageListWindow } from '../window/useTriageListWindow.js';
import { readTriageListEmptyState, readTriageListEmptyStateKeys } from './emptyState.js';
import { readTriageWindowLensV1 } from './lens.js';
import {
  readTriageListFailureNotice,
  readTriageRefreshPacingNotice,
  resolveTriageListRefreshV1,
  resolveTriageListShellState,
} from './windowState.js';

/**
 * The mounted PRs & Issues shell.
 *
 * It composes already-projected facts and owns no provider I/O: the one window
 * store owns the passes, the pacing and the last-known-good retention, and this
 * file only decides what the reader is told about them. The two refresh
 * producers it wires are named ones — the mount itself, through the window hook,
 * and the explicit **Refresh** control. There is no timer, no interval and no
 * poller anywhere in this surface.
 *
 * It is also the one place the surface reducer and the route owner are actually
 * consumed. Row focus, keyboard traversal, the roving tab stop
 * and pointer activation all come from the shared `List`'s own selection owner;
 * this file turns the one activation it reports into the reducer's `rowActivated`
 * with the instance the window already qualified, and writes the resulting lens
 * back through the host's same-page replacement.
 *
 * A selection now mounts the detail region, which is what makes this a product
 * rather than a list. The composition is `core/SURFACE.md` §2.1's **stacked**
 * one: the list fills the region until a selection, and the selection replaces
 * it with the common header plus the source's own body. The split composition is
 * the same two children under a measured width, and it is the one part of §2.1
 * still missing — this surface has no measurement seam yet, and guessing a
 * desktop width is exactly what §2.1 forbids.
 *
 * The producer that was missing is now here: `entries/read-detail-v1` returns
 * the exact configured instance and the entry's Session links, which are the two
 * members of the strict detail input a mounted surface cannot reach on its own.
 * The third, the applied observation, is already in this mount's window.
 */

/**
 * Every row the window published stays in the window.
 *
 * It is a module constant rather than an inline lambda because the shared
 * `List` memoizes its visible sections on this identity: a new function each
 * render would rebuild every section object on every render, which is exactly
 * the section-identity churn `core/SURFACE.md` §4.3 names.
 */
const RETAIN_EVERY_ROW = (): boolean => true;

/** The lens fields a shareable location carries, as reducer seed values. */
function seedFromLocation(subPath: string | undefined): TriageSurfaceStateV1 {
  const lens = parseTriageRouteSubPathV1(subPath);
  return {
    ...TRIAGE_SURFACE_INITIAL_STATE_V1,
    grouping: lens.grouping,
    order: lens.order,
    smartPolicy: lens.smartPolicy,
    filters: lens.filters,
    selectedViewId: lens.selectedViewId,
    search: { query: lens.query, composing: null },
  };
}

/** A stable empty set, so an unread saved-view answer changes no memo identity. */
const NO_SAVED_VIEWS: readonly CorpusSavedViewV1[] = Object.freeze([]);

export type TriageListShellProps = Readonly<{
  /**
   * The host-owned plugin-local location this page was opened at. Triage owns
   * no router: this is read once as the reducer's seed and written back through
   * the one route owner.
   */
  subPath?: string;
  /**
   * The entry an opener asked this page to open, already validated by the one
   * launch-input owner (`composer/entryDetailLaunchInput.ts`).
   *
   * It is an argument, not a location: the host delivers one open and retires
   * it as soon as the page's location moves, so this seeds the SAME selection a
   * row press produces and the route owner writes the result. Absent on an
   * ordinary open, which is every launch this page is not the destination of.
   */
  launch?: TriageEntryDetailLaunchInputV1;
}>;

/**
 * The mounted shell owns this one replacement publication lifetime. A new
 * committed context replaces its predecessor directly; retirement clears the
 * same host slot synchronously.
 */
export function useTriageCurrentUiContextPublication(
  hostApi: Pick<PluginUiHostApi, 'publishCurrentUiContext'>,
  currentUiContext: PluginUiContextEnrichmentV1,
): void {
  React.useLayoutEffect(() => {
    hostApi.publishCurrentUiContext(currentUiContext);
  }, [currentUiContext, hostApi]);
  React.useLayoutEffect(() => () => {
    hostApi.publishCurrentUiContext(null);
  }, [hostApi]);
}

export function TriageListShell(props: TriageListShellProps = {}): React.ReactElement {
  const hostApi = usePluginHostApi();
  const text = usePluginTranslation();
  const window = useTriageListWindow();
  const marks = useTriagePinnedEntries();
  const savedViews = useTriageSavedViews();
  /**
   * Whether the location this page OPENED at named a lens of its own.
   *
   * Read once, from the location the host handed over, because it decides a
   * one-time question (`core/SURFACE.md` §6.5): an explicit valid route lens
   * wins on restart, and only otherwise does the durable selected view restore
   * itself. Re-reading it later would compare against a location this mount
   * wrote and conclude that every reader arrived carrying a lens.
   */
  const [routeCarriedLens] = React.useState(
    () => hasTriageRouteLensV1(parseTriageRouteSubPathV1(props.subPath)),
  );
  /**
   * The snapshot object is replaced only when the store publishes a new one, so
   * deriving the shell state from it once per snapshot keeps the section plan
   * below — and therefore every `List` section identity — stable across renders
   * this window did not cause. Rebuilding that identity every pass is the exact
   * wrong fix `core/SURFACE.md` §4.3 names.
   */
  const durableStateReachable = marks.unavailableReason === null;
  const state = React.useMemo(
    () => resolveTriageListShellState(window.snapshot, { durableStateReachable }),
    [durableStateReachable, window.snapshot],
  );
  const [surface, dispatch] = React.useReducer(
    reduceTriageSurfaceV1,
    props.subPath,
    seedFromLocation,
  );
  const refresh = React.useCallback(() => window.refresh('manual'), [window]);
  /**
   * `core/CORPUS.md` §4.2. The coordinator may already be refusing to read, and
   * a Refresh press that silently does nothing is exactly the failure it wants
   * surfaced. It is read at render rather than memoized because the answer ages
   * on its own clock, and the deadline is the coordinator's — never re-derived
   * here from lane health.
   */
  const refreshState = resolveTriageListRefreshV1(window.snapshot, Date.now());

  // The named view producer (`core/CORPUS.md` §4.1). Mounting *this page* is
  // what asks for a pass; the window hook itself only reads, so the Composer
  // picker — which is not a producer — reaches nothing merely by opening
  // (`REQ-14`). The shared minimum interval still collapses this demand with
  // every other one from this mount.
  const demand = window.refresh;
  React.useEffect(() => {
    void demand('view');
  }, [demand]);
  const pinHandlers = React.useMemo(() => ({
    busyKey: marks.busyKey,
    unavailableReason: marks.unavailableReason,
    onSetPinned: marks.setPinned,
  }), [marks.busyKey, marks.setPinned, marks.unavailableReason]);

  /**
   * The reader's pins are planned even with no window at all
   * (`core/SURFACE.md` §6.2, reachability state 5): they are Collection state,
   * so a machine nobody can reach does not make them disappear. The lane
   * sections plan from no rows and carry `partial` coverage, which is exactly
   * what is true — nothing has been walked.
   */
  const sections = React.useMemo(
    () => (state.kind === 'window' || state.kind === 'sourcesUnreachable'
      ? planTriageListSections({
          rows: state.kind === 'window' ? state.window.rows : [],
          pins: marks.pins,
          coverage: state.kind === 'window' ? state.window.coverage : 'partial',
          morePins: marks.more,
        }).map((section) => ({
          ...section,
          title: section.key === 'pinned'
            ? text('plugins.triage.surface.section.pinned', section.title)
            : section.key === 'open'
              ? text('plugins.triage.surface.section.open', section.title)
              : text('plugins.triage.surface.section.done', section.title),
        }))
      : []),
    [marks.more, marks.pins, state, text],
  );
  /**
   * Entry rows only. A continuation row names no entry, so it takes part in
   * neither selection, activation, the reducer's visible order, nor the
   * row count the empty state is decided from.
   */
  const rowsByKey = React.useMemo(() => {
    const index = new Map<string, Readonly<{ sectionId: string; row: TriageListDisplayRowV1 }>>();
    for (const section of sections) {
      for (const item of section.data) {
        if (item.kind !== 'entry') continue;
        index.set(item.key, { sectionId: section.key, row: item.row });
      }
    }
    return index;
  }, [sections]);
  const rowCount = rowsByKey.size;
  const currentUiContextRows = React.useMemo(
    () => (state.kind === 'window'
      ? state.window.rows.filter((row) => rowsByKey.has(triageEntryRowKey(row.entryRef)))
      : []),
    [rowsByKey, state],
  );
  const currentUiContext = React.useMemo(
    () => projectTriageCurrentUiContextV1({ surface, visibleRows: currentUiContextRows }),
    [currentUiContextRows, surface],
  );

  useTriageCurrentUiContextPublication(hostApi, currentUiContext);

  /** Whether the reader has changed the lens yet; see `useTriageRouteBinding`. */
  const readerChangedLens = React.useRef(false);
  /**
   * The last edit this surface refused because its route would not fit
   * (`core/SURFACE.md` §3.2), and which kind of edit it was.
   *
   * It is state rather than a thrown-away boolean because a refusal the reader
   * cannot see is the failure itself, and it names the edit because "that entry
   * could not be opened" is the wrong sentence for a reader who pressed a
   * filter.
   */
  const [routeRefused, setRouteRefused] = React.useState<'selection' | 'lens' | null>(null);
  /**
   * Whether the reader's own lens is hiding rows, read from the one narrowing
   * owner (`ui/state/narrowing.ts`) rather than measured here.
   *
   * Both causes are carried separately because the two consumers need
   * different halves: the empty slot names the cause so it can name the way out
   * of it, while **Clear filters** clears facets only — a route-carried query
   * narrows the window too, but a button that says it clears filters and leaves
   * the query in place would be a control that does nothing.
   */
  const narrowing = readTriageLensNarrowingV1({
    filters: surface.filters,
    query: surface.search.query,
  });

  /**
   * The ONE path every reader-originated lens edit takes.
   *
   * `core/SURFACE.md` §3.2 requires the complete resulting route to be measured
   * *before* the reducer moves, and the only honest way to know what a route
   * will be is to ask the reducer what the state will be. So the action is
   * reduced here first, the resulting location is preflighted, and only then is
   * the same action dispatched. The reducer stays the single decision-maker for
   * what an edit means — this function never edits state itself — and there is
   * exactly one preflight site for row activation, order, the Smart precedence
   * and every facet.
   *
   * Row activation has TWO producers — the reader's own press and the adoption
   * of a settled location or a delivered launch — and both reach the reducer
   * through here. They used to disagree: the adoption dispatched raw, so the
   * same entry that was visibly refused when pressed opened silently when
   * launched, on a page whose URL then no longer named what was on screen.
   *
   * On refusal nothing at all happens: no dispatch, no write, and the prior
   * effective lens is what the reader keeps looking at.
   */
  const applyLensEdit = React.useCallback((
    action: TriageSurfaceActionV1,
    refusal: 'selection' | 'lens',
  ) => {
    const next = reduceTriageSurfaceV1(surface, action);
    if (next === surface) return;
    if (preflightTriageRouteLensV1(readTriageRouteLensV1(next)).kind === 'refused') {
      setRouteRefused(refusal);
      return;
    }
    setRouteRefused(null);
    readerChangedLens.current = true;
    dispatch(action);
  }, [surface]);

  /**
   * The one activation path. The shared `List` reports pointer, touch and
   * keyboard activation through the same key, and a row the window could not
   * qualify carries no instance — selecting it would open somebody else's
   * connection, so it is refused rather than approximated.
   */
  const activateRow = React.useCallback((key: string) => {
    const hit = rowsByKey.get(key);
    if (hit === undefined || hit.row.sourceInstanceId === null) return;
    applyLensEdit({
      kind: 'rowActivated',
      sectionId: hit.sectionId,
      entryRef: hit.row.entryRef,
      sourceInstanceId: hit.row.sourceInstanceId,
    }, 'selection');
  }, [applyLensEdit, rowsByKey]);

  /**
   * The one focus producer (`core/SURFACE.md` §3.1).
   *
   * Movement itself belongs to the shared `List`: only it can traverse the
   * whole flattened order, including the rows its virtualizer has not mounted,
   * so this records where the reader IS rather than deciding where they go. It
   * is deliberately not a lens edit — focus is never routed — so it dispatches
   * directly instead of going through the route preflight. A continuation row
   * names no entry and is absent from `rowsByKey`, so it moves no cursor, which
   * is the same rule selection and activation already follow.
   */
  const focusRow = React.useCallback((key: string) => {
    const hit = rowsByKey.get(key);
    if (hit === undefined) return;
    dispatch({ kind: 'rowFocused', sectionId: hit.sectionId, entryRef: hit.row.entryRef });
  }, [rowsByKey]);

  const toggleFilterValue = React.useCallback((selection: TriageFilterFacetValueV1) => {
    applyLensEdit({ kind: 'filterValueToggled', ...selection }, 'lens');
  }, [applyLensEdit]);
  const clearFilters = React.useCallback(() => {
    applyLensEdit({ kind: 'filtersCleared' }, 'lens');
  }, [applyLensEdit]);
  const changeOrder = React.useCallback((order: TriageSurfaceStateV1['order']) => {
    applyLensEdit({ kind: 'orderChanged', order }, 'lens');
  }, [applyLensEdit]);
  const changeSmartPolicy = React.useCallback((smartPolicy: CorpusSmartPolicyV1) => {
    applyLensEdit({ kind: 'smartPolicyChanged', smartPolicy }, 'lens');
  }, [applyLensEdit]);
  /**
   * The settled query, taken by the same preflighted path as every other lens
   * edit — a query is routed, so a query too long for the location must be
   * refused rather than applied to a page whose URL cannot name it.
   *
   * The reducer's `searchComposing` arm has no producer here on purpose: the
   * shared `List` reports settled text, not IME-intermediate composition, so
   * there is nothing half-typed for this surface to hold back.
   */
  const changeSearch = React.useCallback((query: string) => {
    applyLensEdit({ kind: 'searchChanged', query }, 'lens');
  }, [applyLensEdit]);

  /**
   * The sources currently configured, as the read-side saved-view resolver
   * names them. A view is applied exactly as stored even when it names a source
   * the reader has since removed, and this is what lets the surface say so
   * rather than quietly widening the lens (`settings/effectiveView.ts`).
   */
  const configuredSourceIdentities = React.useMemo(
    () => window.snapshot.configuredSources.map((summary) => summary.source),
    [window.snapshot.configuredSources],
  );
  const storedViews = savedViews.saved?.value.views ?? NO_SAVED_VIEWS;
  const selectedStoredView = React.useMemo(
    () => storedViews.find((view) => view.viewId === surface.selectedViewId) ?? null,
    [storedViews, surface.selectedViewId],
  );
  /**
   * The stored view the REDUCER names, resolved through the one read-side
   * owner. The reducer's id is used rather than the Settings one because a
   * copied location can name a view this Account has not selected, and the
   * control has to name the lens on screen rather than the durable preference
   * behind it.
   */
  const effectiveView = React.useMemo(() => {
    const saved = savedViews.saved;
    if (saved === null || saved.kind === 'unreadable') return null;
    return resolveTriageEffectiveView({
      saved: { kind: saved.kind, value: { ...saved.value, selectedViewId: surface.selectedViewId } },
      configuredSources: configuredSourceIdentities,
    });
  }, [configuredSourceIdentities, savedViews.saved, surface.selectedViewId]);

  /**
   * One applied saved-view projection becomes this page's lens.
   *
   * The lens is taken from `settings/effectiveView.ts` rather than from the
   * control's own idea of the view, so there is exactly one place a stored view
   * turns into a lens — the same one the restore path uses.
   */
  const applyProjectedSelection = React.useCallback((projection: CorpusSavedViewsReadV1) => {
    const effective = resolveTriageEffectiveView({
      saved: projection,
      configuredSources: configuredSourceIdentities,
    });
    if (effective.viewId === null) return;
    applyLensEdit({
      kind: 'savedViewApplied',
      viewId: effective.viewId,
      filters: effective.filters,
      order: effective.order,
      smartPolicy: effective.smartPolicy,
    }, 'lens');
  }, [applyLensEdit, configuredSourceIdentities]);

  const selectView = React.useCallback((viewId: string | null) => {
    void (async () => {
      const projection = await savedViews.administer(triageSelectSavedViewInputV1(viewId));
      if (projection === null) return;
      // Choosing "no saved view" detaches the lens from the view; it does not
      // reset it. The reader is still looking at what they were looking at.
      if (viewId === null) {
        applyLensEdit({ kind: 'savedViewSelectionCleared' }, 'lens');
        return;
      }
      applyProjectedSelection(projection);
    })();
  }, [applyLensEdit, applyProjectedSelection, savedViews]);

  const createView = React.useCallback((label: string) => {
    void (async () => {
      const projection = await savedViews.administer(triageCreateSavedViewInputV1(label, {
        filters: surface.filters,
        order: surface.order,
        smartPolicy: surface.smartPolicy,
      }));
      if (projection !== null) applyProjectedSelection(projection);
    })();
  }, [applyProjectedSelection, savedViews, surface.filters, surface.order, surface.smartPolicy]);

  const renameView = React.useCallback((view: CorpusSavedViewV1, label: string) => {
    // A rename keeps the stored lens, so nothing on screen changes.
    void savedViews.administer(triageRenameSavedViewInputV1(view, label));
  }, [savedViews]);

  const updateView = React.useCallback((view: CorpusSavedViewV1) => {
    // The one explicit write of the lens the reader is looking at. Nothing is
    // dispatched: the lens is already on screen, and it is the stored view that
    // moves to meet it.
    void savedViews.administer(triageUpdateSavedViewInputV1(view, {
      filters: surface.filters,
      order: surface.order,
      smartPolicy: surface.smartPolicy,
    }));
  }, [savedViews, surface.filters, surface.order, surface.smartPolicy]);

  const deleteView = React.useCallback((view: CorpusSavedViewV1) => {
    void (async () => {
      const projection = await savedViews.administer(triageDeleteSavedViewInputV1(view.viewId));
      if (projection === null) return;
      // The one CAS owner cleared the selection in the same write; the lens the
      // deleted view produced is still what the reader is looking at.
      if (view.viewId === surface.selectedViewId) {
        applyLensEdit({ kind: 'savedViewSelectionCleared' }, 'lens');
      }
    })();
  }, [applyLensEdit, savedViews, surface.selectedViewId]);

  const facets = React.useMemo(
    () => planTriageFilterFacetsV1({
      configuredSources: window.snapshot.configuredSources,
      filters: surface.filters,
    }, text),
    [surface.filters, text, window.snapshot.configuredSources],
  );

  const selectedKey = React.useMemo(() => {
    const selection = surface.selection;
    if (selection === null) return null;
    for (const [key, hit] of rowsByKey) {
      if (sameTriageEntryRefV1(hit.row.entryRef, selection.entryRef)) return key;
    }
    return null;
  }, [rowsByKey, surface.selection]);

  /**
   * The window row behind the selection.
   *
   * The detail region is composed from the projection row, not the display row:
   * the strict detail input needs the applied observation, and the display
   * projection deliberately keeps only what a list row shows.
   */
  const selectedRow = React.useMemo<TriageListRowV1 | null>(() => {
    const selection = surface.selection;
    if (selection === null || state.kind !== 'window') return null;
    const row = state.window.rows.find(
      (candidate) => sameTriageEntryRefV1(candidate.entryRef, selection.entryRef),
    );
    if (row === undefined) return null;
    if (row.selected.kind === 'selected'
      && row.selected.sourceInstanceId === selection.sourceInstanceId) return row;
    // `core/SURFACE.md` §3.1: the selection's `sourceInstanceId` IS the
    // selected-observation override, so it outranks the window's own answer for
    // this row wherever the two differ. The window qualifies every row it lists
    // for a reader who has chosen nothing; a reader who HAS chosen — by
    // pressing **View details** on one of two accounts that both observe this
    // entry — must not have that choice re-decided by a tie break.
    //
    // Nothing is substituted when the chosen connection cannot answer: whether
    // it holds a present observation, and whether it is still configured, stay
    // the detail region's and the detail read's own questions, and both already
    // refuse rather than fall through to another account.
    return {
      ...row,
      selected: {
        kind: 'selected',
        sourceInstanceId: selection.sourceInstanceId,
        reason: 'override',
      },
    };
  }, [state, surface.selection]);
  const selectedConnectionLabel = React.useMemo(() => {
    const selection = surface.selection;
    if (selection === null) return null;
    const summary = window.snapshot.configuredSources.find(
      (candidate) => candidate.sourceInstanceId === selection.sourceInstanceId,
    );
    return summary?.displayLabel ?? null;
  }, [surface.selection, window.snapshot.configuredSources]);

  const visibleOrder = React.useMemo(
    () => [...rowsByKey.values()].map((hit) => ({
      sectionId: hit.sectionId,
      entryRef: hit.row.entryRef,
    })),
    [rowsByKey],
  );
  const dismissDetail = React.useCallback(() => {
    readerChangedLens.current = true;
    dispatch({ kind: 'detailDismissed', visibleOrder });
  }, [visibleOrder]);

  useTriageWindowLensBinding(window.setLens, readTriageWindowLensV1(surface));
  useTriageRouteBinding(hostApi, surface, readerChangedLens);
  useTriageSavedViewBinding({
    saved: savedViews.saved,
    routeCarriedLens,
    readerChangedLens,
    configuredSources: configuredSourceIdentities,
    selectedViewId: surface.selectedViewId,
    applyLensEdit,
  });
  useTriageSettledLocation({
    subPath: props.subPath,
    launch: props.launch,
    surface,
    rowsByKey,
    // A launch may only be answered "this page does not list that entry" once a
    // window actually EXISTS to have listed it. `window` and `configureSources`
    // are the two states assembled from a completed pass
    // (`windowState.ts` returns `configureSources` for a completed pass over zero
    // configured sources). `initial`, `sourcesUnreachable` and `unavailable` all
    // mean NO window was ever assembled — in those, whether this page lists the
    // entry is UNKNOWN, not false, so the launch must stay pending rather than be
    // adopted and permanently qualified by its own instance over an empty
    // `rowsByKey`. Naming only `initial` here did exactly that, and additionally
    // showed "this entry is no longer in the list" over a page whose sources could
    // not be reached at all.
    windowSettled: state.kind === 'window' || state.kind === 'configureSources',
    applyLensEdit,
    dispatch,
    readerChangedLens,
  });

  if (state.kind === 'initial') {
    return (
      <Screen safeArea>
        <LoadingState
          titleKey="plugins.triage.surface.readingList"
          title={`Reading ${TRIAGE_DISPLAY_NAME}`}
        />
      </Screen>
    );
  }

  if (state.kind === 'unavailable') {
    return (
      <Screen safeArea>
        <ErrorState
          titleKey="plugins.triage.surface.listFailed"
          title="The list could not be read"
          description={state.message}
          action={<Button titleKey="plugins.triage.surface.refresh" title="Refresh" variant="secondary" onPress={refresh} />}
        />
      </Screen>
    );
  }

  if (state.kind === 'configureSources') {
    return (
      <Screen safeArea>
        <EmptyState
          titleKey="plugins.triage.surface.noSources.title"
          title="No sources are configured"
          descriptionKey="plugins.triage.surface.noSources.description"
          description="Connect a source in Settings to see its pull requests, issues and error groups here."
        />
      </Screen>
    );
  }

  /**
   * The assembled window, when there is one. The chrome below serves both it
   * and §6.2's reachability state 5, where the reader's pins are the only rows
   * and there is no window to make a freshness claim about.
   */
  const listWindow = state.kind === 'window' ? state : null;
  const empty = readTriageListEmptyState(state, rowCount, { narrowing, text });

  /**
   * `core/SURFACE.md` §2.1, stacked composition: the selection replaces the
   * list rather than appearing under it, and the list is not duplicated
   * underneath. Generic page Back clears the selection first — the route owner
   * declares that step — and only an unhandled Back leaves the page.
   */
  /**
   * Which of the two ordinary causes reached the header, decided from the fact
   * the reducer already carries rather than a second flag: a launch naming an
   * entry this page's lens never listed seeds the selection with no section,
   * while an entry that LEFT the window keeps the section it was listed under.
   *
   * The distinction is load-bearing because the sentences are not
   * interchangeable. "It may return on the next refresh" is TRUE for an entry
   * the window dropped and FALSE for one the reader's own filter excludes —
   * there, clearing the filter is what brings it back, and refreshing forever
   * would not.
   */
  const neverListedHere = surface.selection !== null && surface.selection.sectionId === null;

  if (surface.selection !== null) {
    return (
      <Screen safeArea>
        {selectedRow === null ? (
          /*
           * `core/SURFACE.md` §3.1 and §3.2: a selection the current window
           * does not hold still renders, and says so. Two states reach here and
           * both are ordinary — an entry that LEFT the window on a later pass,
           * and a validated launch naming an entry this page's own lens never
           * listed. Returning to the list on its own would look like the
           * surface closed the detail by itself in the first case and like the
           * launch did nothing at all in the second.
           */
          <Stack gap="small">
            <Row justify="space-between" align="center">
              <Heading
                level={2}
                value={neverListedHere
                  ? text('plugins.triage.surface.entryNotInFilter.heading', 'This entry is outside the current filter')
                  : text('plugins.triage.surface.entryGone.heading', 'This entry is no longer in the list')}
              />
              <Button titleKey="plugins.triage.surface.close" title="Close" variant="secondary" onPress={dismissDetail} />
            </Row>
            <EmptyState
              titleKey="plugins.triage.surface.entryGone.title"
              title="Nothing to show for it"
              descriptionKey={neverListedHere
                ? 'plugins.triage.surface.entryNotInFilter.description'
                : 'plugins.triage.surface.entryGone.description'}
              description={neverListedHere
                ? 'The filters on this page do not include this entry, so there is nothing here to open. Clear them to see it in the list.'
                : 'The current window no longer holds this entry, so there is nothing to open it with. It may return on the next refresh.'}
            />
          </Stack>
        ) : (
          <TriageDetailRegion
            row={selectedRow}
            lanes={listWindow?.window.lanes ?? []}
            connectionLabel={selectedConnectionLabel}
            onClose={dismissDetail}
          />
        )}
      </Screen>
    );
  }

  return (
    <Screen safeArea>
      <Stack gap="small">
        <Row justify="space-between" align="center">
          <Heading level={1} value={TRIAGE_DISPLAY_NAME} />
          <Button
            titleKey="plugins.triage.surface.refresh"
            title="Refresh"
            variant="secondary"
            busy={refreshState.kind === 'running'}
            disabled={refreshState.kind === 'blocked'}
            onPress={refresh}
          />
        </Row>

        {/*
          The wait, said before the press rather than after one that does
          nothing. It is a notice and not an error: nothing is broken, the next
          read is simply not due yet.
        */}
        {refreshState.kind !== 'blocked' ? null : (
          <Banner tone="info" {...readTriageRefreshPacingNotice(refreshState.reason, text)} />
        )}

        {/*
          `core/SURFACE.md` §6.2, reachability state 5. No machine could be
          reached for the sources, so there is no window and no freshness claim
          to make — but the reader's own durable state is still live, which is
          why this is a notice above their pins rather than a screen instead of
          them.
        */}
        {listWindow !== null ? null : (
          <Banner
            tone="warning"
            title={text('plugins.triage.surface.sourcesUnreachable.title', 'Your sources could not be reached')}
            description={text('plugins.triage.surface.sourcesUnreachable.description', 'Happier could not reach a machine for these sources, so nothing has been read yet. Your pins are still here, and Refresh tries again.')}
          />
        )}

        {/*
          `core/SURFACE.md` §6. The lens controls sit immediately above the
          freshness line so the coverage claim stays beside the controls that
          narrow it, and they wrap in render order rather than creating a second
          horizontal scroller.
        */}
        {/*
          `core/SURFACE.md` §6.5. The compact Views control sits above the
          facets it names, so the lens is read top-down: which saved view this
          is, then the constraints that make it up.
        */}
        <TriageViewsControl
          views={storedViews}
          selectedViewId={surface.selectedViewId}
          status={readTriageSavedViewLensStatusV1({
            selected: selectedStoredView,
            lens: {
              filters: surface.filters,
              order: surface.order,
              smartPolicy: surface.smartPolicy,
            },
            query: surface.search.query,
          })}
          // Only once a pass has answered: before one has, no source is
          // configured as far as this mount knows, and every view would be
          // reported as naming sources that are gone.
          namesUnavailableSources={state.kind === 'window'
            && (effectiveView?.unavailableSources.length ?? 0) > 0}
          busy={savedViews.busy}
          unavailableReason={savedViews.unavailableReason}
          unreadable={savedViews.saved?.kind === 'unreadable'}
          notice={savedViews.notice}
          text={text}
          onSelectView={selectView}
          onCreateView={createView}
          onRenameView={renameView}
          onUpdateView={updateView}
          onDeleteView={deleteView}
        />

        <TriageFilterRail
          facets={facets}
          order={surface.order}
          smartPolicy={surface.smartPolicy}
          filtered={narrowing.facets}
          text={text}
          onToggleFilterValue={toggleFilterValue}
          onClearFilters={clearFilters}
          onChangeOrder={changeOrder}
          onChangeSmartPolicy={changeSmartPolicy}
        />

        {/*
          Freshness is said out loud rather than implied by silence. A stale
          window still shows its rows, so the only way a reader can tell the
          difference between "current" and "as of the last successful pass" is
          if the surface says which one they are looking at.
        */}
        {listWindow === null ? null : (
          <Status
            tone={listWindow.refreshing ? 'info' : listWindow.stale ? 'muted' : 'success'}
            pulsing={listWindow.refreshing}
            label={listWindow.refreshing
              ? text('plugins.triage.surface.refreshing', 'Refreshing')
              : listWindow.stale
                ? text('plugins.triage.surface.lastKnown', 'Showing the last known list')
                : text('plugins.triage.surface.upToDate', 'Up to date')}
          />
        )}

        {/*
          `core/SURFACE.md` §3.2. The reader pressed a row and nothing opened,
          so the surface says why and says that nothing else changed. Without
          this the refusal is invisible: the list looks like it ignored the
          press, and the only other outcome available — opening the entry
          anyway — would leave the URL naming a different screen.
        */}
        {routeRefused === null ? null : routeRefused === 'selection' ? (
          <Banner
            tone="warning"
            title={text('plugins.triage.surface.routeTooLong.title', 'That entry could not be opened')}
            description={text('plugins.triage.surface.routeTooLong.description', 'Opening it would make this page’s shareable location longer than it can carry, so nothing was changed.')}
          />
        ) : (
          <Banner
            tone="warning"
            title={text('plugins.triage.surface.lensTooLong.title', 'That filter could not be applied')}
            description={text('plugins.triage.surface.lensTooLong.description', 'Applying it would make this page’s shareable location longer than it can carry, so nothing was changed. Clear a filter and try again.')}
          />
        )}

        {/*
          Only beside rows. With none, the empty slot below is already the
          failure — `readTriageListEmptyState` renders the same notice as an
          `ErrorState` with a retry — and a banner here would say it twice.

          The notice names the connection, not "a source": `REQ-01` asks for
          per-source health, and a reader with several connections configured
          cannot act on health that will not say whose it is.
        */}
        {listWindow?.failure == null || rowCount === 0 ? null : (
          <Banner tone="warning" {...readTriageListFailureNotice(listWindow.failure, text)} />
        )}

        {/*
          Pins are durable user intent with no upstream owner, so the way they
          can be quietly lost is said out loud: a store this mount could not
          reach. The other way — a page that does not hold them all — is now
          the Pinned section's own continuation row (`core/SURFACE.md` §4.2),
          because that is the section the limit belongs to. Saying it here as
          well would state one fact twice.
        */}
        {marks.unavailableReason === null ? null : (
          <Banner
            tone="warning"
            title={text('plugins.triage.surface.pinsUnavailable', 'Pins are unavailable')}
            description={marks.unavailableReason}
          />
        )}

        {marks.notice === null ? null : (
          <Status tone={marks.notice.tone} label={marks.notice.message} />
        )}

        <List<TriageListSectionItemV1>
          accessibilityLabel={TRIAGE_DISPLAY_NAME}
          density="compact"
          sections={sections}
          /*
            The shared `List`'s own search input, not a Triage one. Without it
            the route's query narrowed the window with nothing on screen naming
            it, so a copied link — or the reader's own Back — landed on a short
            list with no cause and no way out.

            `RETAIN_EVERY_ROW` is not a disabled filter: the corpus window owner
            already matched this query before it published a row
            (`projection/listWindow.ts#foldTriageListWindow`), and a second
            matcher here would be a second answer to "does this entry match",
            which is the split-brain class this program has already had to
            extract once.
          */
          search={{
            label: text('plugins.triage.surface.search', 'Search PRs & Issues'),
            value: surface.search.query,
            onValueChange: changeSearch,
            filter: RETAIN_EVERY_ROW,
          }}
          keyForItem={(item) => item.key}
          renderItem={(item, _index, sectionKey) => (item.kind === 'continuation'
            ? (
              <TriageListContinuationRow
                {...(sectionKey === TRIAGE_PINNED_SECTION_KEY
                  ? {
                      title: text('plugins.triage.surface.morePins.title', 'More pinned entries exist'),
                      description: text('plugins.triage.surface.morePins.description', 'This page shows your most recent pins; the rest are still pinned.'),
                    }
                  : {
                      title: text('plugins.triage.surface.moreEntries.title', 'More entries may exist'),
                      description: text('plugins.triage.surface.moreEntries.description', 'This window is bounded; sources that had not finished are still walking.'),
                    })}
              />
            )
            : renderTriageListRow(item.row, pinHandlers))}
          // The shared owner of activation, roving focus, the tab stop and the
          // option semantics. Without it every row rendered as inert text and a
          // reader had no way to open anything.
          selection={{ selectedKey, onSelectedKeyChange: activateRow, onFocusedKeyChange: focusRow }}
          empty={empty === null ? null : empty.kind === 'sourceFailure' ? (
            <ErrorState
              title={empty.title}
              description={empty.description}
              action={<Button titleKey="plugins.triage.surface.refresh" title="Refresh" variant="secondary" onPress={refresh} />}
            />
          ) : (
            <EmptyState
              title={text(readTriageListEmptyStateKeys(empty.kind).title, empty.title)}
              description={text(readTriageListEmptyStateKeys(empty.kind).description, empty.description)}
            />
          )}
        />
      </Stack>
    </Screen>
  );
}

/**
 * Follow the entry this page was asked to show back into the reducer's
 * selection — whether the host settled it as a location or delivered it as a
 * launch argument.
 *
 * This is the other half of the route binding, and without it the shareable
 * location is write-only. Three things depend on it and all three are ordinary
 * product behavior rather than edge cases:
 *
 * - **Back closes the detail.** The route owner declares a page-internal Back
 *   step whose location has no selection. The host settles it, and the only
 *   thing that reaches this surface is a new `subPath` — so a mount that read
 *   its location once, at construction, left the reader on a detail screen the
 *   system Back button appeared to do nothing to.
 * - **A copied link opens the entry.** The reducer cannot seed a selection from
 *   a location alone, because a selection carries the qualified connection and
 *   the route deliberately never names one — only the window does. So a located
 *   adoption waits for the window: as soon as a row for that exact entry is
 *   qualified, the same `rowActivated` the reader's own press produces is
 *   applied here.
 * - **Composer View details opens the entry.** A launch names an entry the
 *   page's own location does not, so it takes precedence over the location for
 *   exactly as long as it is unadopted. Unlike a location it carries its OWN
 *   qualified connection, so it does not need the window to supply one — which
 *   is why it selects even when this page's lens does not list the entry. That
 *   ref is not a bounded-window edge case: a page left carrying a query or a
 *   facet is an ordinary reader state, and `core/SURFACE.md` §3.2 with
 *   `core/COMPOSER.md` §7 require it to select behind the honest
 *   not-yet-materialized header rather than to produce nothing at all.
 *
 * Every selection this hook makes goes through the shell's one `applyLensEdit`,
 * so the complete resulting route is measured BEFORE the reducer moves, exactly
 * as it is for a press. Two consequences are deliberate. An adoption whose route
 * would not fit is REFUSED and shown, rather than opening a detail the URL
 * cannot name; so the route owner writes the result of every adoption it
 * accepts, and there is no accepted selection it did not write. And an adoption
 * that is refused is not adopted, so the launch stays pending — the honest state
 * for an open that did not happen.
 *
 * It never writes a location of its own, and the rules are deliberately not
 * symmetric.
 *
 * Neither rule may read a **stale** location, and the prop is stale for exactly
 * as long as a write this mount asked for is in flight. Dismissal has always
 * required the incoming location to have actually **changed** for that reason:
 * a rule that read the stale value would clear the selection the reader just
 * made. Adoption needs the same guard and used to lack it, which was invisible
 * only while the location the mount was leaving named no OTHER entry. It does
 * as soon as one selection replaces another — a launch opening B over a page
 * standing on A, or the reader closing a deep-linked detail — and the stale
 * location would pull them straight back to the entry they left. So the
 * location is read as current only when the host has just handed it over, or
 * when this mount has produced no lens intent of its own yet.
 *
 * A launch is adopted at most once, and it outranks the location while it is
 * unadopted: it is the entry the page was OPENED at, and the location it is
 * standing on has already been asked to move. The host retires a delivered open
 * when the page's location moves, so the value normally disappears on its own
 * the moment that write settles — but the reader can close the detail before
 * that, and a launch re-read after they did would reopen it behind them.
 */
function useTriageSettledLocation(input: Readonly<{
  subPath: string | undefined;
  launch: TriageEntryDetailLaunchInputV1 | undefined;
  surface: TriageSurfaceStateV1;
  rowsByKey: ReadonlyMap<string, Readonly<{ sectionId: string; row: TriageListDisplayRowV1 }>>;
  /**
   * Whether a pass has answered for this mount. Before one has, an absent row
   * means "not read yet", not "this page's lens excludes it" — and only the
   * second is a launch this window will never materialize.
   */
  windowSettled: boolean;
  /** The shell's one preflighted lens-edit path; see `applyLensEdit`. */
  applyLensEdit: (action: TriageSurfaceActionV1, refusal: 'selection' | 'lens') => void;
  dispatch: React.Dispatch<TriageSurfaceActionV1>;
  readerChangedLens: React.RefObject<boolean>;
}>): void {
  const {
    applyLensEdit,
    dispatch,
    launch,
    readerChangedLens,
    rowsByKey,
    subPath,
    surface,
    windowSettled,
  } = input;
  const selection = surface.selection;
  /** The last location the host actually handed this mount. */
  const observedSubPath = React.useRef(subPath);
  /** The delivered open this mount has already turned into a selection. */
  const adoptedLaunch = React.useRef<TriageEntryDetailLaunchInputV1 | undefined>(undefined);

  React.useEffect(() => {
    const changed = observedSubPath.current !== subPath;
    observedSubPath.current = subPath;

    const pendingLaunch = launch !== undefined && adoptedLaunch.current !== launch ? launch : null;
    // The location speaks for the host only while it is one the host has just
    // handed over, or while this mount has produced no intent of its own yet.
    // In between — a selection accepted and its replacement still in flight —
    // the prop names the location the mount is LEAVING, and reading it as
    // current would pull the reader back to the entry they left.
    if (pendingLaunch === null && !changed && readerChangedLens.current) return;
    const located = pendingLaunch === null
      ? parseTriageRouteSubPathV1(subPath).selection
      : pendingLaunch.entryRef;

    if (located === null) {
      if (selection === null || !changed) return;
      // The settled location no longer names an entry — the host walked its own
      // Back step — so the selection it named is gone with it.
      dispatch({
        kind: 'detailDismissed',
        visibleOrder: [...rowsByKey.values()].map((hit) => ({
          sectionId: hit.sectionId,
          entryRef: hit.row.entryRef,
        })),
      });
      return;
    }

    // A launch names ONE exact connection, and it is the connection every
    // branch below selects with. The launch-input parser already refused a pair
    // whose connection could not have observed the entry rather than
    // substituting one, and a page that reopened the entry under whichever
    // connection its own window happened to qualify would undo that refusal
    // after the fact — **View details** on the account the reader chose,
    // silently acting through another they also happen to have configured.
    const launchInstanceId = pendingLaunch === null
      ? null
      : pendingLaunch.sourceInstance.sourceInstanceId;

    if (selection !== null && sameTriageEntryRefV1(selection.entryRef, located)) {
      // The reducer is showing the named entry, so a pending launch has done
      // its whole job and is retired HERE rather than where it is dispatched:
      // this is the one place both routes into the selection converge, and it
      // is also the truthful condition — an open that named the entry already
      // on screen is just as consumed as one that had to change it.
      //
      // "The named entry" is the entry AND its connection. Entry identity alone
      // retires a launch that still has to move the selection off another
      // account, leaving the reader on a detail the launch did not ask for.
      if (launchInstanceId === null || selection.sourceInstanceId === launchInstanceId) {
        adoptedLaunch.current = launch;
        return;
      }
    }
    for (const hit of rowsByKey.values()) {
      if (!sameTriageEntryRefV1(hit.row.entryRef, located)) continue;
      // A row the window could not qualify carries no connection, and opening
      // one anyway would read somebody else's. That is a rule about a LOCATION,
      // which names no connection at all: the entry stays unadopted until a
      // pass qualifies it. A launch is not in that position — it carries its
      // own qualified connection — so it selects on its own authority here for
      // the same reason it does below.
      const sourceInstanceId = launchInstanceId ?? hit.row.sourceInstanceId;
      if (sourceInstanceId === null) return;
      applyLensEdit({
        kind: 'rowActivated',
        sectionId: hit.sectionId,
        entryRef: hit.row.entryRef,
        sourceInstanceId,
      }, 'selection');
      return;
    }

    // No row on this page names the entry. A LOCATION can only wait — it names
    // no connection, so there is nothing to select with. A LAUNCH carries its
    // own qualified connection, already checked against the entry's source by
    // the one launch-input parser, so once a pass has answered it selects and
    // the header says the window does not hold the entry. Until one has, the
    // launch waits, so a page still reading keeps taking the row's own
    // qualification when its pass does list the entry.
    if (pendingLaunch === null || !windowSettled) return;
    applyLensEdit({
      kind: 'rowActivated',
      sectionId: null,
      entryRef: pendingLaunch.entryRef,
      sourceInstanceId: pendingLaunch.sourceInstance.sourceInstanceId,
    }, 'selection');
  }, [
    applyLensEdit,
    dispatch,
    launch,
    readerChangedLens,
    rowsByKey,
    selection,
    subPath,
    windowSettled,
  ]);
}

/**
 * Bind the durable saved-view state to this page's lens.
 *
 * It owns exactly the two rules `core/SURFACE.md` §6.5 states about a page that
 * is starting or has drifted, and neither of them writes Settings:
 *
 * - **Restore.** On the first authoritative answer, a page whose location
 *   carried no lens of its own applies the selected view's exact facets, order
 *   and policy. A page that DID arrive carrying a lens keeps it: the location
 *   the reader followed is the more specific statement of what they came to
 *   look at, and overwriting it with a durable preference would make every
 *   copied link land somewhere else.
 * - **Clear.** A selected id the stored set does not answer to — deleted on
 *   another device, or belonging to another Account — is cleared, and only the
 *   id. The facets, order and policy beside it survive, because they are what
 *   the reader is looking at and nothing about them became wrong.
 *
 * A set this build cannot read clears nothing. "I cannot parse this" is not
 * "your view is gone", and acting on the second would drop a live selection on
 * the say-so of a value written by a newer client.
 */
function useTriageSavedViewBinding(input: Readonly<{
  saved: CorpusSavedViewsReadV1 | null;
  routeCarriedLens: boolean;
  /** Whether this mount has produced a lens intent of its own yet. */
  readerChangedLens: React.RefObject<boolean>;
  configuredSources: readonly PluginContributionIdentity[];
  selectedViewId: string | null;
  applyLensEdit: (action: TriageSurfaceActionV1, refusal: 'selection' | 'lens') => void;
}>): void {
  const {
    applyLensEdit,
    configuredSources,
    readerChangedLens,
    routeCarriedLens,
    saved,
    selectedViewId,
  } = input;
  /** One restore attempt per mount, on the first answer this mount receives. */
  const restored = React.useRef(false);

  React.useEffect(() => {
    // `null` is "not read yet", which is neither an empty set nor an unknown
    // view: clearing on it would drop a location-carried selection every time.
    if (saved === null) return;

    if (!restored.current) {
      restored.current = true;
      // A restore is what a page does BEFORE its reader has said anything. An
      // Account read is a round trip, and a reader who narrowed the list while
      // it was in flight has stated something more current than the preference
      // behind it — applying the view over that would take their edit away
      // several seconds after they made it.
      if (!readerChangedLens.current
        && !routeCarriedLens
        && saved.kind !== 'unreadable'
        && saved.value.selectedViewId !== null) {
        const effective = resolveTriageEffectiveView({ saved, configuredSources });
        if (effective.viewId !== null) {
          applyLensEdit({
            kind: 'savedViewApplied',
            viewId: effective.viewId,
            filters: effective.filters,
            order: effective.order,
            smartPolicy: effective.smartPolicy,
          }, 'lens');
          return;
        }
      }
    }

    if (selectedViewId === null || saved.kind === 'unreadable') return;
    if (saved.value.views.some((view) => view.viewId === selectedViewId)) return;
    applyLensEdit({ kind: 'savedViewSelectionCleared' }, 'lens');
  }, [
    applyLensEdit,
    configuredSources,
    readerChangedLens,
    routeCarriedLens,
    saved,
    selectedViewId,
  ]);
}

/**
 * Write the reducer's lens back to the host, once per settled reader change.
 *
 * The host owns history and settlement, so nothing here mirrors the location
 * locally or pushes its own entry. A host that publishes no same-page
 * replacement is a refusal the route owner already reports, and the page keeps
 * working without a shareable URL rather than failing to mount.
 *
 * Nothing is written until the reader actually changes the lens. The location a
 * page was opened at is the host's, and a mount that wrote its own lens
 * immediately would erase the entry a Composer **View details** just navigated
 * to — the reducer cannot seed a selection from a location alone, because a
 * selection needs the qualified instance only the window can supply.
 */
function useTriageRouteBinding(
  hostApi: PluginUiHostApi,
  surface: TriageSurfaceStateV1,
  readerChangedLens: React.RefObject<boolean>,
): void {
  const lens = readTriageRouteLensV1(surface);
  const grouping = lens.grouping;
  const order = lens.order;
  const smartPolicy = lens.smartPolicy;
  const filters = lens.filters;
  const query = lens.query;
  const selectedViewId = lens.selectedViewId;
  const selection = lens.selection;

  React.useEffect(() => {
    if (!readerChangedLens.current) return undefined;
    const controller = new AbortController();
    void writeTriageRouteLensV1(
      hostApi,
      { grouping, order, smartPolicy, filters, query, selectedViewId, selection },
      { signal: controller.signal },
    );
    return () => { controller.abort(); };
  }, [
    filters,
    grouping,
    hostApi,
    order,
    query,
    readerChangedLens,
    selectedViewId,
    selection,
    smartPolicy,
  ]);
}

/**
 * Publish the reducer's lens to the one mounted window.
 *
 * Without this the whole lens layer is decorative: the reducer would hold an
 * order and five facets, the location would name them, and the rows on screen
 * would be whatever the window's own default lens produced. That is the failure
 * this binding exists to close — a URL that asserts a lens the list never
 * applied.
 *
 * The lens is destructured so the effect depends on its parts rather than on a
 * new object each render. Every part is either a primitive or a reducer value
 * whose identity changes exactly when the reader changed it, so a settled corpus
 * result — or a focus move — cannot make this look like a lens edit and mark the
 * window stale.
 */
function useTriageWindowLensBinding(
  setLens: (lens: TriageListLensV1) => void,
  lens: TriageListLensV1,
): void {
  const { filters, limit, order, query, smartPolicy } = lens;

  React.useEffect(() => {
    setLens({ filters, limit, order, query, smartPolicy });
  }, [filters, limit, order, query, setLens, smartPolicy]);
}
