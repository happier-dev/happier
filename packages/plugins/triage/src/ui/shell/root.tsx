import * as React from 'react';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import type { PluginUiContextEnrichmentV1, PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import type { TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';
import {
  Banner,
  Button,
  EmptyState,
  ErrorState,
  Heading,
  Item,
  ItemGroup,
  List,
  LoadingState,
  Row,
  Screen,
  Stack,
  Status,
  useListMultiSelectionController,
  usePluginAccessibility,
  usePluginHostApi,
  usePluginSurfaceActivity,
  usePluginTheme,
  usePluginTranslation,
  useSurfaceContext,
  type LayoutChangeEvent,
} from '@happier-dev/plugin-ui';
import { scaleTextStyleMetrics } from '@happier-dev/plugin-ui/presentation';

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
import { projectTriageDetailHeaderV1 } from '../detail/header.js';
import { TriageDetailHeaderView, TriageDetailRegion } from '../detail/region.js';
import {
  resolveTriageSourcePrepareReviewWorkspaceOperationV1,
  resolveTriageSourceWorkflowSubjectV1,
} from '../detail/sourceSurface.js';
import { TriageFilterRail } from '../filters/rail.js';
import { planTriageFilterFacetsV1 } from '../filters/plan.js';
import {
  TRIAGE_PINNED_SECTION_KEY,
  isTriageListSectionItemSelectable,
  planTriageListSections,
  type TriageListSectionItemV1,
} from '../list/sections.js';
import { TriageBulkActionBar } from '../list/BulkActionBar.js';
import { useTriageRetainedComposerOriginV1 } from './retainedComposerOrigin.js';
import {
  projectTriageBulkSelectedEntriesV1,
  type TriageBulkSelectedEntryV1,
} from '../list/bulkSelectionEntries.js';
import { readTriageBulkSelectionScopeKeyV1 } from '../list/bulkSelectionScope.js';
import type { TriageBulkSessionDestinationV1 } from '../list/bulkSessionPlan.js';
import { useTriageBulkEntrySessions } from '../list/useBulkEntrySessions.js';
import { planTriageListContinuationV1, type TriageListContinuationCopyV1 } from '../list/continuation.js';
import {
  readTriageListSectionItemKey,
  useTriageListRowRenderer,
} from '../list/rows.js';
import {
  indexTriagePinsByEntry,
  projectTriageWindowRow,
  type TriageListDisplayRowV1,
} from '../marks/pinnedRows.js';
import { useTriagePinnedEntries } from '../marks/useTriagePinnedEntries.js';
import {
  hasTriageRouteLensV1,
  createTriageRouteWriteQueueV1,
  parseTriageRouteSubPathV1,
  preflightTriageRouteLensV1,
  readTriageRouteLensV1,
} from '../navigation/location.js';
import { TriageActionsEditor } from '../actions/ActionsEditor.js';
import { useTriageActions } from '../actions/useTriageActions.js';
import { useTriageConfiguredSources } from '../configuration/useTriageConfiguredSources.js';
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
import type { TriageActionV1 } from '../../settings/actions.js';
import { resolveTriageActionTargetV1 } from '../state/actionTarget.js';
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
import { useTriageListWindowViewDemand } from '../window/useTriageListWindowViewDemand.js';
import {
  planTriageConfigureSourceOffersV1,
  type TriageConfigureSourceOfferV1,
} from './configureSources.js';
import { readTriageListEmptyState, readTriageListEmptyStateKeys } from './emptyState.js';
import { retainTriageLastKnownRowV1, type TriageLastKnownRowV1 } from './lastKnownRow.js';
import {
  resolveTriageLayoutV1,
  type TriageLayoutV1,
  type TriageScaledTypeMetricsV1,
} from './layout.js';
import { readTriageWindowLensV1 } from './lens.js';
import {
  readTriageListFailureNotice,
  readTriageRefreshPacingNotice,
  resolveTriageListRefreshV1,
  resolveTriageListShellState,
} from './windowState.js';

const EMPTY_WINDOW_ROWS: readonly TriageListRowV1[] = Object.freeze([]);
const EMPTY_BULK_KEYS: readonly string[] = Object.freeze([]);

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
 * it with the common header plus the source's own body. The split composition
 * uses the same two children under the measured fill width below. The mount
 * never guesses from a platform label, so switching layouts preserves the one
 * list and one detail lifetime.
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

/**
 * The measured fill region, as automation identity.
 *
 * It is exported because the platform's own layout observer is the only
 * production producer of the measurement, and a mounted test has to be able to
 * reach the exact box that asked to be measured rather than assert against a
 * width nothing in production would have produced.
 */
export const TRIAGE_SHELL_FILL_TEST_ID_V1 = 'triage-shell-fill';

/**
 * The list region, as automation identity.
 *
 * Exported for the same reason the fill region is: the fact under test is that
 * this box is still MOUNTED while a stacked detail is open, which no semantic
 * query can observe — a subtree the platform has hidden is correctly absent
 * from the accessibility tree, and that absence is the point.
 */
export const TRIAGE_SHELL_LIST_REGION_TEST_ID_V1 = 'triage-shell-list-region';

/** The single responsive container that owns the mounted source detail. */
export const TRIAGE_SHELL_DETAIL_REGION_TEST_ID_V1 = 'triage-shell-detail-region';

/**
 * What "mounted but not on screen" is, in one place.
 *
 * `display: 'none'` is a real platform contract on both React Native and React
 * Native Web: the box is not laid out, cannot be hit, takes no tab stop and is
 * not exposed to assistive technology. Anything weaker — zero opacity, an
 * off-screen offset — leaves a screen reader walking a list the reader cannot
 * see and a Tab key landing inside it.
 */
const TRIAGE_INACTIVE_REGION_STYLE_V1 = Object.freeze({ display: 'none' as const });
const TRIAGE_FILL_STYLE_V1 = Object.freeze({
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden' as const,
});
const TRIAGE_LIST_STYLE_V1 = Object.freeze({ flex: 1, minHeight: 0 });

/**
 * The reader's own type size applied to the host's four measured text roles.
 *
 * The scaling itself belongs to `plugin-ui`'s canonical text-scale owner, the
 * same one every `Text` on this page goes through. Multiplying the host's
 * typography here instead would be a second text-scale decision, and the two
 * would disagree the first time either rounded differently — with the pane
 * minima quietly measuring a size nothing on screen is drawn at.
 */
function readTriageScaledTypeMetricsV1(
  typography: ReturnType<typeof usePluginTheme>['typography'],
  textScale: number,
): TriageScaledTypeMetricsV1 {
  return {
    title: scaleTextStyleMetrics(typography.title, textScale),
    body: scaleTextStyleMetrics(typography.body, textScale),
    caption: scaleTextStyleMetrics(typography.caption, textScale),
    label: scaleTextStyleMetrics(typography.label, textScale),
  };
}

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
  const surfaceContext = useSurfaceContext();
  const surfaceActivity = usePluginSurfaceActivity();
  const text = usePluginTranslation();
  const window = useTriageListWindow();
  const marks = useTriagePinnedEntries();
  const savedViews = useTriageSavedViews();
  /**
   * The ONE configured-action read for this page.
   *
   * The editor writes it and the detail region's controls are built from it, so
   * a second read would let the two disagree about the same durable Account
   * configuration between two settled writes.
   */
  const configuredActions = useTriageActions();
  const configuredSources = useTriageConfiguredSources();
  const [editingActions, setEditingActions] = React.useState(false);
  const [editingSources, setEditingSources] = React.useState(false);
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
  const [listFocusRequest, setListFocusRequest] = React.useState<Readonly<{ key: string }> | undefined>();
  const refresh = React.useCallback(() => window.refresh('manual'), [window]);
  /**
   * `core/CORPUS.md` §4.2. The coordinator may already be refusing to read, and
   * a Refresh press that silently does nothing is exactly the failure it wants
   * surfaced. It is read at render rather than memoized because the answer ages
   * on its own clock, and the deadline is the coordinator's — never re-derived
   * here from lane health.
   */
  const refreshState = resolveTriageListRefreshV1(window.snapshot, Date.now());

  // The named page-view producers (`core/CORPUS.md` §4.1): mount, then every
  // host-owned active regain. The window hook itself only reads, so the
  // Composer picker — which is not a producer — reaches nothing merely by
  // opening (`REQ-14`). The adapter emits only `view` demand; the mounted store
  // remains the one owner of coalescing, pacing and provider work.
  useTriageListWindowViewDemand(surfaceActivity.active, window.refresh);
  const pinHandlers = React.useMemo(() => ({
    busyKey: marks.busyKey,
    unavailableReason: marks.unavailableReason,
    onSetPinned: marks.setPinned,
  }), [marks.busyKey, marks.setPinned, marks.unavailableReason]);

  /**
   * The row renderer and the key reader the shared `List` memoizes on.
   *
   * `List` rebuilds its flattened traversal order, its key index, its roving
   * entries and every mounted cell whenever either identity changes. Focus
   * movement dispatches `rowFocused`, so an inline lambda here made every
   * cursor step reproject the entire window — the exact locality the shared
   * virtualizer exists to provide. These two bind only to what a row's content
   * actually depends on.
   */
  const windowLoadMore = window.snapshot.loadMore;
  const pinsLoadMore = marks.loadMore;
  const continuationCopy = React.useCallback(
    (sectionKey: string | null): TriageListContinuationCopyV1 => (
      sectionKey === TRIAGE_PINNED_SECTION_KEY
        ? planTriageListContinuationV1({ section: 'pins', state: pinsLoadMore, text })
        : planTriageListContinuationV1({ section: 'entries', state: windowLoadMore, text })
    ),
    [pinsLoadMore, text, windowLoadMore],
  );
  /**
   * The two continuations are two operations, not one, and the row that closes
   * a section demands the one that section pages by: the lanes append another
   * bounded window from the sources, while Pinned walks another bounded page of
   * the reader's own Collection. Routing both through a single "load more"
   * would make a press in one section read the other.
   */
  const demandContinuation = React.useCallback((sectionKey: string | null) => {
    if (sectionKey === TRIAGE_PINNED_SECTION_KEY) {
      marks.loadMorePins();
      return;
    }
    void window.loadMore();
  }, [marks, window]);
  const renderRow = useTriageListRowRenderer({
    continuationCopy,
    onLoadMore: demandContinuation,
    handlers: pinHandlers,
  });

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
    setListFocusRequest(undefined);
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
  /** The settled query follows the same preflighted path as every routed lens edit. */
  const changeSearch = React.useCallback((query: string) => {
    applyLensEdit({ kind: 'searchChanged', query }, 'lens');
  }, [applyLensEdit]);
  /**
   * IME draft text is visible in the shared field but reaches neither the
   * corpus window nor the route. Composition end is followed by the shared
   * owner's one settled `onValueChange`, which clears this reducer arm.
   */
  const changeComposingSearch = React.useCallback((text: string | null) => {
    if (text !== null) dispatch({ kind: 'searchComposing', text });
  }, []);

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
    const expectedRevision = savedViews.revision;
    if (expectedRevision === null) return;
    void (async () => {
      const projection = await savedViews.administer(
        triageSelectSavedViewInputV1(viewId, expectedRevision),
      );
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
    const expectedRevision = savedViews.revision;
    if (expectedRevision === null) return;
    void (async () => {
      const projection = await savedViews.administer(triageCreateSavedViewInputV1(label, {
        filters: surface.filters,
        order: surface.order,
        smartPolicy: surface.smartPolicy,
      }, expectedRevision));
      if (projection !== null) applyProjectedSelection(projection);
    })();
  }, [applyProjectedSelection, savedViews, surface.filters, surface.order, surface.smartPolicy]);

  const renameView = React.useCallback((view: CorpusSavedViewV1, label: string) => {
    if (savedViews.revision === null) return;
    // A rename keeps the stored lens, so nothing on screen changes.
    void savedViews.administer(triageRenameSavedViewInputV1(view, label, savedViews.revision));
  }, [savedViews]);

  const updateView = React.useCallback((view: CorpusSavedViewV1) => {
    if (savedViews.revision === null) return;
    // The one explicit write of the lens the reader is looking at. Nothing is
    // dispatched: the lens is already on screen, and it is the stored view that
    // moves to meet it.
    void savedViews.administer(triageUpdateSavedViewInputV1(view, {
      filters: surface.filters,
      order: surface.order,
      smartPolicy: surface.smartPolicy,
    }, savedViews.revision));
  }, [savedViews, surface.filters, surface.order, surface.smartPolicy]);

  const deleteView = React.useCallback((view: CorpusSavedViewV1) => {
    const expectedRevision = savedViews.revision;
    if (expectedRevision === null) return;
    void (async () => {
      const projection = await savedViews.administer(
        triageDeleteSavedViewInputV1(view.viewId, expectedRevision),
      );
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
      ...(window.snapshot.window === undefined
        ? {}
        : { facetCensus: window.snapshot.window.facetCensus }),
      filters: surface.filters,
    }, text),
    [surface.filters, text, window.snapshot.configuredSources, window.snapshot.window],
  );

  /**
   * The one aggregate action target, read once for this render.
   *
   * The published surface context already reads it through the same owner
   * (`ui/currentContext.ts`), so resolving it here keeps what an agent is told
   * about the selection and what a press acts on as one answer.
   */
  const actionTarget = React.useMemo(
    () => resolveTriageActionTargetV1(surface),
    [surface],
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
  const pinsByEntry = React.useMemo(() => indexTriagePinsByEntry(marks.pins), [marks.pins]);
  const selectedConnectionLabel = React.useMemo(() => {
    const selection = surface.selection;
    if (selection === null) return null;
    const summary = window.snapshot.configuredSources.find(
      (candidate) => candidate.sourceInstanceId === selection.sourceInstanceId,
    );
    return summary?.displayLabel ?? null;
  }, [surface.selection, window.snapshot.configuredSources]);

  /**
   * The last row this window published for the selection the reader is holding
   * (`ui/shell/lastKnownRow.ts`).
   *
   * It is adjusted during render rather than in an effect because the render
   * that loses the row is the one that has to draw the header: settling it a
   * commit later would blank the entry for a frame and then bring it back,
   * which reads as the surface losing the entry and finding it again.
   */
  const [heldRow, setHeldRow] = React.useState<TriageLastKnownRowV1 | null>(null);
  /** The originating draft this detail may disclose evidence into, held by its own owner. */
  const detailOriginComposer = useTriageRetainedComposerOriginV1({
    launch: props.launch,
    selectedEntryRef: surface.selection?.entryRef ?? null,
  });

  const lastKnown = retainTriageLastKnownRowV1(heldRow, surface.selection, selectedRow);
  if (lastKnown !== heldRow) setHeldRow(lastKnown);
  const lastKnownPinRow = React.useMemo(() => (
    selectedRow !== null || lastKnown === null
      ? null
      : projectTriageWindowRow(lastKnown.row, pinsByEntry)
  ), [lastKnown, pinsByEntry, selectedRow]);
  /**
   * §2.2's header for a selection the window has stopped listing.
   *
   * The source's own detail is deliberately not read from a retained row: the
   * observation it carries is the one this page last saw, and handing a stale
   * observation to `entries/read-detail-v1` would present it to the source as
   * current. So the two members that only that read can supply — the source's
   * own name for itself and for this kind, and the entry's Session links —
   * arrive as "not known here", which is what the projection's nulls already
   * mean. The lane health is the CURRENT one: it is a fact about the connection
   * rather than about the entry, and it has not gone stale.
   */
  const lastKnownHeader = React.useMemo(() => (
    selectedRow !== null || lastKnown === null
      ? null
      : projectTriageDetailHeaderV1({
          row: lastKnown.row,
          lanes: state.kind === 'window' ? state.window.lanes : [],
          connectionLabel: selectedConnectionLabel,
          sourceDescriptor: null,
          linkedSessions: [],
          linkedSessionsHasMore: false,
        })
  ), [lastKnown, selectedConnectionLabel, selectedRow, state]);

  /**
   * The bulk set — a THIRD independent cursor.
   *
   * `core/SURFACE.md` §3.1 keeps `focus` and `selection` as two independent
   * SINGLE cursors, and that independence is load-bearing: keyboard traversal
   * never opens a detail, and opening a detail never moves the reading cursor.
   * A bulk set is neither of them, so it is NOT folded into the reducer: it is
   * the shared `List`'s own keyed multi-selection, the same owner the sessions
   * list binds (`@happier-dev/plugin-ui`'s collection multi-selection), mounted
   * here as an opt-in capability. Copying that reducer into this plugin would
   * be a second answer to what a modified press means.
   *
   * `rows: 'collection'` hands the visible order to the mounted `List` rather
   * than to this shell: only the List can see the rows its virtualizer has not
   * mounted, and a range extension or select-all measured from this file would
   * disagree with what the reader can actually reach.
   *
   * What counts as "the same list" is decided by its own owner
   * (`ui/list/bulkSelectionScope.ts`) rather than spelled here, so the rule can
   * be falsified directly — which is what caught the transient query being part
   * of it and silently clearing the set on every keystroke.
   */
  const bulkSelectionScopeKey = React.useMemo(
    () => readTriageBulkSelectionScopeKeyV1(surface),
    [surface],
  );
  const bulkSelection = useListMultiSelectionController({
    scopeKey: bulkSelectionScopeKey,
    rows: 'collection',
  });
  const windowRows = state.kind === 'window' ? state.window.rows : EMPTY_WINDOW_ROWS;
  const windowRowsRef = React.useRef(windowRows);
  windowRowsRef.current = windowRows;

  /**
   * The rows a bulk press can still act on after the list has moved under it.
   *
   * A query narrows the corpus walk UPSTREAM of the shared `List`, so a row the
   * reader selected and then typed past is not filtered out of the List's own
   * dataset — it never reaches the List at all, and its eligibility disappears
   * with it. Two facts are therefore held here for exactly as long as the scope
   * lives: the keys, so the selection owner knows those rows are HIDDEN rather
   * than gone, and the payload each one was selected with, so the press can
   * still start a Session for an entry the current window no longer lists.
   *
   * It is not a second selection: the set itself stays the shared owner's, and
   * this holds nothing the owner has not been told about.
   */
  const retainedBulkEntries = React.useRef(new Map<string, TriageBulkSelectedEntryV1>());
  const [retainedBulkKeys, setRetainedBulkKeys] = React.useState<readonly string[]>(EMPTY_BULK_KEYS);
  React.useEffect(() => {
    // A new scope is a different list, and the owner has already cleared the
    // set for it. Holding payloads from the previous one would let a later
    // press act on entries this scope never listed.
    retainedBulkEntries.current = new Map();
    setRetainedBulkKeys(EMPTY_BULK_KEYS);
  }, [bulkSelectionScopeKey]);
  React.useEffect(() => bulkSelection.subscribe(() => {
    const selected = bulkSelection.getSnapshot().selectedKeys;
    let grew = false;
    for (const key of selected) {
      if (retainedBulkEntries.current.has(key)) continue;
      const projected = projectTriageBulkSelectedEntriesV1({
        rows: windowRowsRef.current,
        keys: [key],
      });
      const entry = projected.entries[0];
      if (entry === undefined) continue;
      retainedBulkEntries.current.set(key, entry);
      grew = true;
    }
    // Only a GROWN set re-renders: a deselection leaves the payload held and
    // the key retained, which costs nothing and keeps a reader who unticks and
    // reticks one row from rebuilding the list twice.
    if (grew) setRetainedBulkKeys([...retainedBulkEntries.current.keys()]);
  }), [bulkSelection]);

  const bulkSessions = useTriageBulkEntrySessions();

  /**
   * The ONE answer to "which entry is this selected key", read by both the bar
   * that offers actions and the press that starts them.
   *
   * The CURRENT window answers first, so a press acts on the freshest facts
   * this mount holds; the retained payload answers only for a row the window no
   * longer lists. A key neither can answer for is reported, never dropped.
   */
  const readSelectedBulkEntries = React.useCallback((keys: readonly string[]): Readonly<{
    entries: readonly TriageBulkSelectedEntryV1[];
    unavailableKeys: readonly string[];
  }> => {
    const projected = projectTriageBulkSelectedEntriesV1({
      rows: windowRowsRef.current,
      keys,
    });
    const freshByKey = new Map(projected.entries.map((entry) => [entry.key, entry]));
    const entries: TriageBulkSelectedEntryV1[] = [];
    const unavailableKeys: string[] = [];
    for (const key of keys) {
      const entry = freshByKey.get(key) ?? retainedBulkEntries.current.get(key);
      if (entry === undefined) unavailableKeys.push(key);
      else entries.push(entry);
    }
    return { entries, unavailableKeys };
  }, []);

  /**
   * The distinct subjects the live selection declares, from the exact admitted
   * source contribution each row was projected from. The bar narrows what it
   * offers with this and the press refuses per entry with the same fact, so a
   * control that is offered is a control at least one selected entry can run.
   */
  const selectedBulkWorkflowSubjects = React.useCallback((
    keys: readonly string[],
  ): readonly TriageSourceWorkflowSubjectV1[] => {
    const subjects: TriageSourceWorkflowSubjectV1[] = [];
    for (const entry of readSelectedBulkEntries(keys).entries) {
      const subject = resolveTriageSourceWorkflowSubjectV1(
        surfaceContext.targetedContributions,
        entry.entryRef,
      );
      if (subject !== null && !subjects.includes(subject)) subjects.push(subject);
    }
    return subjects;
  }, [readSelectedBulkEntries, surfaceContext.targetedContributions]);

  const runBulkAction = React.useCallback((input: Readonly<{
    action: TriageActionV1;
    destination: TriageBulkSessionDestinationV1;
    keys: readonly string[];
  }>) => {
    const selected = readSelectedBulkEntries(input.keys);
    bulkSessions.run({
      action: input.action,
      destination: input.destination,
      entries: selected.entries.map((entry) => {
        const configured = configuredSources.sources.find(
          (candidate) => candidate.sourceInstanceId === entry.sourceInstance.sourceInstanceId,
        )?.configured;
        const operation = resolveTriageSourcePrepareReviewWorkspaceOperationV1(
          surfaceContext.targetedContributions,
          entry.entryRef.source,
        );
        return {
          ...entry,
          workflowSubject: resolveTriageSourceWorkflowSubjectV1(
            surfaceContext.targetedContributions,
            entry.entryRef,
          ),
          ...(configured === undefined
            || operation === undefined
            || entry.reviewWorkspacePreparation === undefined
            ? {}
            : {
                reviewWorkspace: {
                  operation,
                  preparation: {
                    ...entry.reviewWorkspacePreparation,
                    instance: configured,
                  },
                },
              }),
        };
      }),
      unavailableKeys: selected.unavailableKeys,
    });
  }, [bulkSessions, configuredSources.sources, readSelectedBulkEntries, surfaceContext.targetedContributions]);

  const visibleOrder = React.useMemo(
    () => [...rowsByKey.values()].map((hit) => ({
      sectionId: hit.sectionId,
      entryRef: hit.row.entryRef,
    })),
    [rowsByKey],
  );
  const dismissDetail = React.useCallback(() => {
    readerChangedLens.current = true;
    if (selectedKey !== null) setListFocusRequest({ key: selectedKey });
    dispatch({ kind: 'detailDismissed', visibleOrder });
  }, [selectedKey, visibleOrder]);

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

  /**
   * The way out of an unconfigured PRs & Issues, or nothing at all.
   *
   * The unconfigured screen named the remedy — "connect a source in Settings" —
   * and could not perform it, so a reader who had installed a source was told to
   * go and find its page themselves. Every source already ships that page; what
   * was missing was a way to NAME it, which the V1 descriptor now carries.
   *
   * Two independent facts gate the offer, and each one absent means the control
   * is simply not rendered rather than rendered dead: whether this mount can
   * navigate at all (`openSurface` is negotiated per mount, exactly as the route
   * owner reads `replacePageLocation`), and whether a given source named a page.
   */
  /**
   * `core/SURFACE.md` §2.1. The shell measures its OWN fill region and combines
   * that width with the reader's type size; it never asks the platform how big
   * a phone is. The solver has always been here — what was missing was this
   * producer, so the split composition could not be reached at any width.
   *
   * `null` until the platform has actually laid the region out. That is not a
   * neutral placeholder: an unmeasured shell renders the STACKED composition,
   * because splitting on a width nobody has reported yet is precisely the
   * desktop guess §2.1 forbids, and on a narrow window it would clip both panes
   * on the first frame.
   */
  const [measuredFillWidth, setMeasuredFillWidth] = React.useState<number | null>(null);
  const onFillRegionLayout = React.useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    // Equal measurements are dropped rather than re-set: the observer reports on
    // every commit that touches the box, and a new state value each time would
    // rebuild the composition — and every `List` section identity under it — for
    // a region that did not move.
    setMeasuredFillWidth((current) => (current === width ? current : width));
  }, []);
  const theme = usePluginTheme();
  const { textScale } = usePluginAccessibility();
  const scaledType = React.useMemo(
    () => readTriageScaledTypeMetricsV1(theme.typography, textScale),
    [textScale, theme.typography],
  );
  const layout = React.useMemo<TriageLayoutV1 | null>(
    () => (measuredFillWidth === null
      ? null
      : resolveTriageLayoutV1({
          availableWidth: measuredFillWidth,
          type: scaledType,
          spacing: theme.spacing,
        })),
    [measuredFillWidth, scaledType, theme.spacing],
  );
  const configureOffers = React.useMemo(
    () => (hostApi.version().methods.includes('openSurface')
      ? planTriageConfigureSourceOffersV1(surfaceContext.targetedContributions)
      : []),
    [hostApi, surfaceContext.targetedContributions],
  );
  /**
   * The source whose page the host refused to open, if one did.
   *
   * A press that silently does nothing is the failure `core/CORPUS.md` §4.2
   * names for **Refresh** and it is the same failure here: the destination is
   * admitted by the host, not by this page, and a Settings page whose renderer
   * cannot be staged is a real refusal a reader would otherwise read as a dead
   * button.
   */
  const [configureRefused, setConfigureRefused] = React.useState<string | null>(null);
  const openConfigureSource = React.useCallback(async (
    offer: TriageConfigureSourceOfferV1,
  ): Promise<void> => {
    setConfigureRefused(null);
    try {
      // A Settings destination carries no launch input and no sub-path; the
      // host's one resolver refuses both, so neither is supplied.
      await hostApi.openSurface(offer.destination);
    } catch {
      setConfigureRefused(offer.displayName);
    }
  }, [hostApi]);

  const removeConfiguredSource = React.useCallback(async (
    sourceInstanceId: string,
    displayLabel: string,
  ): Promise<void> => {
    const confirmed = await hostApi.confirm(text(
      'plugins.triage.surface.sources.remove.confirm',
      'Remove {name} from PRs & Issues?',
      { name: displayLabel },
    ));
    if (!confirmed) return;
    if (await configuredSources.remove(sourceInstanceId)) refresh();
  }, [configuredSources, hostApi, refresh, text]);

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
        <Stack gap="small">
          <EmptyState
            titleKey="plugins.triage.surface.noSources.title"
            title="No sources are configured"
            descriptionKey="plugins.triage.surface.noSources.description"
            description="Connect a source in Settings to see its pull requests, issues and error groups here."
            {...(configureOffers.length === 0 ? {} : {
              action: (
                /*
                 * One control per source that named a page, rather than one
                 * "Configure sources" that has to pick. With several installed
                 * there is no single right destination, and a control that
                 * opened the first would send most readers to the wrong page.
                 */
                <Row gap="small" wrap justify="center">
                  {configureOffers.map((offer) => (
                    <Button
                      key={`${offer.destination.pluginId}/${offer.destination.localId}`}
                      title={text(
                        'plugins.triage.surface.noSources.configure',
                        'Configure {name}',
                        { name: offer.displayName },
                      )}
                      variant="secondary"
                      onPress={() => openConfigureSource(offer)}
                    />
                  ))}
                </Row>
              ),
            })}
          />
          {configureRefused === null ? null : (
            <Banner
              tone="warning"
              title={text(
                'plugins.triage.surface.noSources.openFailed',
                '{name} settings could not be opened',
                { name: configureRefused },
              )}
            />
          )}
        </Stack>
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
   *
   * It decides only the third branch below — the one reached when this page has
   * never held a row for the selection at all. A selection this page DID list
   * once is answered from the row it retained, where the cause is settled: the
   * entry left a window that had it.
   */
  const neverListedHere = surface.selection !== null && surface.selection.sectionId === null;

  /**
   * The ONE detail composition, whichever region ends up holding it.
   *
   * `core/SURFACE.md` §2.1 has two compositions and one detail: stacked puts it
   * in the whole fill region, split puts the same thing in the detail pane
   * beside the list. Building it once here is what keeps that true — a second
   * copy for the split arm would be two answers to "what does an open entry look
   * like", and they would diverge the first time either changed.
   */
  const detailContent = surface.selection === null ? null : (
    selectedRow !== null ? (
      <TriageDetailRegion
        row={selectedRow}
        lanes={listWindow?.window.lanes ?? []}
        connectionLabel={selectedConnectionLabel}
        // The ONE aggregate action target (`ui/state/actionTarget.ts`), resolved
        // where the reducer state lives and passed down. The detail region holds
        // the source descriptor a control set needs but no `sectionId`, so
        // resolving it there would be a second target reader for one concept.
        target={actionTarget}
        actions={configuredActions}
        originComposer={detailOriginComposer}
        pin={{ row: projectTriageWindowRow(selectedRow, pinsByEntry), handlers: pinHandlers }}
        onClose={dismissDetail}
      />
    ) : lastKnownHeader !== null ? (
      /*
       * The selection outlived its row. The reader keeps the entry they
       * opened — its title, why it was asking for them, its state, scope and
       * observing connection — stated as the last thing this page knew, and
       * the cause underneath it. Replacing all of it with the cause alone
       * left them holding a sentence with no subject: they could not say
       * WHICH entry had gone, which is the one thing they were reading.
       */
      <Stack gap="small">
        <TriageDetailHeaderView
          header={lastKnownHeader}
          pin={lastKnownPinRow === null ? undefined : { row: lastKnownPinRow, handlers: pinHandlers }}
          onClose={dismissDetail}
          lastKnown
        />
        <EmptyState
          titleKey="plugins.triage.surface.entryGone.heading"
          title="This entry is no longer in the list"
          descriptionKey="plugins.triage.surface.entryGone.description"
          description="The current window no longer holds this entry, so there is nothing to open it with. It may return on the next refresh."
        />
      </Stack>
    ) : (
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
    )
  );

  /**
   * `core/SURFACE.md` §2.1's two compositions, decided from the measurement and
   * nothing else.
   *
   * **Split** keeps the list mounted beside the detail, so the reader stays in
   * the queue they were working through: their scroll position, their focused
   * row and the section they had reached all survive opening an entry.
   *
   * **Stacked** is the composition for every region too narrow to honour both
   * pane minima — and for a region nothing has measured yet. There the
   * selection REPLACES the list, because §2.1 forbids duplicating it underneath
   * and a starved two-pane split is worse than one readable pane.
   */
  const splitListRatio = detailContent !== null && layout !== null && layout.mode === 'split'
    ? layout.listRatio
    : null;
  /**
   * Stacked: the detail owns the visible region, and the list is INACTIVE
   * rather than gone.
   *
   * Returning a detail-only subtree here was the obvious implementation and it
   * is what §2.1's "replaces the list" reads like — but "replaced on screen"
   * and "torn out of the tree" are not the same thing, and only the first is
   * what the composition asks for. Unmounting the list discards the very state
   * the split arm's own comment says the reader keeps: the `List` instance, its
   * virtualizer window, the row their keyboard focus was on, their place in the
   * search they had typed. Closing the detail then rebuilt a fresh list at the
   * top, which on a phone — the ONLY composition that stacks — is where the
   * reader spends all of their time.
   *
   * `display: 'none'` is the whole mechanism: React keeps the subtree mounted
   * and its state alive, while the platform gives it no box, no hit target, no
   * tab stop and no place in the accessibility tree. §2.1's rule that the list
   * is not duplicated underneath the detail therefore still holds literally —
   * there is exactly one list, and while an entry is open it is not on screen.
   */
  const stackedDetailOpen = detailContent !== null && splitListRatio === null;

  return (
    <Screen safeArea style={TRIAGE_FILL_STYLE_V1}>
      <Row
        gap="small"
        align="stretch"
        testID={TRIAGE_SHELL_FILL_TEST_ID_V1}
        onLayout={onFillRegionLayout}
        style={TRIAGE_FILL_STYLE_V1}
      >
        <Stack
          gap="small"
          testID={TRIAGE_SHELL_LIST_REGION_TEST_ID_V1}
          style={stackedDetailOpen
            ? TRIAGE_INACTIVE_REGION_STYLE_V1
            : { ...TRIAGE_FILL_STYLE_V1, flex: splitListRatio ?? 1 }}
        >
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
          <Banner
            tone="info"
            {...readTriageRefreshPacingNotice(
              refreshState.reason,
              refreshState.nextEligibleAtMs,
              surfaceContext.locale,
              text,
            )}
          />
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
          busy={savedViews.busy || savedViews.revision === null}
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

        {/*
          The configured actions, edited where they are pressed.
          `triage.actions` is a hidden Settings field because the declarative
          Settings form has no repeatable record editor — so this is the editor
          the declaration points at, and it is the ONLY writer of that key on
          this page.
        */}
        {editingActions ? (
          <TriageActionsEditor
            actions={configuredActions}
            onClose={() => { setEditingActions(false); }}
          />
        ) : (
          <Row gap="small" align="center">
            <Button
              titleKey="plugins.triage.surface.actions.configure"
              title="Configure actions"
              variant="secondary"
              onPress={() => { setEditingActions(true); }}
            />
          </Row>
        )}

        {editingSources ? (
          <Stack gap="small">
            <Row gap="small" align="center" justify="space-between" wrap>
              <Heading
                value={text('plugins.triage.surface.sources.title', 'Configured sources')}
                level={3}
              />
              <Button
                titleKey="plugins.triage.surface.close"
                title="Close"
                variant="secondary"
                onPress={() => { setEditingSources(false); }}
              />
            </Row>
            {configuredSources.unavailableReason === null ? null : (
              <Banner
                tone="warning"
                title={text('plugins.triage.surface.sources.unavailableTitle', 'Account data is unavailable')}
                description={configuredSources.unavailableReason}
              />
            )}
            {configuredSources.notice === null ? null : (
              <Banner
                tone="warning"
                title={text(
                  'plugins.triage.surface.sources.changedTitle',
                  'Configured sources changed',
                )}
                description={configuredSources.notice.message}
              />
            )}
            {configuredSources.sources.length === 0 ? (
              <Status
                tone="muted"
                label={text('plugins.triage.surface.sources.none', 'No configured sources')}
              />
            ) : (
              <ItemGroup accessibilityLabel={text('plugins.triage.surface.sources.title', 'Configured sources')}>
                {configuredSources.sources.map((source) => (
                  <Item
                    key={source.sourceInstanceId}
                    title={source.displayLabel}
                    {...(source.displayPath === undefined ? {} : { subtitle: source.displayPath })}
                    accessoryWraps
                    accessoryOutsidePressable
                    accessory={(
                      <Button
                        title={text('plugins.triage.surface.sources.remove', 'Remove')}
                        variant="secondary"
                        disabled={configuredSources.unavailableReason !== null}
                        busy={configuredSources.busySourceInstanceId === source.sourceInstanceId}
                        onPress={() => {
                          void removeConfiguredSource(source.sourceInstanceId, source.displayLabel);
                        }}
                      />
                    )}
                  />
                ))}
              </ItemGroup>
            )}
          </Stack>
        ) : (
          <Row gap="small" align="center">
            <Button
              title={text('plugins.triage.surface.sources.manage', 'Manage sources')}
              variant="secondary"
              onPress={() => { setEditingSources(true); }}
            />
          </Row>
        )}

        <TriageFilterRail
          facets={facets}
          // `core/SURFACE.md` §6's compact lens, decided by the SAME
          // measurement §2.1's split composition is decided by. The rail
          // measures nothing of its own, so the page has one width authority.
          //
          // An unmeasured region keeps the WIDE arm, which is the opposite
          // default from the split above and for the opposite reason: folding
          // five controls behind a trigger takes away things the reader can
          // reach, so it waits for a measurement that actually says they do
          // not fit. The wide arm wraps in render order and cannot overflow
          // the page, so guessing wide costs height rather than reachability.
          compact={layout !== null && layout.mode === 'stacked'}
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
              style={TRIAGE_LIST_STYLE_V1}
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
                onComposingValueChange: changeComposingSearch,
                filter: RETAIN_EVERY_ROW,
              }}
              keyForItem={readTriageListSectionItemKey}
              renderItem={renderRow}
              // The shared owner of activation, roving focus, the tab stop and the
              // option semantics. Without it every row rendered as inert text and a
              // reader had no way to open anything.
              selection={{
                selectedKey,
                onSelectedKeyChange: activateRow,
                onFocusedKeyChange: focusRow,
                focusRequest: listFocusRequest,
                // The bulk set beside the detail cursor, never instead of it.
                multiple: {
                  store: bulkSelection,
                  isItemSelectable: isTriageListSectionItemSelectable,
                  // The rows this page narrowed away are HIDDEN, not gone. The
                  // shared owner cannot tell the difference on its own here,
                  // because the narrowing happened before a row ever reached it.
                  retainedSelectionKeys: retainedBulkKeys,
                },
              }}
              /*
                The bulk bar lives in the `List`'s own footer so it reads the
                same selection store the rows do — one owner for the count on
                screen and the keys a press acts on — and so gaining or losing
                it never changes the tree shape around the virtualizer.
              */
              footer={(
                <TriageBulkActionBar
                  actions={configuredActions.actions}
                  selectedWorkflowSubjects={selectedBulkWorkflowSubjects}
                  phase={bulkSessions.phase}
                  onRun={runBulkAction}
                  retryable={bulkSessions.retryable}
                  onRetry={bulkSessions.retry}
                  onCancel={bulkSessions.cancel}
                />
              )}
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
        <Stack
          gap="none"
          testID={TRIAGE_SHELL_DETAIL_REGION_TEST_ID_V1}
          style={detailContent === null
            ? TRIAGE_INACTIVE_REGION_STYLE_V1
            : { ...TRIAGE_FILL_STYLE_V1, flex: splitListRatio === null ? 1 : 1 - splitListRatio }}
        >
          {detailContent}
        </Stack>
      </Row>
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
  const queue = React.useMemo(() => createTriageRouteWriteQueueV1(hostApi), [hostApi]);
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
    queue.write({ grouping, order, smartPolicy, filters, query, selectedViewId, selection });
    return undefined;
  }, [
    filters,
    grouping,
    order,
    queue,
    query,
    readerChangedLens,
    selectedViewId,
    selection,
    smartPolicy,
  ]);
  React.useEffect(() => () => { queue.dispose(); }, [queue]);
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
