import * as React from 'react';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import type { CurrentUiCommandDeclarationV1, PluginUiContextEnrichmentV1, PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import type { TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1, TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import {
  Banner,
  Button,
  Collection,
  EmptyState,
  ErrorState,
  Heading,
  Icon,
  IconButton,
  Item,
  ItemGroup,
  Menu,
  Row,
  Screen,
  Select,
  Stack,
  Status,
  useHappierCollection,
  useHappierCollectionLayout,
  useListMultiSelectionController,
  usePluginAccessibility,
  usePluginHostApi,
  usePluginUiEphemeralSharedScope,
  usePluginSurfaceActivity,
  usePluginTheme,
  usePluginTranslation,
  useSurfaceContext,
  type CollectionDetailRenderContext,
} from '@happier-dev/plugin-ui';
import {
  HAPPIER_COLLECTION_WINDOW_COMPLETE,
  scaleTextStyleMetrics,
  type HappierCollectionGroup,
  type HappierCollectionWindow,
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
import type {
  CorpusSavedViewV1,
  CorpusSavedViewsReadV1,
  TriageSavedViewPresentationV1,
} from '../../settings/savedViews.js';
import { projectTriageCurrentUiContextV1 } from '../currentContext.js';
import { bindTriageMountedUiActions } from '../mountedActions.js';
import { useTriageSourcePanelActionsV1 } from '../useSourcePanelActions.js';
import { triageSourcePanelActionIdV1 } from '@happier-dev/triage-sources/ui';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, type TriageMountedUiOperationV1, type TriageMountedUiResultV1 } from '../../actions/mountedUiProtocol.js';
import { planTriageDetailTabsV1 } from '../detail/tabs.js';
import { projectTriageDetailHeaderV1 } from '../detail/header.js';
import { useTriagePostMutationRow } from '../detail/useTriagePostMutationRow.js';
import { readTriageDetailContextLineV1, TriageDetailHeaderActions, TriageDetailHeaderView, TriageDetailRegion } from '../detail/region.js';
import {
  resolveTriageSourcePrepareReviewWorkspaceOperationV1,
  resolveTriageSourceWorkflowSubjectV1,
  readTriageSourceDescriptorV1,
} from '../detail/sourceSurface.js';
import { TriageFilterRail } from '../filters/rail.js';
import { planTriageFilterFacetsV1 } from '../filters/plan.js';
import {
  TRIAGE_LIST_GROUPS_V1,
  planTriageListItemsV1,
  type TriageListGroupIdV1,
  type TriageListItemV1,
} from '../list/sections.js';
import { TriageBulkActionBar } from '../list/BulkActionBar.js';
import { useTriageRetainedComposerOriginV1 } from './retainedComposerOrigin.js';
import {
  projectTriageBulkSelectedEntriesV1,
  type TriageBulkSelectedEntryV1,
} from '../list/bulkSelectionEntries.js';
import { readTriageBulkSelectionScopeKeyV1 } from '../list/bulkSelectionScope.js';
import type { TriageBulkSessionDestinationV1 } from '../list/bulkSessionPlan.js';
import {
  readTriageBulkDestinationUnavailableReasonV1,
  useTriageBulkEntrySessions,
  isTriageBulkSessionsPhaseRunningV1,
  canRetryTriageBulkSessionsForSelectionV1,
} from '../list/useBulkEntrySessions.js';
import { planTriageListContinuationV1, readTriageWindowStatementV1 } from '../list/continuation.js';
import { useTriageListSessionActivityV1 } from '../list/useListSessionActivity.js';
import {
  TriageListRowEnvironmentContext,
  useTriageListAnatomyV1,
  useTriageListRowActions,
} from '../list/rows.js';
import { TRIAGE_ENTRY_DETAIL_DESTINATION_V1 } from '../../composer/openEntryDetails.js';
import {
  indexTriagePinsByEntry,
  projectTriageWindowRow,
  type TriageListDisplayRowV1,
} from '../marks/pinnedRows.js';
import { useTriagePinnedEntries } from '../marks/useTriagePinnedEntries.js';
import {
  buildTriageRouteSubPathV1,
  hasTriageRouteLensV1,
  createTriageRouteWriteQueueV1,
  parseTriageRouteSubPathV1,
  preflightTriageRouteLensV1,
  readTriageRouteLensV1,
  type TriageRouteLensV1,
  type TriageRouteQueueSettlementV1,
  type TriageRouteWriteQueueV1,
} from '../navigation/location.js';
import { TriageActionsEditor } from '../actions/ActionsEditor.js';
import { TriageFirstRun } from './firstRun.js';
import { useTriageActions } from '../actions/useTriageActions.js';
import { useTriageConfiguredSources } from '../configuration/useTriageConfiguredSources.js';
import { useTriageViewsControl } from '../views/control.js';
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
import { useTriageRefreshEligibilityNowV1 } from '../window/refreshEligibilityClock.js';
import { useTriageListWindow } from '../window/useTriageListWindow.js';
import { useTriageListWindowViewDemand } from '../window/useTriageListWindowViewDemand.js';
import {
  planTriageConfigureSourceOffersV1,
  type TriageConfigureSourceOfferV1,
} from './configureSources.js';
import { readTriageListEmptyScene, readTriageListEmptyState, readTriageListEmptyStateKeys } from './emptyState.js';
import { retainTriageLastKnownRowV1, type TriageLastKnownRowV1 } from './lastKnownRow.js';
import {
  TRIAGE_SPLIT_LIST_RATIO_PREFERENCE_V1,
  resolveTriageDetailPaneMinimumWidthV1,
  resolveTriageListPaneMinimumWidthV1,
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
const NO_LIST_ITEMS: readonly TriageListItemV1[] = Object.freeze([]);
const readTriageListItemKey = (item: TriageListItemV1): string => item.key;
const readTriageListItemGroup = (item: TriageListItemV1): string => item.group;
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
 * rather than a list. On its app page the host places this surface beside the
 * page's app details pane (`shell-extensibility.md` §3.4): the Collection opens
 * the selection there through its one `renderDetail`, the table narrows beneath
 * it, and where the pane is not beside the page (a phone, side panes off) the
 * detail is pushed in the page — `core/SURFACE.md` §2.1's **stacked** rule.
 * Only a mount the host placed in no pane host keeps the measured in-page split.
 * The mount never guesses from a platform label, so switching layouts preserves
 * the one list and one detail lifetime.
 *
 * The producer that was missing is now here: `entries/read-detail-v1` returns
 * the exact configured instance and the entry's Session links, which are the two
 * members of the strict detail input a mounted surface cannot reach on its own.
 * The third, the applied observation, is already in this mount's window.
 */


/** The lens fields a shareable location carries, as reducer seed values. */
function seedFromLocation(subPath: string | undefined): TriageSurfaceStateV1 {
  const lens = parseTriageRouteSubPathV1(subPath);
  return {
    ...TRIAGE_SURFACE_INITIAL_STATE_V1,
    order: lens.order,
    smartPolicy: lens.smartPolicy,
    filters: lens.filters,
    selectedViewId: lens.selectedViewId,
    search: { query: lens.query, composing: null },
  };
}

/** The effective canonical spelling of a host-settled page location. */
function canonicalTriageSubPathV1(subPath: string | undefined): string {
  return buildTriageRouteSubPathV1(parseTriageRouteSubPathV1(subPath));
}

type TriageSettledRouteV1 = Readonly<{
  subPath: string;
  state: TriageSurfaceStateV1;
}>;

type TriageRouteRowIndexV1 = ReadonlyMap<
  string,
  Readonly<{ sectionId: string; row: TriageListDisplayRowV1 }>
>;

type TriageSettledLensEditV1 = Readonly<{
  previous: TriageSurfaceStateV1;
  next: TriageSurfaceStateV1;
  subPath: string;
}>;

function settleQueuedTriageRouteV1(
  queue: TriageRouteWriteQueueV1,
  lens: TriageRouteLensV1,
): Promise<TriageRouteQueueSettlementV1> {
  return new Promise((resolve) => { queue.write(lens, resolve); });
}

/**
 * Apply the location the host actually settled to one optimistic candidate.
 *
 * The route carries the canonical entry ref but never the selected connection,
 * so qualification is retained only when that exact ref already belongs to
 * the candidate/base, or is supplied by the current mounted window. No other
 * connection is guessed.
 */
function applyTriageSettledSubPathV1(input: Readonly<{
  candidate: TriageSurfaceStateV1;
  previous: TriageSurfaceStateV1;
  subPath: string;
  rowsByKey: TriageRouteRowIndexV1;
}>): TriageSurfaceStateV1 {
  const lens = parseTriageRouteSubPathV1(input.subPath);
  const located = lens.selection;
  let selection: TriageSurfaceStateV1['selection'] = null;
  if (located !== null) {
    if (input.candidate.selection !== null
      && sameTriageEntryRefV1(input.candidate.selection.entryRef, located)) {
      selection = input.candidate.selection;
    } else if (input.previous.selection !== null
      && sameTriageEntryRefV1(input.previous.selection.entryRef, located)) {
      selection = input.previous.selection;
    } else {
      for (const hit of input.rowsByKey.values()) {
        if (!sameTriageEntryRefV1(hit.row.entryRef, located)
          || hit.row.sourceInstanceId === null) continue;
        selection = {
          sectionId: hit.sectionId,
          entryRef: hit.row.entryRef,
          sourceInstanceId: hit.row.sourceInstanceId,
        };
        break;
      }
    }
  }
  return {
    ...input.candidate,
    order: lens.order,
    smartPolicy: lens.smartPolicy,
    filters: lens.filters,
    selectedViewId: lens.selectedViewId,
    search: { query: lens.query, composing: null },
    selection,
  };
}

/**
 * The lens toolbar, told whether the Collection is narrow: it folds its facets behind one Filters trigger only
 * where both panes do not fit, read from the Collection's one measured layout rather than measured again here.
 */
function TriageToolbarSlot(props: Readonly<{ render: (compact: boolean) => React.ReactElement }>): React.ReactElement {
  const layout = useHappierCollectionLayout();
  return props.render(layout !== null && layout.mode === 'stacked');
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

const TRIAGE_FILL_STYLE_V1 = Object.freeze({
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden' as const,
});
const TRIAGE_LIST_STYLE_V1 = Object.freeze({ flex: 1, minHeight: 0 });
/** The lens pickers take the toolbar's free width and wrap inside it. */
const TRIAGE_TOOLBAR_LEAD_STYLE_V1 = Object.freeze({ flex: 1, minWidth: 0 });
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
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [organizing, setOrganizing] = React.useState(false);
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
  // The row-bearing facts of the state, by identity. The state wrapper is rebuilt whenever any snapshot member
  // moves (pending, freshness, pacing); the rows only when the window does, so row work keys on these.
  const listedWindow = state.kind === 'window' ? state.window : null;
  const listedStale = state.kind === 'window' && state.stale;
  const listsItems = state.kind === 'window' || state.kind === 'sourcesUnreachable' || state.kind === 'configureSources';
  const listedEntryRefs = React.useMemo(
    () => listedWindow === null ? [] : listedWindow.rows.map((row) => row.entryRef),
    [listedWindow],
  );
  const sessionActivity = useTriageListSessionActivityV1({
    entryRefs: listedEntryRefs,
    // One link read per pass that read, and only then: a paced-away demand and an unchanged window read nothing.
    acquisition: window.snapshot.passes,
    active: surfaceActivity.active,
  });
  const [surface, dispatch] = React.useReducer(
    reduceTriageSurfaceV1,
    props.subPath,
    seedFromLocation,
  );
  const settledRoute = React.useRef<TriageSettledRouteV1>({
    subPath: canonicalTriageSubPathV1(props.subPath),
    state: surface,
  });
  /** Latest accepted local intent, published synchronously before React commits it. */
  const latestRouteIntentSubPath = React.useRef(settledRoute.current.subPath);
  const routeQueue = React.useMemo(() => createTriageRouteWriteQueueV1(hostApi), [hostApi]);
  React.useEffect(() => () => { routeQueue.dispose(); }, [routeQueue]);
  const [listFocusRequest, setListFocusRequest] = React.useState<Readonly<{ key: string }> | undefined>();
  // A manual read is one pass, and the list's linked-Session join follows each pass once (`passes`); the Session
  // states themselves are watched live. Asking the join to re-read here as well scanned the links twice per press.
  const refresh = React.useCallback(() => window.refresh('manual'), [window]);
  /**
   * `core/CORPUS.md` §4.2. The coordinator may already be refusing to read, and
   * a Refresh press that silently does nothing is exactly the failure it wants
   * surfaced. It is read at render rather than memoized because the answer ages
   * on its own clock, and the deadline is the coordinator's — never re-derived
   * here from lane health.
   *
   * Ageing on its own clock is only half of it: the page also has to notice the
   * moment it printed arrive, or a reader who waits out the stated deadline is
   * left with a control this render disabled and nothing to re-enable it.
   */
  const eligibilityNowMs = useTriageRefreshEligibilityNowV1(window.snapshot.refreshBlocked);
  const refreshState = resolveTriageListRefreshV1(window.snapshot, eligibilityNowMs);

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
   * The window's honesty (COLLECTION.md §2): what the loaded rows cover, said in the Collection's footer line,
   * and each way to read more as its own control there. The lanes append another bounded window from the
   * sources while Pinned walks another page of the reader's own marks, so they are two continuations, not one
   * "load more" that reads the wrong thing.
   */
  const windowLoadMore = window.snapshot.loadMore;
  const pinsLoadMore = marks.loadMore;
  const loadMoreEntries = window.loadMore;
  const loadMorePins = marks.loadMorePins;
  const collectionWindow = React.useMemo<HappierCollectionWindow>(() => {
    const entries = planTriageListContinuationV1({ section: 'entries', state: windowLoadMore, text });
    const pins = planTriageListContinuationV1({ section: 'pins', state: pinsLoadMore, text });
    const continuations = [
      ...(entries.actionLabel === undefined ? [] : [{
        key: 'entries',
        label: entries.actionLabel,
        busy: entries.busy,
        load: () => { void loadMoreEntries(); },
      }]),
      ...(!(marks.more || pinsLoadMore?.kind === 'failed') || pins.actionLabel === undefined ? [] : [{
        key: 'pins',
        label: pinsLoadMore?.kind === 'failed'
          ? pins.actionLabel
          : text('plugins.triage.surface.loadMorePins', 'Load more pins'),
        busy: pins.busy,
        load: loadMorePins,
      }]),
    ];
    return continuations.length === 0 ? HAPPIER_COLLECTION_WINDOW_COMPLETE : { kind: 'partial', continuations };
  }, [loadMoreEntries, loadMorePins, marks.more, pinsLoadMore, text, windowLoadMore]);

  /**
   * The rows and the one grouping axis (`ui/list/sections.ts`).
   *
   * The reader's pins are planned even with no window at all (`core/SURFACE.md` §6.2, reachability state 5):
   * they are Collection state, so a machine nobody can reach does not make them disappear.
   */
  const items = React.useMemo(
    () => (listsItems
      ? planTriageListItemsV1({
          rows: listedWindow === null ? [] : listedWindow.rows,
          pins: marks.pins,
          workflowSubjectOf: (entryRef) => resolveTriageSourceWorkflowSubjectV1(
            surfaceContext.targetedContributions,
            entryRef,
          ),
          agentStatesOf: (key) => sessionActivity.agentStates.get(key) ?? [],
          // One freshness owner, stated per row. `text` is the reader's own catalog for the words this plugin
          // authors; the window's `stale` claim is the same one the page's freshness line reads.
          display: { text, stale: listedStale },
        })
      : NO_LIST_ITEMS),
    [listedStale, listedWindow, listsItems, marks.pins, sessionActivity.agentStates, surfaceContext.targetedContributions, text],
  );
  const groupAxis = React.useMemo(() => ({
    axis: [
      { key: 'pinned', title: text('plugins.triage.surface.section.pinned', 'Pinned') },
      {
        key: 'needsYou',
        title: text('plugins.triage.surface.group.needsYou.title', 'Needs you'),
        description: text('plugins.triage.surface.group.needsYou.description', 'You act next'),
      },
      {
        key: 'withAgent',
        title: text('plugins.triage.surface.group.withAgent.title', 'With an agent'),
        description: text('plugins.triage.surface.group.withAgent.description', 'A linked session is working'),
      },
      {
        key: 'inReview',
        title: text('plugins.triage.surface.group.inReview.title', 'In review'),
        description: text('plugins.triage.surface.group.inReview.description', 'Waiting on someone else'),
      },
      {
        key: 'everythingElse',
        title: text('plugins.triage.surface.group.everythingElse.title', 'Everything else'),
        description: text('plugins.triage.surface.group.everythingElse.description', 'Nobody is waiting on you'),
      },
    ] satisfies readonly (HappierCollectionGroup & Readonly<{ key: TriageListGroupIdV1 }>)[],
    groupOf: readTriageListItemGroup,
  }), [text]);

  /**
   * Every listed entry by its key and the group it is filed under (the reducer's section identity), in the
   * order the reader sees them: group by group along the axis, the window's order inside each.
   */
  const rowsByKey = React.useMemo(() => {
    const index = new Map<string, Readonly<{ sectionId: string; row: TriageListDisplayRowV1 }>>();
    for (const group of TRIAGE_LIST_GROUPS_V1) {
      for (const item of items) if (item.group === group) index.set(item.key, { sectionId: group, row: item.row });
    }
    return index;
  }, [items]);
  const rowCount = rowsByKey.size;
  const currentUiContextRows = React.useMemo(
    () => (state.kind === 'window'
      ? state.window.rows.filter((row) => rowsByKey.has(triageEntryRowKey(row.entryRef)))
      : []),
    [rowsByKey, state],
  );
  /** Whether the reader has changed the lens yet; see `useTriageRouteBinding`. */
  const readerChangedLens = React.useRef(false);
  const rowsByKeyRef = React.useRef<TriageRouteRowIndexV1>(rowsByKey);
  rowsByKeyRef.current = rowsByKey;
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
  /** A legal location the host itself refused after an optimistic edit. */
  const [routeWriteFailure, setRouteWriteFailure] = React.useState<
    'unavailable' | 'rejected' | null
  >(null);
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
    const currentRoute = preflightTriageRouteLensV1(readTriageRouteLensV1(surface));
    if (currentRoute.kind === 'accepted'
      && currentRoute.subPath === settledRoute.current.subPath) {
      // Qualification and focus are not carried in the path. Capture them when
      // this render is still the host-settled route so a later refusal restores
      // the whole visible state rather than only its serializable lens.
      settledRoute.current = { subPath: currentRoute.subPath, state: surface };
    }
    const next = reduceTriageSurfaceV1(surface, action);
    if (next === surface) return;
    const preflight = preflightTriageRouteLensV1(readTriageRouteLensV1(next));
    if (preflight.kind === 'refused') {
      setRouteRefused(refusal);
      return;
    }
    setRouteRefused(null);
    setRouteWriteFailure(null);
    latestRouteIntentSubPath.current = preflight.subPath;
    if (preflight.subPath === settledRoute.current.subPath) {
      // A copied/deep-linked location was already settled by the host; this
      // edit only supplies the selected connection the route intentionally
      // does not carry, so it is authoritative without a redundant write.
      settledRoute.current = { subPath: preflight.subPath, state: next };
    }
    readerChangedLens.current = true;
    dispatch(action);
  }, [surface]);

  /**
   * Saved-view selection is durable preference, so its complete route settles
   * before the Account KV selection write. Other lens edits remain optimistic
   * and are reconciled by the same queue in `useTriageRouteBinding`.
   */
  const settleLensEditBeforeDurable = React.useCallback(async (
    action: TriageSurfaceActionV1,
  ): Promise<TriageSettledLensEditV1 | null> => {
    const previous = surface;
    const next = reduceTriageSurfaceV1(previous, action);
    if (next === previous) {
      const existing = preflightTriageRouteLensV1(readTriageRouteLensV1(previous));
      return existing.kind === 'accepted'
        ? { previous, next, subPath: existing.subPath }
        : null;
    }
    const preflight = preflightTriageRouteLensV1(readTriageRouteLensV1(next));
    if (preflight.kind === 'refused') {
      setRouteRefused('lens');
      return null;
    }
    setRouteRefused(null);
    setRouteWriteFailure(null);
    readerChangedLens.current = true;
    latestRouteIntentSubPath.current = preflight.subPath;
    const settlement = await settleQueuedTriageRouteV1(routeQueue, readTriageRouteLensV1(next));
    const superseded = settlement.superseded
      || latestRouteIntentSubPath.current !== preflight.subPath;
    if (superseded) return null;
    const result = settlement.result;
    if (result === null) return null;
    if (result.kind === 'refused') {
      latestRouteIntentSubPath.current = settledRoute.current.subPath;
      setRouteWriteFailure(result.reason === 'unavailable' ? 'unavailable' : 'rejected');
      return null;
    }
    const settledSubPath = canonicalTriageSubPathV1(result.subPath);
    if (settledSubPath !== preflight.subPath) {
      const settledState = applyTriageSettledSubPathV1({
        candidate: next,
        previous,
        subPath: settledSubPath,
        rowsByKey: rowsByKeyRef.current,
      });
      settledRoute.current = { subPath: settledSubPath, state: settledState };
      latestRouteIntentSubPath.current = settledSubPath;
      dispatch({ kind: 'settledRouteApplied', state: settledState });
      return null;
    }
    settledRoute.current = { subPath: settledSubPath, state: next };
    latestRouteIntentSubPath.current = settledSubPath;
    dispatch(action);
    return { previous, next, subPath: settledSubPath };
  }, [routeQueue, surface]);

  const rollbackSettledLensEdit = React.useCallback(async (
    edit: TriageSettledLensEditV1,
  ): Promise<void> => {
    // A newer reader intent owns the page. Never roll it back for an older
    // durable refusal.
    if (latestRouteIntentSubPath.current !== edit.subPath) return;
    const previousLens = readTriageRouteLensV1(edit.previous);
    const previousPreflight = preflightTriageRouteLensV1(previousLens);
    if (previousPreflight.kind === 'refused') return;
    latestRouteIntentSubPath.current = previousPreflight.subPath;
    const settlement = await settleQueuedTriageRouteV1(routeQueue, previousLens);
    if (settlement.superseded) return;
    const result = settlement.result;
    if (result === null) return;
    if (result.kind === 'refused') {
      setRouteWriteFailure(result.reason === 'unavailable' ? 'unavailable' : 'rejected');
      return;
    }
    const subPath = canonicalTriageSubPathV1(result.subPath);
    const state = subPath === previousPreflight.subPath
      ? edit.previous
      : applyTriageSettledSubPathV1({
          candidate: edit.previous,
          previous: edit.next,
          subPath,
          rowsByKey: rowsByKeyRef.current,
        });
    settledRoute.current = { subPath, state };
    latestRouteIntentSubPath.current = subPath;
    dispatch({ kind: 'settledRouteApplied', state });
  }, [routeQueue]);

  /**
   * The one activation path. The shared `List` reports pointer, touch and
   * keyboard activation through the same key, and a row the window could not
   * qualify carries no instance — selecting it would open somebody else's
   * connection, so it is refused rather than approximated.
   */
  // Read at press time through the ref: a callback rebuilt with every window/session update made the row
  // environment every row reads a new value each time, re-rendering every row for nothing.
  const readRowActivation = React.useCallback((key: string) => {
    const hit = rowsByKeyRef.current.get(key);
    if (hit === undefined || hit.row.sourceInstanceId === null) return null;
    return {
      kind: 'rowActivated' as const,
      sectionId: hit.sectionId,
      entryRef: hit.row.entryRef,
      sourceInstanceId: hit.row.sourceInstanceId,
    };
  }, []);
  const activateRow = React.useCallback((key: string) => {
    const action = readRowActivation(key);
    if (action !== null) applyLensEdit(action, 'selection');
  }, [applyLensEdit, readRowActivation]);

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
   * owner. The reducer's id is used rather than the Account KV one because a
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
   * The view the lens presents through, remembered per saved view (PLAN.md r0.41): List rests as the full-width
   * table, Board as one column per group. Choosing one is a lens change like a filter: it holds for the view the
   * reader chose it on, and only an explicit save or update writes it to the saved view.
   */
  const [viewChoice, setViewChoice] = React.useState<Readonly<{
    viewId: string | null;
    view: TriageSavedViewPresentationV1;
  }> | null>(null);
  const collectionView: TriageSavedViewPresentationV1 = viewChoice !== null && viewChoice.viewId === surface.selectedViewId
    ? viewChoice.view
    : selectedStoredView?.view ?? 'list';
  const selectedViewId = surface.selectedViewId;
  const chooseCollectionView = React.useCallback((view: TriageSavedViewPresentationV1) => {
    setViewChoice({ viewId: selectedViewId, view });
  }, [selectedViewId]);

  /**
   * One applied saved-view projection becomes this page's lens.
   *
   * The lens is taken from `settings/effectiveView.ts` rather than from the
   * control's own idea of the view, so there is exactly one place a stored view
   * turns into a lens — the same one the restore path uses.
   */
  const readProjectedSelectionAction = React.useCallback((
    projection: CorpusSavedViewsReadV1,
    viewId: string,
  ): TriageSurfaceActionV1 | null => {
    const effective = resolveTriageEffectiveView({
      saved: { kind: projection.kind, value: { ...projection.value, selectedViewId: viewId } },
      configuredSources: configuredSourceIdentities,
    });
    if (effective.viewId === null) return null;
    return {
      kind: 'savedViewApplied',
      viewId: effective.viewId,
      query: effective.query,
      filters: effective.filters,
      order: effective.order,
      smartPolicy: effective.smartPolicy,
    };
  }, [configuredSourceIdentities]);

  const selectView = React.useCallback((viewId: string | null) => {
    const expectedRevision = savedViews.revision;
    if (expectedRevision === null) return;
    void (async () => {
      const action = viewId === null
        ? { kind: 'savedViewSelectionCleared' } as const
        : savedViews.saved === null
          ? null
          : readProjectedSelectionAction(savedViews.saved, viewId);
      if (action === null) return;
      const route = await settleLensEditBeforeDurable(action);
      if (route === null) return;
      const applied = await savedViews.administer(
        triageSelectSavedViewInputV1(viewId, expectedRevision),
      );
      if (applied === null) await rollbackSettledLensEdit(route);
    })();
  }, [readProjectedSelectionAction, rollbackSettledLensEdit, savedViews, settleLensEditBeforeDurable]);

  const createView = React.useCallback(async (label: string): Promise<boolean> => {
    const expectedRevision = savedViews.revision;
    if (expectedRevision === null) return false;
    const created = await savedViews.administer(triageCreateSavedViewInputV1(label, {
      query: surface.search.query,
      filters: surface.filters,
      order: surface.order,
      smartPolicy: surface.smartPolicy,
      view: collectionView,
    }, expectedRevision));
    if (created === null || created.viewId === null) return false;
    const action = readProjectedSelectionAction(created.projection, created.viewId);
    // The name is durable even if choosing the new view cannot settle.
    // Retrying Create after that point would duplicate an already saved view.
    if (action === null) return true;
    const route = await settleLensEditBeforeDurable(action);
    if (route === null) return true;
    const selected = await savedViews.administer(
      triageSelectSavedViewInputV1(created.viewId, created.revision),
    );
    if (selected === null) await rollbackSettledLensEdit(route);
    return true;
  }, [collectionView, readProjectedSelectionAction, rollbackSettledLensEdit, savedViews, settleLensEditBeforeDurable, surface.filters, surface.order, surface.search.query, surface.smartPolicy]);

  const renameView = React.useCallback(async (view: CorpusSavedViewV1, label: string): Promise<boolean> => {
    if (savedViews.revision === null) return false;
    // A rename keeps the stored lens, so nothing on screen changes.
    return await savedViews.administer(triageRenameSavedViewInputV1(view, label, savedViews.revision)) !== null;
  }, [savedViews]);

  const updateView = React.useCallback((view: CorpusSavedViewV1) => {
    if (savedViews.revision === null) return;
    // The one explicit write of the lens the reader is looking at. Nothing is
    // dispatched: the lens is already on screen, and it is the stored view that
    // moves to meet it.
    void savedViews.administer(triageUpdateSavedViewInputV1(view, {
      query: surface.search.query,
      filters: surface.filters,
      order: surface.order,
      smartPolicy: surface.smartPolicy,
      view: collectionView,
    }, savedViews.revision));
  }, [collectionView, savedViews, surface.filters, surface.order, surface.search.query, surface.smartPolicy]);

  const deleteView = React.useCallback((view: CorpusSavedViewV1) => {
    const expectedRevision = savedViews.revision;
    if (expectedRevision === null) return;
    void (async () => {
      const route = view.viewId === surface.selectedViewId
        ? await settleLensEditBeforeDurable({ kind: 'savedViewSelectionCleared' })
        : null;
      if (view.viewId === surface.selectedViewId && route === null) return;
      const deleted = await savedViews.administer(
        triageDeleteSavedViewInputV1(view.viewId, expectedRevision),
      );
      if (deleted === null && route !== null) await rollbackSettledLensEdit(route);
    })();
  }, [rollbackSettledLensEdit, savedViews, settleLensEditBeforeDurable, surface.selectedViewId]);

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
  const selectedWindowRow = React.useMemo<TriageListRowV1 | null>(() => {
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
  const { row: selectedRow, completePostMutation } = useTriagePostMutationRow(
    selectedWindowRow,
    state.kind === 'window' ? state.window.lanes : [],
  );
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
      : projectTriageWindowRow(lastKnown.row, pinsByEntry, { text })
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
    void (async () => {
      const executable = await configuredActions.resolveForExecution(
        input.action.actionId,
        selectedBulkWorkflowSubjects(input.keys),
      );
      if (executable.status !== 'resolved') return;
      const selected = readSelectedBulkEntries(input.keys);
      bulkSessions.run({
        action: executable.action,
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
    })();
  }, [
    bulkSessions,
    configuredActions,
    configuredSources.sources,
    readSelectedBulkEntries,
    selectedBulkWorkflowSubjects,
    surfaceContext.targetedContributions,
  ]);

  const readBulkDestinationUnavailableReason = React.useCallback((input: Readonly<{
    action: TriageActionV1;
    destination: TriageBulkSessionDestinationV1;
    keys: readonly string[];
  }>) => readTriageBulkDestinationUnavailableReasonV1({
    action: input.action,
    destination: input.destination,
    entries: readSelectedBulkEntries(input.keys).entries,
  }), [readSelectedBulkEntries]);

  const dismissBulkSelection = React.useCallback(() => {
    bulkSessions.reset();
    bulkSelection.exit();
  }, [bulkSelection, bulkSessions]);

  /**
   * The Collection model over the rows (COLLECTION.md §2): the one grouping axis, the window's honesty, the peek
   * set and the open item. The open item is this page's route selection — the model never pushes history; an
   * open or a close is answered through the same reducer paths a press and a dismissal take.
   */
  const openChangeRef = React.useRef<(key: string | null) => void>(() => undefined);
  const onCollectionOpenChange = React.useCallback((key: string | null) => { openChangeRef.current(key); }, []);
  const collection = useHappierCollection({
    items,
    keyOf: readTriageListItemKey,
    groups: groupAxis,
    window: collectionWindow,
    // Open is the reducer's selection, whether or not the window still lists it: an entry that left the window
    // keeps its detail (with the last known header) until the reader closes it.
    openKey: surface.selection === null ? null : triageEntryRowKey(surface.selection.entryRef),
    onOpenChange: onCollectionOpenChange,
    expandable: true,
  });
  const visibleOrder = React.useMemo(
    () => [...rowsByKey.values()].map((hit) => ({
      sectionId: hit.sectionId,
      entryRef: hit.row.entryRef,
    })),
    [rowsByKey],
  );
  const dismissDetail = React.useCallback(() => {
    if (selectedKey !== null) setListFocusRequest({ key: selectedKey });
    applyLensEdit({ kind: 'detailDismissed', visibleOrder }, 'selection');
    setDetailTab(null);
    setDetailTabs(null);
  }, [applyLensEdit, selectedKey, visibleOrder]);
  // Tabs not represented by the canonical route stay mount-local. The same
  // controlled value is consumed by source Tabs and the mounted Action.
  const [detailTab, setDetailTab] = React.useState<Readonly<{ key: string; tab: string }> | null>(null);
  const [detailTabs, setDetailTabs] = React.useState<Readonly<{ key: string; tabs: readonly string[] }> | null>(null);
  const chooseDetailTab = React.useCallback((tab: string) => {
    if (selectedKey !== null) setDetailTab({ key: selectedKey, tab });
  }, [selectedKey]);
  const reportDetailTabs = React.useCallback((tabs: readonly string[]) => {
    if (selectedKey !== null) setDetailTabs((previous) => previous?.key === selectedKey
      && previous.tabs.length === tabs.length && previous.tabs.every((tab, index) => tab === tabs[index])
      ? previous : { key: selectedKey, tabs });
    setDetailTab((previous) => previous?.key === selectedKey && !tabs.includes(previous.tab)
      ? { key: previous.key, tab: tabs[0] ?? 'overview' } : previous);
  }, [selectedKey]);
  const sharedScope = usePluginUiEphemeralSharedScope();
  const mountId = React.useId();
  const sourcePanel = useTriageSourcePanelActionsV1(sharedScope, mountId, selectedKey, surfaceActivity.active, hostApi);
  const runMountedOperation = React.useCallback(async (
    operation: TriageMountedUiOperationV1, signal: AbortSignal,
  ): Promise<TriageMountedUiResultV1> => {
    if (signal.aborted) return { status: 'unavailable' };
    switch (operation.kind) {
      case 'selectSourceOccurrence':
      case 'setSourceOrdering':
      case 'revealSourceUser': return { status: 'unavailable' }; // Dispatched to the bound source before this callback.
      case 'focusRow':
      case 'peekRow': {
        const key = triageEntryRowKey(operation.entryRef);
        if (!collection.keys.includes(key)) return { status: 'unavailable' };
        if (operation.kind === 'focusRow') collection.actions.requestFocus(key);
        else if (collection.expanded.has(key) !== (operation.expanded !== false)) collection.actions.toggleExpanded(key);
        break;
      }
      case 'switchView': chooseCollectionView(operation.view); break;
      case 'openDetail': {
        const key = triageEntryRowKey(operation.entryRef);
        const action = readRowActivation(key);
        if (action === null) return { status: 'unavailable' };
        if (operation.tab !== undefined) {
          const descriptor = readTriageSourceDescriptorV1(surfaceContext, operation.entryRef.source);
          const kind = descriptor?.kinds.find((candidate) => candidate.id === operation.entryRef.kindId);
          const composition = planTriageDetailTabsV1({ workflowSubject: kind?.workflowSubject ?? null, entryTabs: kind?.detailTabs, fixPullRequest: null });
          if (composition.kind !== 'tabs' || !composition.tabs.some((tab) => tab.id === operation.tab)) return { status: 'unavailable' };
        }
        if (await settleLensEditBeforeDurable(action) === null) return { status: 'rejected' };
        // A settled selection is an issued effect. Complete its tab intent even
        // when publishing that new selection retires the invoking command.
        setDetailTab({ key, tab: operation.tab ?? 'overview' });
        break;
      }
      case 'closeDetail':
        if (selectedKey !== null) setListFocusRequest({ key: selectedKey });
        if (await settleLensEditBeforeDurable({ kind: 'detailDismissed', visibleOrder }) === null) return { status: 'rejected' };
        setDetailTab(null);
        break;
      case 'selectDetailTab':
        if (selectedKey === null || detailTabs?.key !== selectedKey || !detailTabs.tabs.includes(operation.tab)) return { status: 'unavailable' };
        chooseDetailTab(operation.tab);
        break;
      case 'setLens':
        if (await settleLensEditBeforeDurable({ kind: 'savedViewApplied', viewId: surface.selectedViewId,
          query: operation.query, filters: operation.filters, order: operation.order, smartPolicy: surface.smartPolicy }) === null) return { status: 'rejected' };
        break;
      case 'selectSavedView': {
        // A routed view is an ephemeral lens, not the Account's saved-view
        // selection write. Use the same resolver as Views and its route owner;
        // durable edits remain the separately admitted saved-view Action.
        const action = operation.viewId === null ? { kind: 'savedViewSelectionCleared' } as const
          : savedViews.saved === null ? null : readProjectedSelectionAction(savedViews.saved, operation.viewId);
        if (action === null) return { status: 'unavailable' };
        if (await settleLensEditBeforeDurable(action) === null) return { status: 'rejected' };
        break;
      }
      case 'setSelection': {
        const keys = operation.entryRefs.map(triageEntryRowKey);
        if (keys.some((key) => !bulkSelection.getSnapshot().eligibleKeys.has(key))) return { status: 'unavailable' };
        bulkSelection.setSelectedKeys(keys);
        break;
      }
      case 'retryRun':
        if (!canRetryTriageBulkSessionsForSelectionV1(bulkSessions, bulkSelection.getSnapshot().selectedKeys)) return { status: 'unavailable' };
        bulkSessions.retry();
        break;
      case 'cancelRun':
        if (!isTriageBulkSessionsPhaseRunningV1(bulkSessions.phase)) return { status: 'unavailable' };
        bulkSessions.cancel();
        break;
      case 'refresh':
        if (refreshState.kind === 'blocked') return { status: 'unavailable' };
        await refresh();
        break;
      case 'loadMore': {
        const continuation = collectionWindow.kind === 'partial'
          ? collectionWindow.continuations.find((candidate) => candidate.key === operation.section)
          : undefined;
        if (continuation === undefined || continuation.busy) return { status: 'unavailable' };
        if (operation.section === 'entries') await loadMoreEntries();
        else await loadMorePins();
        break;
      }
    }
    return { status: 'applied' };
  }, [bulkSelection, bulkSessions, chooseCollectionView, chooseDetailTab, collection.actions, collection.expanded, collection.keys, collectionWindow, surfaceContext, detailTabs, loadMoreEntries, loadMorePins, readRowActivation, readProjectedSelectionAction, refresh, refreshState.kind, savedViews.saved, selectedKey, settleLensEditBeforeDurable, surface.selectedViewId, surface.smartPolicy, visibleOrder]);
  const mountedOperationRef = React.useRef(runMountedOperation);
  React.useLayoutEffect(() => { mountedOperationRef.current = runMountedOperation; }, [runMountedOperation]);
  React.useLayoutEffect(() => sharedScope === null || !surfaceActivity.active ? undefined : bindTriageMountedUiActions(
    sharedScope, mountId, (operation, signal) => mountedOperationRef.current(operation, signal),
  ), [mountId, sharedScope, surfaceActivity.active]);
  const mountedCommands = React.useMemo(() => {
    const command = (title: string, operation: TriageMountedUiOperationV1): CurrentUiCommandDeclarationV1 => ({
      title, command: { kind: 'executeAction', action: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, input: { mountId, operation } },
    });
    return [
      ...sourcePanel.commands.map(({ title, operation }): CurrentUiCommandDeclarationV1 => ({
        title, command: { kind: 'executeAction', action: triageSourcePanelActionIdV1(operation), input: { mountId, operation } },
      })),
      command(text('plugins.triage.currentContext.board', 'Switch to Board'), { kind: 'switchView', view: 'board' }),
      command(text('plugins.triage.currentContext.list', 'Switch to List'), { kind: 'switchView', view: 'list' }),
      ...(selectedKey === null ? [] : [command(text('plugins.triage.currentContext.closeDetail', 'Close detail'), { kind: 'closeDetail' })]),
      ...(detailTabs?.key !== selectedKey ? [] : detailTabs.tabs.map((tab) => command(
        text('plugins.triage.currentContext.selectTab', 'Select {tab} tab', { tab }), { kind: 'selectDetailTab', tab },
      ))),
      ...(refreshState.kind !== 'blocked' ? [command(text('plugins.triage.currentContext.refresh', 'Refresh PRs & Issues'), { kind: 'refresh' })] : []),
      ...(collectionWindow.kind !== 'partial' ? [] : collectionWindow.continuations.flatMap((continuation) => continuation.busy ? [] : [
        command(continuation.label, { kind: 'loadMore', section: continuation.key === 'pins' ? 'pins' : 'entries' }),
      ])),
      command(text('plugins.triage.currentContext.clearSelection', 'Clear bulk selection'), { kind: 'setSelection', entryRefs: [] }),
      ...(bulkSessions.retryable ? [command(text('plugins.triage.surface.bulk.retry', 'Try again'), { kind: 'retryRun' })] : []),
      ...(isTriageBulkSessionsPhaseRunningV1(bulkSessions.phase) ? [command(text('plugins.triage.surface.bulk.cancel', 'Stop'), { kind: 'cancelRun' })] : []),
    ];
  }, [bulkSessions.phase, bulkSessions.retryable, collectionWindow, detailTabs, mountId, refreshState.kind, selectedKey, sourcePanel.commands, text]);
  const currentUiContext = React.useMemo(() => projectTriageCurrentUiContextV1({
    surface, visibleRows: currentUiContextRows, mountedCommands,
    mountedAction: { action: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 }, mountId },
    formatOpenEntryTitle: (title) => text('plugins.triage.currentContext.openEntry', 'Open {title}', { title }),
  }), [currentUiContextRows, mountId, mountedCommands, surface, text]);
  useTriageCurrentUiContextPublication(hostApi, currentUiContext);
  openChangeRef.current = (key) => {
    if (key === null) dismissDetail();
    else activateRow(key);
  };
  /** The shared row facts the Collection's rows read: Pin/Unpin, and the one open path (the peek's Open). */
  const rowEnvironment = React.useMemo(
    () => ({ handlers: pinHandlers, onOpen: activateRow }),
    [activateRow, pinHandlers],
  );
  /** The signal column exists only while some row has a primary status fact to show in it. */
  const itemAnatomy = useTriageListAnatomyV1({ withSignal: items.some((item) => item.signal !== null), organizing });
  const routeLens = React.useMemo(() => readTriageRouteLensV1(surface), [
    surface.order, surface.smartPolicy, surface.filters, surface.search.query, surface.selectedViewId, surface.selection,
  ]);
  const anatomy = React.useMemo(() => ({ ...itemAnatomy,
    destination: (item: TriageListItemV1) => {
      const location = preflightTriageRouteLensV1({ ...routeLens, selection: item.row.entryRef });
      return location.kind === 'refused' ? null : { destination: TRIAGE_ENTRY_DETAIL_DESTINATION_V1, subPath: location.subPath };
    },
  }), [itemAnatomy, routeLens]);

  useTriageWindowLensBinding(window.setLens, readTriageWindowLensV1(surface));
  useTriageRouteBinding({
    queue: routeQueue,
    surface,
    readerChangedLens,
    settledRoute,
    latestRouteIntentSubPath,
    rowsByKeyRef,
    dispatch,
    onFailure: setRouteWriteFailure,
  });
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
    settledRoute,
    latestRouteIntentSubPath,
    onRouteWriteFailure: setRouteWriteFailure,
  });

  const theme = usePluginTheme();
  const { textScale } = usePluginAccessibility();
  const scaledType = React.useMemo(
    () => readTriageScaledTypeMetricsV1(theme.typography, textScale),
    [textScale, theme.typography],
  );
  const paneMeasure = { type: scaledType, spacing: theme.spacing };
  const minListWidth = resolveTriageListPaneMinimumWidthV1(paneMeasure);
  const minDetailWidth = resolveTriageDetailPaneMinimumWidthV1(paneMeasure);

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

  /**
   * The source-owned configuration destinations, wherever this page offers them.
   *
   * `core/SURFACE.md` §1.4 gives this surface two source-administration entry
   * points — the compact **Configure sources** action of the screen with nothing
   * usable configured, and **Manage sources** in the ordinary chrome — and routes
   * BOTH through the same generic Plugin Settings destination. They were not the
   * same offer: the first configured connection removed the only control that
   * could reach a source's own page, so a reader who wanted a second connection,
   * or who had to repair the one they had, could only get the offer back by
   * removing it. One builder, so the two places cannot drift into two answers
   * about which destinations exist or how they are opened.
   */
  const [addSourceOpen, setAddSourceOpen] = React.useState(false);
  const addSourceLabel = text('plugins.triage.surface.sources.add', 'Add a source');
  const addSourceOffers = React.useMemo(
    () => [...configureOffers].sort((left, right) => left.displayName.localeCompare(
      right.displayName,
      surfaceContext.locale,
    )),
    [configureOffers, surfaceContext.locale],
  );
  // The first run offers every source as its own tile (`./firstRun.tsx`); the ordinary chrome's
  // Manage sources keeps this compact control beside the sources already configured.
  const renderConfigureSourceOffers = (): React.ReactElement | null => {
    if (addSourceOffers.length === 0) return null;
    // One source is one action, named after it. More than one is a choice, so
    // the one action opens it: a menu of the sources, never a wall of equal
    // buttons that leaves the reader to find the one they came for.
    if (addSourceOffers.length === 1) {
      const offer = addSourceOffers[0]!;
      return (
        <Row>
          <Button
            title={text(
              'plugins.triage.surface.noSources.configure',
              'Configure {name}',
              { name: offer.displayName },
            )}
            variant="secondary"
            onPress={() => openConfigureSource(offer)}
          />
        </Row>
      );
    }
    return (
      <Row>
        <Menu
          open={addSourceOpen}
          onOpenChange={setAddSourceOpen}
          trigger={addSourceLabel}
          triggerAccessibilityLabel={addSourceLabel}
          triggerAppearance="control"
          items={addSourceOffers.map((offer) => ({
            id: `${offer.destination.pluginId}/${offer.destination.localId}`,
            label: offer.displayName,
          }))}
          onSelect={(id) => {
            const offer = addSourceOffers.find((candidate) => (
              `${candidate.destination.pluginId}/${candidate.destination.localId}` === id
            ));
            if (offer !== undefined) void openConfigureSource(offer);
          }}
        />
      </Row>
    );
  };

  const removeConfiguredSource = React.useCallback(async (
    sourceInstanceId: string,
    displayLabel: string,
  ): Promise<void> => {
    const confirmed = await hostApi.confirm(text(
      'plugins.triage.surface.sources.remove.confirm',
      'Remove {name} from PRs & Issues?',
      { name: displayLabel },
    ), { action: TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1 });
    if (!confirmed) return;
    if (await configuredSources.remove(sourceInstanceId)) refresh();
  }, [configuredSources, hostApi, refresh, text]);

  /*
    `core/SURFACE.md` §6.5. The compact Views control names the lens the reader
    is looking through; its naming draft and notices sit under the toolbar.
  */
  const views = useTriageViewsControl({
    views: storedViews,
    selectedViewId: surface.selectedViewId,
    status: readTriageSavedViewLensStatusV1({
      selected: selectedStoredView,
      lens: {
        query: surface.search.query,
        filters: surface.filters,
        order: surface.order,
        smartPolicy: surface.smartPolicy,
        view: collectionView,
      },
    }),
    // Only once a pass has answered: before one has, no source is
    // configured as far as this mount knows, and every view would be
    // reported as naming sources that are gone.
    namesUnavailableSources: (state.kind === 'window' || state.kind === 'configureSources')
      && (effectiveView?.unavailableSources.length ?? 0) > 0,
    busy: savedViews.busy || savedViews.revision === null,
    unavailableReason: savedViews.unavailableReason,
    unreadable: savedViews.saved?.kind === 'unreadable',
    notice: savedViews.notice,
    text,
    onSelectView: selectView,
    onCreateView: createView,
    onRenameView: renameView,
    onUpdateView: updateView,
    onDeleteView: deleteView,
  });

  /**
   * One notice for one cause. Pins and saved views are both Account state, so
   * an Account this mount cannot reach is said once — a calm status line, not
   * a card — naming everything it blocks, with one Retry that re-reads both.
   * Pins still on screen stay: they are the last thing the Account said.
   */
  const viewsUnreachable = savedViews.unavailableReason !== null;
  const pinsUnreachable = marks.unavailableReason !== null;
  const accountNoticeLabel = viewsUnreachable && pinsUnreachable
    ? text(
        'plugins.triage.surface.account.unreachable',
        'Happier cannot reach your account right now, so pins and saved views cannot be changed.',
      )
    : savedViews.unavailableReason ?? marks.unavailableReason;
  const accountNotice = accountNoticeLabel === null ? null : (
    <Status
      tone="warning"
      label={accountNoticeLabel}
      action={(
        <Button
          titleKey="plugins.triage.surface.actions.retry"
          title="Retry"
          variant="plain"
          onPress={() => {
            if (viewsUnreachable) savedViews.retry();
            if (pinsUnreachable) marks.retry();
          }}
        />
      )}
    />
  );

  /**
   * The one calm toolbar row above the list (`core/SURFACE.md` §6): the lens
   * pickers lead — Views, the facets (or one Filters trigger when compact),
   * Order — and the page's own controls trail: its freshness, Refresh, and an
   * overflow holding the rare administration actions. The host navigation bar
   * already titles the page, so the body carries no second title.
   *
   * It is the same toolbar before the first pass has answered, so Refresh and
   * the lens are reachable from the very first frame.
   */
  const freshness = state.kind !== 'window' ? null : state.refreshing
    ? { tone: 'neutral' as const, pulsing: true, label: text('plugins.triage.surface.refreshing', 'Refreshing') }
    : state.stale
      ? { tone: 'warning' as const, pulsing: false, label: text('plugins.triage.surface.lastKnown', 'Showing the last known list') }
      : { tone: 'muted' as const, pulsing: false, label: text('plugins.triage.surface.upToDate', 'Up to date') };
  const moreLabel = text('plugins.triage.surface.more', 'More');
  const renderListToolbar = (compact: boolean): React.ReactElement => (
    <Row gap="small" wrap align="center" justify="space-between">
      <Row gap="small" wrap align="center" style={TRIAGE_TOOLBAR_LEAD_STYLE_V1}>
        {views.control}
        <TriageFilterRail
          facets={facets}
          compact={compact}
          order={surface.order}
          smartPolicy={surface.smartPolicy}
          filtered={narrowing.facets}
          text={text}
          onToggleFilterValue={toggleFilterValue}
          onClearFilters={clearFilters}
          onChangeOrder={changeOrder}
          onChangeSmartPolicy={changeSmartPolicy}
        />
      </Row>
      <Row gap="xsmall" align="center">
        {organizing ? (
          <Button
            titleKey="plugins.triage.sessionLinks.done"
            title="Done"
            variant="plain"
            onPress={() => setOrganizing(false)}
          />
        ) : null}
        {/*
          Freshness is said, never implied by silence — but quietly while the
          list is current, so the one thing that stands out is a list that is
          not. Stale is the only warning-toned state.
        */}
        {freshness === null ? null : (
          <Status tone={freshness.tone} pulsing={freshness.pulsing} label={freshness.label} />
        )}
        <IconButton
          icon={<Icon name="refresh" />}
          accessibilityLabel={text('plugins.triage.surface.refresh', 'Refresh')}
          busy={refreshState.kind === 'running'}
          disabled={refreshState.kind === 'blocked'}
          onPress={refresh}
        />
        <Menu
          open={moreOpen}
          onOpenChange={setMoreOpen}
          trigger={moreLabel}
          triggerIcon="more"
          triggerAccessibilityLabel={moreLabel}
          items={[
            ...(!organizing ? [{ id: 'organize-list', label: text('plugins.triage.surface.organizeList', 'Organize list') }] : []),
            { id: 'configure-actions', label: text('plugins.triage.surface.actions.configure', 'Configure actions') },
            { id: 'manage-sources', label: text('plugins.triage.surface.sources.manage', 'Manage sources') },
          ]}
          onSelect={(id) => {
            if (id === 'organize-list') setOrganizing(true);
            else if (id === 'configure-actions') setEditingActions(true);
            else if (id === 'manage-sources') setEditingSources(true);
          }}
        />
        {/* List | Board ends the row, after the page's own controls (the lab's placement). */}
        <Select
          label={text('plugins.triage.surface.view.label', 'View')}
          presentation="segmented"
          value={collectionView}
          options={[
            { value: 'list', label: text('plugins.triage.surface.view.list', 'List') },
            { value: 'board', label: text('plugins.triage.surface.view.board', 'Board') },
          ]}
          onChange={(value) => {
            if (value === 'list' || value === 'board') chooseCollectionView(value);
          }}
        />
      </Row>
    </Row>
  );

  if (state.kind === 'unavailable') {
    // Nothing about the reader could be read. The page stays the page — its
    // toolbar keeps the lens and Refresh — and the failure is said in words.
    // The host's code is a diagnostic behind Details, and a retry is offered
    // only when the host says one can succeed.
    return (
      <Screen safeArea style={TRIAGE_FILL_STYLE_V1}>
        <Stack gap="medium" style={TRIAGE_FILL_STYLE_V1}>
          {renderListToolbar(false)}
          <ErrorState
            titleKey="plugins.triage.surface.listFailed"
            title="The list could not be read"
            {...(state.retryable
              ? {
                  descriptionKey: 'plugins.triage.surface.listFailed.retryable',
                  description: 'Happier could not reach your sources or your saved views just now. Try again in a moment.',
                  action: (
                    <Button
                      titleKey="plugins.triage.surface.tryAgain"
                      title="Try again"
                      variant="secondary"
                      busy={refreshState.kind === 'running'}
                      disabled={refreshState.kind === 'blocked'}
                      onPress={refresh}
                    />
                  ),
                }
              : {
                  descriptionKey: 'plugins.triage.surface.listFailed.permanent',
                  description: 'Trying again will not fix this. The details below can help support find out why.',
                })}
            {...(state.detail === undefined ? {} : { details: state.detail })}
          />
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
   * One detail, whichever container holds it: the host's app details pane
   * beside the page, the pushed detail filling the region, or (in no pane host)
   * the in-page split. Building it once here is what keeps that true — a second
   * copy for any container would be two answers to "what does an open entry look
   * like", and they would diverge the first time either changed. The Collection
   * tells it when the host already supplies the identity band and Close.
   */
  const detailContent = (headerHosted: boolean): React.ReactNode => surface.selection === null ? null : (
    selectedRow !== null ? (
      <TriageDetailRegion
        sourcePanelActions={sourcePanel.actions}
        tabSelection={{ value: detailTab?.key === selectedKey ? detailTab.tab : 'overview', onChange: chooseDetailTab, onAvailableTabsChange: reportDetailTabs }}
        headerHosted={headerHosted}
        row={selectedRow}
        completePostMutation={completePostMutation}
        lanes={listWindow?.window.lanes ?? []}
        rows={windowRows}
        connectionLabel={selectedConnectionLabel}
        // The ONE aggregate action target (`ui/state/actionTarget.ts`), resolved
        // where the reducer state lives and passed down. The detail region holds
        // the source descriptor a control set needs but no `sectionId`, so
        // resolving it there would be a second target reader for one concept.
        target={actionTarget}
        actions={configuredActions}
        originComposer={detailOriginComposer}
        pin={{
          row: projectTriageWindowRow(selectedRow, pinsByEntry, { text }),
          handlers: pinHandlers,
        }}
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
          headerHosted={headerHosted}
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
        {headerHosted ? null : <Row justify="space-between" align="center">
          <Heading
            level={2}
            value={neverListedHere
              ? text('plugins.triage.surface.entryNotInFilter.heading', 'This entry is outside the current filter')
              : text('plugins.triage.surface.entryGone.heading', 'This entry is no longer in the list')}
          />
          <IconButton
            icon={<Icon name="close" tone="secondary" />}
            accessibilityLabel={text('plugins.triage.surface.close', 'Close')}
            onPress={dismissDetail}
          />
        </Row>}

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

  /** The one detail composition, in whichever container the Collection holds it. */
  const renderDetail = (_key: string, { headerHosted }: CollectionDetailRenderContext): React.ReactNode => detailContent(headerHosted);
  const selectedHeader = selectedRow === null ? lastKnownHeader : projectTriageDetailHeaderV1({
    row: selectedRow,
    lanes: listWindow?.window.lanes ?? [],
    connectionLabel: selectedConnectionLabel,
    sourceDescriptor: readTriageSourceDescriptorV1(surfaceContext, selectedRow.entryRef.source),
    linkedSessions: [],
    linkedSessionsHasMore: false,
  });
  const detailHeader = () => {
    if (selectedHeader === null) return { title: neverListedHere
      ? text('plugins.triage.surface.entryNotInFilter.heading', 'This entry is outside the current filter')
      : text('plugins.triage.surface.entryGone.heading', 'This entry is no longer in the list') };
    const subtitle = readTriageDetailContextLineV1(selectedHeader, text);
    const pinRow = selectedRow === null ? lastKnownPinRow : projectTriageWindowRow(selectedRow, pinsByEntry, { text });
    return {
      title: selectedHeader.title,
      ...(subtitle === null ? {} : { subtitle }),
      actions: <TriageDetailHeaderActions header={selectedHeader} {...(pinRow === null ? {} : { pin: { row: pinRow, handlers: pinHandlers } })} />,
    };
  };
  /** The window-honesty line (COLLECTION.md §2): how many rows are loaded and which connections have more. */
  const windowStatement = readTriageWindowStatementV1({
    loadedCount: rowCount,
    window: listWindow?.window ?? null,
    configuredSources: window.snapshot.configuredSources,
    entries: planTriageListContinuationV1({ section: 'entries', state: windowLoadMore, text }),
    pins: marks.more || pinsLoadMore?.kind === 'failed' || pinsLoadMore?.kind === 'unresumable'
      ? planTriageListContinuationV1({ section: 'pins', state: pinsLoadMore, text })
      : null,
    text,
  });

  return (
    <Screen safeArea style={TRIAGE_FILL_STYLE_V1}>
      <Stack gap="small" style={TRIAGE_FILL_STYLE_V1}>
      {routeWriteFailure === null ? null : (
        <Banner
          tone="warning"
          title={text(
            'plugins.triage.surface.routeWriteFailed.title',
            'This page could not be updated',
          )}
          description={routeWriteFailure === 'unavailable'
            ? text(
                'plugins.triage.surface.routeWriteFailed.unavailable',
                'This screen cannot update its shareable location, so the last settled view was restored.',
              )
            : text(
                'plugins.triage.surface.routeWriteFailed.rejected',
                'Happier refused the location change, so the last settled view was restored. Try again.',
              )}
        />
      )}
      <TriageListRowEnvironmentContext.Provider value={rowEnvironment}>
        <Collection<TriageListItemV1>
          model={collection}
          anatomy={anatomy}
          accessibilityLabel={TRIAGE_DISPLAY_NAME}
          presentation={collectionView === 'board' ? 'board' : 'table'}
          detail="auto"
          renderDetail={renderDetail}
          detailHeader={detailHeader}
          minListWidth={minListWidth}
          minDetailWidth={minDetailWidth}
          preferredListRatio={TRIAGE_SPLIT_LIST_RATIO_PREFERENCE_V1}
          useRowActions={useTriageListRowActions}
          testID={TRIAGE_SHELL_FILL_TEST_ID_V1}
          listTestID={TRIAGE_SHELL_LIST_REGION_TEST_ID_V1}
          detailTestID={TRIAGE_SHELL_DETAIL_REGION_TEST_ID_V1}
          windowStatement={windowStatement}
          // The first read has not answered: the list's own region holds its geometry in skeleton rows, and the
          // toolbar above it stays reachable, so the page does not swap a stand-in tree for the list.
          loading={state.kind === 'initial'}
          header={(
            <Stack gap="small">
              {listedEntryRefs.length === 0 || !sessionActivity.incomplete ? null : (
                <Row gap="small" align="center" wrap>
                  <Status
                    tone={sessionActivity.unavailable ? 'warning' : 'muted'}
                    labelKey={sessionActivity.unavailable
                      ? 'plugins.triage.surface.sessionActivity.unavailable'
                      : 'plugins.triage.surface.sessionActivity.reading'}
                    label={sessionActivity.unavailable
                      ? 'Some linked Session activity could not be read.'
                      : 'Reading linked Session activity…'}
                  />
                  {sessionActivity.unavailable ? (
                    <Button
                      title={text('plugins.triage.surface.actions.retry', 'Retry')}
                      variant="plain"
                      onPress={sessionActivity.retry}
                    />
                  ) : null}
                </Row>
              )}
          {/*
            An unmeasured region keeps the WIDE arm of the lens: folding five
            facet controls behind one trigger takes away things the reader can
            reach, so it waits for a measurement that says they do not fit. The
            toolbar wraps in render order and cannot overflow the page.
          */}
          <TriageToolbarSlot render={renderListToolbar} />
          {views.details}
          {accountNotice}

          {state.kind !== 'configureSources' ? null : addSourceOffers.length > 0 ? (
            <TriageFirstRun offers={addSourceOffers} onConnect={(offer) => { void openConfigureSource(offer); }} />
          ) : (
            <Stack gap="small">
              <EmptyState
                titleKey="plugins.triage.surface.noSources.title"
                title="No sources are configured"
                descriptionKey="plugins.triage.surface.noSources.description"
                description="Connect a source in Settings to see its pull requests, issues and error groups here."
              />
            </Stack>
          )}

          {/*
            One refusal notice for the one destination owner, said wherever the
            press was made. It sits here rather than inside the unconfigured block
            because that block disappears the moment a connection exists, while
            **Manage sources** keeps offering the same destinations — and a press
            that silently does nothing is the failure this notice exists to end.
          */}
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

          {/*
            The wait, said before the press rather than after one that does
            nothing. It is a notice and not an error: nothing is broken, the next
            read is simply not due yet.
          */}
          {refreshState.kind !== 'blocked' ? null : (
            <Banner
              tone="secondary"
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
          {state.kind !== 'sourcesUnreachable' ? null : (
            <Banner
              tone="warning"
              title={text('plugins.triage.surface.sourcesUnreachable.title', 'Your sources could not be reached')}
              description={text('plugins.triage.surface.sourcesUnreachable.description', 'Happier could not reach a machine for these sources, so nothing has been read yet. Your pins are still here, and Refresh tries again.')}
            />
          )}

          {/*
            The configured actions, edited where they are pressed.
            `triage.actions` is an Account KV catalog because the declarative
            Settings form is not a repeatable record editor. This is the only
            writer of that catalog on this page.
          */}
          {editingActions ? (
            <TriageActionsEditor
              actions={configuredActions}
              onClose={() => { setEditingActions(false); }}
            />
          ) : null}

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
              {/*
                Adding a connection, and repairing one, are the same source-owned
                form this page never hosts (`core/SURFACE.md` §1.4). They stay
                reachable while sources exist rather than only before the first
                one, and they are the SAME destinations the unconfigured screen
                offers — one builder above, so the two cannot drift.
              */}
              {renderConfigureSourceOffers()}
            </Stack>
          ) : null}

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
            reach. The other way — a page that does not hold them all — is the
            Collection footer's own Load more pins (`core/SURFACE.md` §4.2).
            Saying it here as well would state one fact twice.
          */}

          {marks.notice === null ? null : (
            <Status tone={marks.notice.tone} label={marks.notice.message} />
          )}
            </Stack>
          )}
          selection={{
            onFocusedKeyChange: focusRow,
            ...(listFocusRequest === undefined ? {} : { focusRequest: listFocusRequest }),
            // The bulk set beside the detail cursor, never instead of it.
            multiple: {
              store: bulkSelection,
              // The rows this page narrowed away are HIDDEN, not gone. The shared owner cannot tell the
              // difference on its own here, because the narrowing happened before a row ever reached it.
              retainedSelectionKeys: retainedBulkKeys,
            },
          }}
          {...(state.kind === 'configureSources' && rowCount === 0 && surface.search.query === ''
            ? {}
            : {
                search: {
                  label: text('plugins.triage.surface.search', 'Search PRs & Issues'),
                  value: surface.search.query,
                  onValueChange: changeSearch,
                  onComposingValueChange: changeComposingSearch,
                },
              })}
          footer={(
            <TriageBulkActionBar
              actions={configuredActions.actions}
              selectedWorkflowSubjects={selectedBulkWorkflowSubjects}
              destinationUnavailableReason={readBulkDestinationUnavailableReason}
              phase={bulkSessions.phase}
              onRun={runBulkAction}
              retryable={bulkSessions.retryable}
              onRetry={bulkSessions.retry}
              onCancel={bulkSessions.cancel}
              onDismiss={dismissBulkSelection}
            />
          )}
          empty={empty === null ? null : empty.kind === 'sourceFailure' ? (
            <ErrorState
              title={empty.title}
              description={empty.description}
              /*
                The same one control, in the state that has no rows to put
                it beside. It reads the same eligibility answer as the
                header's: two Refresh controls offering different answers to
                "may this read now" is two decision-makers, and the one that
                stayed enabled was a press the coordinator silently refused
                — the exact failure `core/CORPUS.md` §4.2 names.
              */
              action={(
                <Button
                  titleKey="plugins.triage.surface.refresh"
                  title="Refresh"
                  variant="secondary"
                  busy={refreshState.kind === 'running'}
                  disabled={refreshState.kind === 'blocked'}
                  onPress={refresh}
                />
              )}
            />
          ) : (
            <EmptyState
              scene={readTriageListEmptyScene(empty.kind)}
              title={text(readTriageListEmptyStateKeys(empty.kind).title, empty.title)}
              description={text(readTriageListEmptyStateKeys(empty.kind).description, empty.description)}
            />
          )}
        />
      </TriageListRowEnvironmentContext.Provider>
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
  settledRoute: React.RefObject<TriageSettledRouteV1>;
  latestRouteIntentSubPath: React.RefObject<string>;
  onRouteWriteFailure: (failure: 'unavailable' | 'rejected' | null) => void;
}>): void {
  const {
    applyLensEdit,
    dispatch,
    launch,
    latestRouteIntentSubPath,
    readerChangedLens,
    rowsByKey,
    settledRoute,
    subPath,
    surface,
    windowSettled,
    onRouteWriteFailure,
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
    const canonicalSubPath = canonicalTriageSubPathV1(subPath);
    if (changed) {
      const previous = settledRoute.current;
      const state = applyTriageSettledSubPathV1({
        candidate: previous.state,
        previous: previous.state,
        subPath: canonicalSubPath,
        rowsByKey,
      });
      settledRoute.current = { subPath: canonicalSubPath, state };
      latestRouteIntentSubPath.current = canonicalSubPath;
      onRouteWriteFailure(null);
      // A delivered launch outranks the location it arrived over. The new
      // location is still the rollback base, but only an ordinary host move is
      // rendered immediately.
      if (pendingLaunch === null) {
        dispatch({ kind: 'settledRouteApplied', state });
        return;
      }
    }
    // The location speaks for the host only while it is one the host has just
    // handed over, or while this mount has produced no intent of its own yet.
    // In between — a selection accepted and its replacement still in flight —
    // the prop names the location the mount is LEAVING, and reading it as
    // current would pull the reader back to the entry they left.
    if (pendingLaunch === null
      && !changed
      && readerChangedLens.current
      && canonicalSubPath !== settledRoute.current.subPath) return;
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
    latestRouteIntentSubPath,
    readerChangedLens,
    rowsByKey,
    selection,
    settledRoute,
    subPath,
    windowSettled,
    onRouteWriteFailure,
  ]);
}

/**
 * Bind the durable saved-view state to this page's lens.
 *
 * It owns exactly the two rules `core/SURFACE.md` §6.5 states about a page that
 * is starting or has drifted, and neither of them writes Account KV:
 *
 * - **Restore.** On the first authoritative answer, a page whose location
 *   carried no lens of its own applies the selected view's exact query, facets,
 *   order and policy. A page that DID arrive carrying a lens keeps it: the location
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
            query: effective.query,
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
function useTriageRouteBinding(input: Readonly<{
  queue: TriageRouteWriteQueueV1;
  surface: TriageSurfaceStateV1;
  readerChangedLens: React.RefObject<boolean>;
  settledRoute: React.RefObject<TriageSettledRouteV1>;
  latestRouteIntentSubPath: React.RefObject<string>;
  rowsByKeyRef: React.RefObject<TriageRouteRowIndexV1>;
  dispatch: React.Dispatch<TriageSurfaceActionV1>;
  onFailure: (failure: 'unavailable' | 'rejected' | null) => void;
}>): void {
  const {
    dispatch,
    latestRouteIntentSubPath,
    onFailure,
    readerChangedLens,
    rowsByKeyRef,
    settledRoute,
    surface,
    queue,
  } = input;
  const lens = readTriageRouteLensV1(surface);
  const order = lens.order;
  const smartPolicy = lens.smartPolicy;
  const filters = lens.filters;
  const query = lens.query;
  const selectedViewId = lens.selectedViewId;
  const selection = lens.selection;

  React.useEffect(() => {
    if (!readerChangedLens.current) return undefined;
    const requested = { order, smartPolicy, filters, query, selectedViewId, selection };
    const requestedSubPath = buildTriageRouteSubPathV1(requested);
    if (requestedSubPath === settledRoute.current.subPath) {
      settledRoute.current = { subPath: requestedSubPath, state: surface };
      return undefined;
    }
    queue.write(requested, (settlement) => {
      const previous = settledRoute.current;
      const superseded = settlement.superseded
        || requestedSubPath !== latestRouteIntentSubPath.current;
      const result = settlement.result;
      if (result === null) return;
      if (result.kind === 'settled') {
        const subPath = canonicalTriageSubPathV1(result.subPath);
        if (subPath === requestedSubPath) {
          // The optimistic state already is the host's exact answer. Recording
          // it as settled is sufficient; dispatching a whole-state clone here
          // would restart entry-scoped reads for no visible location change.
          settledRoute.current = { subPath, state: surface };
          if (!superseded) {
            latestRouteIntentSubPath.current = subPath;
            onFailure(null);
          }
          return;
        }
        const state = applyTriageSettledSubPathV1({
          candidate: surface,
          previous: previous.state,
          subPath,
          rowsByKey: rowsByKeyRef.current,
        });
        // Even a superseded acknowledgement is now the host's actual base. It
        // is retained for a successor rejection, but only the newest intent is
        // allowed to repaint the mounted page.
        settledRoute.current = { subPath, state };
        if (superseded) return;
        latestRouteIntentSubPath.current = subPath;
        onFailure(null);
        dispatch({ kind: 'settledRouteApplied', state });
        return;
      }
      if (superseded) return;
      latestRouteIntentSubPath.current = previous.subPath;
      onFailure(result.reason === 'unavailable' ? 'unavailable' : 'rejected');
      dispatch({ kind: 'settledRouteApplied', state: previous.state });
    });
    return undefined;
  }, [
    dispatch,
    filters,
    latestRouteIntentSubPath,
    onFailure,
    order,
    queue,
    query,
    readerChangedLens,
    rowsByKeyRef,
    selectedViewId,
    selection,
    settledRoute,
    smartPolicy,
    surface,
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
