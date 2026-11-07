import * as React from 'react';
import { createTriageListPublicationV1 } from '../list/publication.js';
import { useTriageTaskGroupDisclosure } from './taskGroupDisclosure.js';
import { readPluginErrorRequestIdV1 } from '@happier-dev/plugin-sdk';
import type { TriageListWindowStoreV1 } from '../../projection/listWindowStore.js';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import type { CurrentUiCommandDeclarationV1, RenderContext } from '@happier-dev/plugin-sdk/ui';
import type { TriageSourceWorkflowSubjectV1, TriageLinkedSessionProjectionV1, TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';
import { formatTriageTimestampV1, TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, type TriageActionEditorLaunchInputV1 } from '@happier-dev/triage-protocol/v1';
import { openTriageActionEditorV1 } from '../actions/openActionEditor.js';
import {
  Banner,
  Button,
  Collection,
  CollectionToolbar,
  EmptyState,
  ErrorState,
  Heading,
  Icon,
  IconButton,
  Item,
  ItemGroup,
  LoadingState,
  Menu,
  Row,
  Screen,
  Select,
  Stack,
  Status,
  Text,
  useHappierCollection,
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
  type CollectionHeaderSlots,
  type HappierCollectionGroup,
  type HappierCollectionWindow,
} from '@happier-dev/plugin-ui';

import { TRIAGE_DISPLAY_NAME } from '../../displayName.js';
import { TriageFailureLineAction, TriageListFailureStatus } from './sourceFailure.js';
import { TriageSourceMark } from '../list/sourceMark.js';
import { PullRequestFailureDetails } from '../../sessions/pullRequestGlance/PullRequestReadFailure.js';
import { sameTriageSourceIdentity } from '../../corpus/identity/components.js';
import { selectObservationInstance, type CorpusExplicitOpenSelectionV1 } from '../../corpus/selection/selectObservationInstance.js';
import { buildTriageEntryDetailLaunchInput, type TriageEntryDetailLaunchInputV1 } from '../../composer/entryDetailLaunchInput.js';
import { parseCorpusSmartPolicy, type CorpusSmartPolicyV1 } from '../../corpus/query/smartPolicy.js';
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
import { useTriageCurrentUiContextPublication } from '../currentContextPublication.js';
import { bindTriageMountedUiActions, executeTriageMountedUiAction } from '../mountedActions.js';
import { stageTriageTaskDraft } from '../taskDraftHandoff.js';
import { useTriageSourcePanelActionsV1 } from '../useSourcePanelActions.js';
import { triageSourcePanelActionIdV1 } from '@happier-dev/triage-sources/ui';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, type TriageMountedUiOperationV1, type TriageMountedUiResultV1 } from '../../actions/mountedUiProtocol.js';
import { planTriageDetailTabsV1 } from '../detail/tabs.js';
import { TRIAGE_DETAIL_PAGE_KIND_V1 } from '../detail/body.js';
import { projectTriageDetailHeaderV1 } from '../detail/header.js';
import { useTriagePostMutationRow } from '../detail/useTriagePostMutationRow.js';
import {
  renderTriageDetailHeaderV1,
  TriageDetailRegion,
} from '../detail/region.js';
import {
  resolveTriageSourcePrepareReviewWorkspaceOperationV1,
  resolveTriageSourceWorkflowSubjectV1,
  resolveTriageSourceDescriptorV1,
  readTriageSourceDescriptorV1,
} from '../detail/sourceSurface.js';
import {
  readTriageFilterDoneLabelV1, readTriageOrderChoicesV1, readTriageOrderOptionsV1, TriageFilterRail, TriageFilterSheet,
  TriageOrderPlacement,
} from '../filters/rail.js';
import { planTriageFilterFacetsV1, readTriageRefineCountV1 } from '../filters/plan.js';
import { planTriageTaskViewInventoryV1, TRIAGE_PR_VIEW_INVENTORY_V1 } from '../list/viewInventory.js';
import {
  TRIAGE_LIST_GROUPS_V1,
  planTriageListItemsV1,
  readTriageSharedGroupReasonsV1,
  readTriageTaskBlockerNameV1,
  type TriageListGroupIdV1,
  type TriageListItemV1,
} from '../list/sections.js';
import { TriageBulkActionBar, TriageBulkActionPicker } from '../list/BulkActionBar.js';
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
import { useTriageListSessionActivitySourcesV1 } from '../list/useListSessionActivitySources.js';
import { usePersonalTaskOrder } from '../list/usePersonalTaskOrder.js';
import {
  TriageListRowEnvironmentContext,
  readTriageDataColumnsV1,
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
  createTriageRouteWriteQueueV1,
  parseTriageRouteSubPathV1,
  preflightTriageRouteLensV1,
  readTriageRouteLensV1,
  type TriageRouteLensV1,
  type TriageRouteQueueSettlementV1,
  type TriageRouteWriteQueueV1,
} from '../navigation/location.js';
import { TriageActionsEditor } from '../actions/ActionsEditor.js';
import { TriageCreateTaskFields } from '../detail/taskFields.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { readTriageAbsentRouteV1 } from './absentRoute.js';
import {
  applyTriageSettledSubPathV1,
  canonicalTriageSubPathV1,
  useTriageSettledLocation,
  type TriageRouteRowIndexV1,
  type TriageSettledRouteV1,
} from './settledLocation.js';
import { TriageFirstRun, TriageTasksFirstRun } from './firstRun.js';
import { useTriageActions } from '../actions/useTriageActions.js';
import { useTriageConfiguredSources } from '../configuration/useTriageConfiguredSources.js';
import { useTriageViewsControl } from '../views/control.js';
import { readTriageSavedViewLensStatusV1 } from '../views/divergence.js';
import {
  triageCreateSavedViewInputV1,
  triageDeleteSavedViewInputV1,
  triageRenameSavedViewInputV1,
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
import { readTriageListEmptyBelowPinsV1, readTriageListEmptyScene, readTriageListEmptyState, readTriageListEmptyStateKeys, readTriageQuietGroupClaimV1 } from './emptyState.js';
import { retainTriageLastKnownRowV1, type TriageLastKnownRowV1 } from './lastKnownRow.js';
import {
  TRIAGE_BOARD_CARD_MIN_WIDTH_V1,
  TRIAGE_SPLIT_LIST_RATIO_PREFERENCE_V1,
  resolveTriageDetailPaneMinimumWidthV1,
  resolveTriageListPaneMinimumWidthV1,
  type TriageScaledTypeMetricsV1,
} from './layout.js';
import { readTriageWindowLensV1 } from './lens.js';
import {
  readTriageListReadFailureNotice,
  readTriageRefreshPacingNotice,
  readTriageSourceFailureRowV1,
  resolveTriageListRefreshV1,
  resolveTriageListShellState,
} from './windowState.js';

const EMPTY_WINDOW_ROWS: readonly TriageListRowV1[] = Object.freeze([]);
const NO_LIST_ITEMS: readonly TriageListItemV1[] = Object.freeze([]);
const NO_EXACT_PIN_READS: ReadonlyMap<string, TriageListRowV1> = new Map();
const readTriageListItemKey = (item: TriageListItemV1): string => item.key;
const readTriageListItemGroup = (item: TriageListItemV1): string => item.group;
const readTriageListItemStatusGroup = (item: TriageListItemV1): string => item.statusGroup;
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
/** The Collection key of a new task's draft while it is open in the detail's place; never an entry's key. */
export const TRIAGE_TASK_DRAFT_KEY_V1 = 'triage:task-draft';

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
  tasksPage?: boolean;
  createDraft?: import('../../actions/tasksProtocol.js').TriageTaskDraftV1;
  createDraftId?: string;
  onCreateDraftClose?: () => void;
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
  /** An opener asked this page to open the actions editor (Edit action… anywhere), on one record or on the catalog. */
  actionEditor?: TriageActionEditorLaunchInputV1;
  /** The existing host navigation owner's one-shot explicit-open provenance. */
  pageLaunch?: RenderContext['launch'];
}>;

function indexTriageListItems(items: readonly TriageListItemV1[]): TriageRouteRowIndexV1 {
  const index = new Map<string, Readonly<{ sectionId: string; row: TriageListDisplayRowV1 }>>();
  for (const group of TRIAGE_LIST_GROUPS_V1) {
    for (const item of items) if (item.group === group) index.set(item.key, { sectionId: group, row: item.row });
  }
  return index;
}

const TriageEntryPublicationContext = React.createContext<Readonly<{
  store: TriageListWindowStoreV1 | null;
  readItem: (key: string) => TriageListItemV1 | undefined;
  projectPin: (row: TriageListRowV1) => TriageListDisplayRowV1;
}> | null>(null);

const TriageHeaderPublicationContext = React.createContext<((key: string, row: TriageListRowV1 | null) => ReturnType<typeof renderTriageDetailHeaderV1>) | null>(null);

function useTriagePublishedEntry(key: string | null): TriageListRowV1 | null {
  const store = React.useContext(TriageEntryPublicationContext)?.store;
  const subscribe = React.useCallback((listener: () => void) => key === null || store == null
    ? () => undefined : store.subscribeRow(key, listener), [key, store]);
  const read = React.useCallback(() => key === null ? null : store?.getRow(key) ?? null, [key, store]);
  return React.useSyncExternalStore(subscribe, read, read);
}

function useTriagePublishedListItem(item: TriageListItemV1): TriageListItemV1 {
  const publication = React.useContext(TriageEntryPublicationContext);
  const row = useTriagePublishedEntry(item.key);
  const current = React.useMemo(() => row === null || publication === null ? item : publication.readItem(item.key) ?? item, [item, publication, row]);
  const blockers = current.task?.relations?.blockedBy;
  // A dependent row reads only its referenced blocker names. A name update does
  // not replace the Collection's anatomy or notify unrelated rows.
  const subscribe = React.useCallback((listener: () => void) => {
    const subscriptions = blockers?.map(ref => publication?.store?.subscribeRow(triageEntryRowKey(ref), listener)) ?? [];
    return () => { for (const unsubscribe of subscriptions) unsubscribe?.(); };
  }, [blockers, publication]);
  const read = React.useCallback(() => JSON.stringify(blockers?.map(ref =>
    readTriageTaskBlockerNameV1(publication?.readItem(triageEntryRowKey(ref)))) ?? null), [blockers, publication]);
  React.useSyncExternalStore(subscribe, read, read);
  return current;
}

function useTriagePublishedDetailHeader(key: string | null): ReturnType<typeof renderTriageDetailHeaderV1> | undefined {
  const readHeader = React.useContext(TriageHeaderPublicationContext);
  const row = useTriagePublishedEntry(key);
  return key === null ? undefined : readHeader?.(key, row);
}

function TriagePublishedDetail(props: React.ComponentProps<typeof TriageDetailRegion>): React.ReactElement {
  const publication = React.useContext(TriageEntryPublicationContext);
  const canonical = useTriagePublishedEntry(triageEntryRowKey(props.row.entryRef));
  const row = canonical === null ? props.row : props.row.selected.kind === 'selected' && props.row.selected.reason === 'override'
    ? { ...canonical, selected: props.row.selected } : canonical;
  return <TriageDetailRegion {...props} row={row}
    lastKnown={canonical === null ? props.lastKnown : false}
    rows={publication?.store?.getSnapshot().window?.rows ?? props.rows}
    pin={publication === null ? props.pin : { ...props.pin, row: publication.projectPin(row) }} />;
}

export function TriageListShell(props: TriageListShellProps = {}): React.ReactElement {
  const hostApi = usePluginHostApi();
  const surfaceContext = useSurfaceContext();
  const surfaceActivity = usePluginSurfaceActivity();
  const text = usePluginTranslation();
  // One word for one action: the host's retry (its offline band says Retry), from the shared copy, not Triage's own.
  const retryLabel = text('happier.plugin-ui.state.retry', 'Retry');
  // While the host says its Run on Machine cannot answer (its offline band or Connecting line), that one voice is the
  // outage's: the list's own failure line, Refreshing and source-failure places step aside instead of repeating it.
  const hostSpeaksForOutage = surfaceContext.machineExecutionReady === false;
  const listPublication = React.useMemo(createTriageListPublicationV1, []);
  const window = useTriageListWindow(listPublication);
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
  // The editor opens only from its launch, so Configure actions, an entry's Edit action…, the standalone detail and
  // core pages all reach this one editor the same way: by opening this page with it (`openTriageActionEditorV1`).
  const [editingActions, setEditingActions] = React.useState<false | Readonly<{ actionId?: string }>>(false);
  React.useEffect(() => {
    const opened = props.actionEditor;
    if (opened !== undefined) setEditingActions(opened.actionId === undefined ? {} : { actionId: opened.actionId });
  }, [props.actionEditor]);
  const pageLocation = props.subPath;
  const editAction = React.useCallback((actionId?: string) => {
    openTriageActionEditorV1(hostApi, { ...(actionId === undefined ? {} : { actionId }), subPath: pageLocation ?? '' });
  }, [hostApi, pageLocation]);
  const [creatingTask, setCreatingTask] = React.useState(props.createDraft !== undefined);
  const [localTaskDraft, setLocalTaskDraft] = React.useState<ReturnType<typeof stageTriageTaskDraft>>(null);
  React.useEffect(() => {
    if (props.createDraft !== undefined) setCreatingTask(true);
  }, [props.createDraft]);
  // A new task is a draft in the detail's own place (lab `tasks-form`): the list stays in view beside it, and Create
  // turns it into that task's detail in place. Closing the draft also ends a handed-off draft (a message's Create task).
  const onCreateDraftClose = props.onCreateDraftClose;
  const closeTaskDraft = React.useCallback(() => {
    setCreatingTask(false);
    localTaskDraft?.discard();
    setLocalTaskDraft(null);
    onCreateDraftClose?.();
  }, [onCreateDraftClose, localTaskDraft]);
  const [editingSources, setEditingSources] = React.useState(false);
  // The one Manage sources row whose typed cause is open (its ⋯ Details), if any.
  const [openSourceDetails, setOpenSourceDetails] = React.useState<string | null>(null);
  const [organizing, setOrganizing] = React.useState(false);
  // Which configured action a bulk press applies; `null` takes the first one the selection is offered.
  const [bulkActionId, setBulkActionId] = React.useState<string | null>(null);
  const reduceSurface = React.useCallback((state: TriageSurfaceStateV1, action: TriageSurfaceActionV1) =>
    reduceTriageSurfaceV1(state, action, props.tasksPage ? 'mine' : undefined), [props.tasksPage]);
  const [surface, dispatch] = React.useReducer(
    reduceSurface,
    props.subPath,
    (subPath) => {
      const state = seedFromLocation(subPath);
      return reduceSurface(state, { kind: 'settledRouteApplied', state });
    },
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
    () => resolveTriageListShellState(window.snapshot, { durableStateReachable, tasks: surface.filters.tasks !== undefined }),
    [durableStateReachable, window.snapshot, surface.filters.tasks],
  );
  // The row-bearing facts of the state, by identity. The state wrapper is rebuilt whenever any snapshot member
  // moves (pending, freshness, pacing); the rows only when the window does, so row work keys on these.
  const listedWindow = state.kind === 'window' ? state.window : null;
  const listedStale = state.kind === 'window' && state.stale;
  const listsItems = state.kind === 'window' || state.kind === 'sourcesUnreachable' || state.kind === 'readFailed' || state.kind === 'configureSources';
  const listedEntryRefs = React.useMemo(
    () => listedWindow === null ? [] : listedWindow.rows.map((row) => row.entryRef),
    [listedWindow],
  );
  const sourceInstanceIds = useTriageListSessionActivitySourcesV1(listedWindow);
  const refresh = React.useCallback(() => window.refresh('manual'), [window]);
  const sessionActivity = useTriageListSessionActivityV1({
    entryRefs: listedEntryRefs,
    sourceInstanceIds,
    taskProjection: window.snapshot.taskProjection,
    refreshList: refresh,
    // One link read per pass that read, and only then: a paced-away demand and an unchanged window read nothing.
    acquisition: window.snapshot.passes,
    active: surfaceActivity.active,
    withSessionTitle: surface.filters.tasks === 'agents',
  });
  const taskAudience = surface.filters.tasks;
  const personalTaskOrder = usePersonalTaskOrder(taskAudience !== undefined, window.snapshot.taskProjection, refresh);
  const { doneOpen, collapsedGroups, chooseDoneExpanded } = useTriageTaskGroupDisclosure(taskAudience !== undefined);
  const windowLens = readTriageWindowLensV1(surface);
  useTriageWindowLensBinding(window.setLens, windowLens);
  const completedSinceMs = windowLens.tasks?.completedSinceMs;
  // Agents membership needs relationship truth even when no live Session has answered.
  const sessionActivityUnavailable = sessionActivity.unavailable
    || (taskAudience === 'agents' && sessionActivity.linksStatus === 'unavailable');
  const pageTitle = taskAudience === undefined ? TRIAGE_DISPLAY_NAME : text('plugins.triage.tasks.title', 'Tasks');
  const settledRoute = React.useRef<TriageSettledRouteV1>({
    subPath: canonicalTriageSubPathV1(props.subPath),
    state: surface,
  });
  /** Latest accepted local intent, published synchronously before React commits it. */
  // Retain the qualified candidate while the host publishes its identity-only
  // location, which can arrive before the replacement acknowledgement.
  const latestRouteIntent = React.useRef(settledRoute.current);
  const routeQueue = React.useMemo(() => createTriageRouteWriteQueueV1(hostApi), [hostApi]);
  React.useEffect(() => {
    // Publish the opening view through the same writer, retaining any entry
    // the route names before the window can qualify the reducer's selection.
    routeQueue.write({
      ...parseTriageRouteSubPathV1(settledRoute.current.subPath),
      filters: settledRoute.current.state.filters,
    });
    return () => { routeQueue.dispose(); };
  }, [routeQueue]);
  const [listFocusRequest, setListFocusRequest] = React.useState<Readonly<{ key: string }> | undefined>();
  // A manual read is one pass, and the list's linked-Session join follows each pass once (`passes`); the Session
  // states themselves are watched live. Asking the join to re-read here as well scanned the links twice per press.
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
  // The toolbar's resting line states the read's age (lab "Updated just now") from the freshness owner's one
  // completion time. It is shown, and so wakes the clock each minute, only while no other line speaks: not while
  // refreshing, and not while "Showing the last known list" (or the body's own failure) says the window is behind.
  const readAgeAtMs = state.kind === 'window' && !state.refreshing && !(state.showReadWarning && state.failure == null)
    ? window.snapshot.completedAtMs
    : undefined;
  const eligibilityNowMs = useTriageRefreshEligibilityNowV1(window.snapshot.refreshBlocked, readAgeAtMs);
  const refreshState = resolveTriageListRefreshV1(window.snapshot, eligibilityNowMs);

  // The named page-view producers (`core/CORPUS.md` §4.1): mount, then every
  // host-owned active regain. The window hook itself only reads, so the
  // Composer picker — which is not a producer — reaches nothing merely by
  // opening (`REQ-14`). The adapter emits view and readmission demand; the mounted store
  // remains the one owner of coalescing, pacing and provider work.
  useTriageListWindowViewDemand(surfaceActivity.active, window.refresh, window.readiness, window.readOwner);
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
  // Pinned entries this mount has read exactly (their detail was opened): the pin then shows what the source said.
  const [exactPinReads, setExactPinReads] = React.useState<ReadonlyMap<string, TriageListRowV1>>(NO_EXACT_PIN_READS);
  const staleCompletedAtMs = listedStale ? window.snapshot.completedAtMs : undefined;
  const viewInventory = React.useMemo(() => taskAudience === undefined ? TRIAGE_PR_VIEW_INVENTORY_V1
    : planTriageTaskViewInventoryV1(source => resolveTriageSourceDescriptorV1(surfaceContext.targetedContributions, source)?.kinds),
  [surfaceContext.targetedContributions, taskAudience]);
  const pinsByEntry = React.useMemo(() => indexTriagePinsByEntry(marks.pins), [marks.pins]);
  const planItems = React.useCallback((rows: readonly TriageListRowV1[], previous: readonly TriageListItemV1[] = NO_LIST_ITEMS, incremental = false) =>
    planTriageListItemsV1({
          rows,
          pins: incremental ? rows.flatMap(row => {
            const pin = pinsByEntry.get(triageEntryRowKey(row.entryRef));
            return pin === undefined ? [] : [pin];
          }) : marks.pins,
          readRows: incremental ? [] : [...exactPinReads.values()],
          locale: surfaceContext.locale,
          workflowSubjectOf: (entryRef) => resolveTriageSourceWorkflowSubjectV1(
            surfaceContext.targetedContributions,
            entryRef,
          ),
          agentStatesOf: (key) => sessionActivity.agentStates.get(key) ?? [],
          // One freshness owner, stated per row. `text` is the reader's own catalog for the words this plugin
          // authors; the window's `stale` claim is the same one the page's freshness line reads.
          display: { text, stale: listedStale, ...(staleCompletedAtMs === undefined ? {} : { completedAtMs: staleCompletedAtMs }) },
          ...(taskAudience === undefined ? {} : { tasks: {
            audience: taskAudience,
            completedSinceMs,
            ...(incremental || personalTaskOrder.value === null ? {} : { personalOrder: personalTaskOrder.value.undoneOrder,
              personalAccountId: personalTaskOrder.value.scope.accountId }),
            isTask: viewInventory.includesKind,
            capabilitiesOf: (entryRef) => resolveTriageSourceDescriptorV1(surfaceContext.targetedContributions, entryRef.source)
              ?.kinds.find((kind) => kind.id === entryRef.kindId)?.taskCapabilities,
            hasSessions: (key) => (sessionActivity.linkedSessions.get(key)?.length ?? 0) > 0,
          } }),
    }, previous),
    [completedSinceMs, exactPinReads, listedStale, staleCompletedAtMs, marks.pins, pinsByEntry, personalTaskOrder.value, sessionActivity.agentStates, sessionActivity.linkedSessions, surfaceContext.locale, surfaceContext.targetedContributions, taskAudience, text, viewInventory]
  );
  listPublication.setPlanner(planItems);
  const items = listsItems ? listPublication.getItems() : NO_LIST_ITEMS;
  /**
   * A suggestion every entry of a group shares ("Mentioned" on each of 52) is said once, beside the group's own
   * line, instead of as the same chip on every row; a group whose reasons differ keeps them on the rows.
   */
  const sharedGroupReasons = React.useMemo(() => readTriageSharedGroupReasonsV1(items), [items]);
  const groupDescription = React.useCallback((group: TriageListGroupIdV1, description: string) => {
    const shared = sharedGroupReasons.get(group);
    return shared === undefined ? description : `${shared} · ${description}`;
  }, [sharedGroupReasons]);
  const groupAxis = React.useMemo(() => ({
    axis: taskAudience !== undefined ? [
      { key: 'pinned', title: text('plugins.triage.surface.section.pinned', 'Pinned') },
      { key: 'started', title: text('plugins.triage.tasks.started', 'In progress') },
      { key: 'unstarted', title: text('plugins.triage.tasks.unstarted', 'To do') },
      { key: 'backlog', title: text('plugins.triage.tasks.backlog', 'Backlog') },
      { key: 'completed', title: text('plugins.triage.tasks.completed', 'Done'),
        description: text('plugins.triage.tasks.thisWeek', 'This week') },
      { key: 'canceled', title: text('plugins.triage.tasks.canceled', 'Canceled') },
      { key: 'everythingElse', title: text('plugins.triage.tasks.unclassified', 'Other states') },
    ] : [
      { key: 'pinned', title: text('plugins.triage.surface.section.pinned', 'Pinned') },
      {
        key: 'needsYou',
        title: text('plugins.triage.surface.group.needsYou.title', 'Needs you'),
        description: groupDescription('needsYou', text('plugins.triage.surface.group.needsYou.description', 'You act next')),
      },
      {
        key: 'withAgent',
        title: text('plugins.triage.surface.group.withAgent.title', 'With an agent'),
        description: groupDescription('withAgent', text('plugins.triage.surface.group.withAgent.description', 'A linked session is working')),
      },
      {
        key: 'inReview',
        title: text('plugins.triage.surface.group.inReview.title', 'In review'),
        description: groupDescription('inReview', text('plugins.triage.surface.group.inReview.description', 'Waiting on someone else')),
      },
      {
        key: 'everythingElse',
        title: text('plugins.triage.surface.group.everythingElse.title', 'Everything else'),
        description: groupDescription('everythingElse', text('plugins.triage.surface.group.everythingElse.description', 'Nobody is waiting on you')),
      },
    ] satisfies readonly (HappierCollectionGroup & Readonly<{ key: TriageListGroupIdV1 }>)[],
    groupOf: readTriageListItemGroup,
  }), [groupDescription, taskAudience, text]);

  /**
   * Every listed entry by its key and the group it is filed under (the reducer's section identity), in the
   * order the reader sees them: group by group along the axis, the window's order inside each.
   */
  const rowsByKey = React.useMemo(() => indexTriageListItems(items), [items]);
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
    const next = reduceSurface(surface, action);
    if (next === surface) return;
    const preflight = preflightTriageRouteLensV1(readTriageRouteLensV1(next));
    if (preflight.kind === 'refused') {
      setRouteRefused(refusal);
      return;
    }
    setRouteRefused(null);
    setRouteWriteFailure(null);
    latestRouteIntent.current = { subPath: preflight.subPath, state: next };
    if (preflight.subPath === settledRoute.current.subPath) {
      // A copied/deep-linked location was already settled by the host; this
      // edit only supplies the selected connection the route intentionally
      // does not carry, so it is authoritative without a redundant write.
      settledRoute.current = { subPath: preflight.subPath, state: next };
    }
    readerChangedLens.current = true;
    dispatch(action);
  }, [reduceSurface, surface]);

  /**
   * Saved-view selection is durable preference, so its complete route settles
   * before the Account KV selection write. Other lens edits remain optimistic
   * and are reconciled by the same queue in `useTriageRouteBinding`.
   */
  const settleLensEditBeforeDurable = React.useCallback(async (
    action: TriageSurfaceActionV1,
  ): Promise<TriageSettledLensEditV1 | null> => {
    const previous = surface;
    const next = reduceSurface(previous, action);
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
    latestRouteIntent.current = { subPath: preflight.subPath, state: next };
    const settlement = await settleQueuedTriageRouteV1(routeQueue, readTriageRouteLensV1(next));
    const superseded = settlement.superseded
      || latestRouteIntent.current.subPath !== preflight.subPath;
    if (superseded) return null;
    const result = settlement.result;
    if (result === null) return null;
    if (result.kind === 'refused') {
      latestRouteIntent.current = settledRoute.current;
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
      latestRouteIntent.current = settledRoute.current;
      dispatch({ kind: 'settledRouteApplied', state: settledState });
      return null;
    }
    settledRoute.current = { subPath: settledSubPath, state: next };
    latestRouteIntent.current = settledRoute.current;
    dispatch(action);
    return { previous, next, subPath: settledSubPath };
  }, [reduceSurface, routeQueue, surface]);

  const rollbackSettledLensEdit = React.useCallback(async (
    edit: TriageSettledLensEditV1,
  ): Promise<void> => {
    // A newer reader intent owns the page. Never roll it back for an older
    // durable refusal.
    if (latestRouteIntent.current.subPath !== edit.subPath) return;
    const previousLens = readTriageRouteLensV1(edit.previous);
    const previousPreflight = preflightTriageRouteLensV1(previousLens);
    if (previousPreflight.kind === 'refused') return;
    latestRouteIntent.current = { subPath: previousPreflight.subPath, state: edit.previous };
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
    latestRouteIntent.current = settledRoute.current;
    dispatch({ kind: 'settledRouteApplied', state });
  }, [routeQueue]);

  /**
   * The one activation path. The shared `List` reports pointer, touch and
   * keyboard activation through the same key, and a row the window could not
   * qualify carries no instance. An explicit off-window open admits a current active
   * connection through the same Corpus selector; rendering pins performs no read.
   */
  const [entryOpenFailure, setEntryOpenFailure] = React.useState<Extract<CorpusExplicitOpenSelectionV1, { kind: 'none' }> | null>(null);
  const openAdmission = React.useRef({ configuredSources: window.snapshot.configuredSources, selection: surface.selection });
  openAdmission.current = { configuredSources: window.snapshot.configuredSources, selection: surface.selection };
  // Read at press time through the ref: a callback rebuilt with every window/session update made the row
  // environment every row reads a new value each time, re-rendering every row for nothing.
  const readEntryActivation = React.useCallback((entryRef: TriageEntryRefV1) => {
    const hit = rowsByKeyRef.current.get(triageEntryRowKey(entryRef));
    let sourceInstanceId = hit?.row.sourceInstanceId ?? null;
    if (hit === undefined || (sourceInstanceId === null && hit.row.pinned)) {
      const current = openAdmission.current;
      // The list owner already published source admission. A delayed local descriptor
      // catalog cannot withdraw that connection; the source owns entry-kind validation.
      const active = current.configuredSources.filter(source => source.available
        && sameTriageSourceIdentity(source.source, entryRef.source)).map(source => source.sourceInstanceId);
      const selected = selectObservationInstance([], active, null, {
        allowUnobserved: true,
        ...(current.selection !== null && sameTriageEntryRefV1(current.selection.entryRef, entryRef)
          ? { overrideSourceInstanceId: current.selection.sourceInstanceId } : {}),
      });
      if (selected.kind === 'none') { setEntryOpenFailure(selected); return selected; }
      sourceInstanceId = selected.sourceInstanceId;
    }
    if (sourceInstanceId === null) return null;
    setEntryOpenFailure(null);
    return {
      kind: 'rowActivated' as const,
      sectionId: hit?.sectionId ?? null,
      entryRef,
      sourceInstanceId,
    };
  }, []);
  const readRowActivation = React.useCallback((key: string) => {
    const hit = rowsByKeyRef.current.get(key);
    const action = hit === undefined ? null : readEntryActivation(hit.row.entryRef);
    return action?.kind === 'rowActivated' ? action : null;
  }, [readEntryActivation]);
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
    const hit = rowsByKeyRef.current.get(key);
    if (hit === undefined) return;
    setListFocusRequest(undefined);
    dispatch({ kind: 'rowFocused', sectionId: hit.sectionId, entryRef: hit.row.entryRef });
  }, []);

  const toggleFilterValue = React.useCallback((selection: TriageFilterFacetValueV1) => {
    applyLensEdit({ kind: 'filterValueToggled', ...selection }, 'lens');
  }, [applyLensEdit]);
  const clearFilters = React.useCallback(() => {
    applyLensEdit({ kind: 'filtersCleared' }, 'lens');
  }, [applyLensEdit]);
  const clearFilterFacet = React.useCallback((facet: TriageFilterFacetValueV1['facet']) => {
    applyLensEdit({ kind: 'filterFacetCleared', facet }, 'lens');
  }, [applyLensEdit]);
  const changeOrder = React.useCallback((order: TriageSurfaceStateV1['order']) => {
    applyLensEdit({ kind: 'orderChanged', order }, 'lens');
  }, [applyLensEdit]);
  const orderOptions = React.useMemo(() => readTriageOrderOptionsV1(text), [text]);
  const changeCollectionOrder = React.useCallback((key: string) => {
    const order = orderOptions.find((option) => option.key === key);
    if (order !== undefined) changeOrder(order.key);
  }, [changeOrder, orderOptions]);
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
   * owner. The reducer's id comes from the device's page location; Account KV
   * holds saved definitions only.
   */
  const effectiveView = React.useMemo(() => {
    const saved = savedViews.saved;
    if (saved === null || saved.kind === 'unreadable') return null;
    return resolveTriageEffectiveView({
      saved,
      selectedViewId: surface.selectedViewId,
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
      saved: projection,
      selectedViewId: viewId,
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

  const selectView = React.useCallback(async (viewId: string | null, signal: AbortSignal): Promise<TriageMountedUiResultV1> => {
    // A published Action may name a view created or changed by another mount.
    // Resolve this explicit selection through the same Account catalog reader.
    const projection = viewId === null ? null : await savedViews.refresh(signal);
    const action = viewId === null
      ? { kind: 'savedViewSelectionCleared' } as const
      : projection === null
        ? null
        : readProjectedSelectionAction(projection, viewId);
    if (action === null) return { status: 'unavailable' };
    return { status: await settleLensEditBeforeDurable(action) === null ? 'rejected' : 'applied' };
  }, [readProjectedSelectionAction, savedViews.refresh, settleLensEditBeforeDurable]);

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
    // The name is durable even if choosing the new view cannot settle.
    // Retrying Create after that point would duplicate an already saved view.
    const action = readProjectedSelectionAction(created.projection, created.viewId);
    if (action === null) return true;
    await settleLensEditBeforeDurable(action);
    return true;
  }, [collectionView, readProjectedSelectionAction, savedViews, settleLensEditBeforeDurable, surface.filters, surface.order, surface.search.query, surface.smartPolicy]);

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
      inventory: viewInventory,
      configuredSources: window.snapshot.configuredSources,
      ...(window.snapshot.window === undefined
        ? {}
        : { facetCensus: window.snapshot.window.facetCensus }),
      filters: surface.filters,
      readSourceName: (source) => readTriageSourceDescriptorV1(surfaceContext, source)?.displayName,
      readKindName: (source, kindId) => readTriageSourceDescriptorV1(surfaceContext, source)
        ?.kinds.find((kind) => kind.id === kindId)?.displayName,
    }, text),
    [surface.filters, surfaceContext, text, window.snapshot.configuredSources, window.snapshot.window, viewInventory],
  );

  /**
   * The narrowings in force, said as tokens on the quiet line under the toolbar: one place names what the list is
   * narrowed to, in either toolbar arm, and each token removes exactly its own facet value.
   */
  const searchTokens = React.useMemo(() => facets.flatMap((facet) => facet.options
    .filter((option) => option.selected)
    .map((option) => ({
      key: option.key,
      qualifier: facet.label,
      label: option.label,
      onRemove: () => { toggleFilterValue(option.selection); },
    }))), [facets, toggleFilterValue]);

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

  const selectedKey = surface.selection === null ? null : triageEntryRowKey(surface.selection.entryRef);

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
  // Explicit opens and restored locations share configured-source admission
  // and the same exact read when their entry is outside the list window.
  const unobservedSelection = selectedWindowRow === null && surface.selection !== null
    && (surface.selection.sectionId === null || surface.selection.sectionId === 'pinned'
      || pinsByEntry.has(triageEntryRowKey(surface.selection.entryRef)))
    ? surface.selection : null;
  const { row: selectedRow, completePostMutation, readFailed, failure: selectedReadFailure, exactRead } = useTriagePostMutationRow(
    selectedWindowRow,
    state.kind === 'window' ? state.window.lanes : [],
    unobservedSelection,
    window.readOwner,
  );
  // The page's one refresh (lab: "Updated · ⟳"): a press re-reads the list and, once, the open entry through its
  // existing exact read; the generation tells the mounted detail's Activity to re-read its source as well.
  const [detailRefreshGeneration, setDetailRefreshGeneration] = React.useState(0);
  const refreshPage = React.useCallback(() => {
    refresh();
    if (surface.selection === null) return;
    setDetailRefreshGeneration((generation) => generation + 1);
    void completePostMutation().catch(() => undefined);
  }, [completePostMutation, refresh, surface.selection]);
  React.useEffect(() => {
    // Only an off-window pin needs this: a window row already answers its own pin.
    if (selectedRow === null || selectedWindowRow !== null) return;
    const key = triageEntryRowKey(selectedRow.entryRef);
    if (!pinsByEntry.has(key)) return;
    setExactPinReads((current) => current.get(key) === selectedRow ? current : new Map(current).set(key, selectedRow));
  }, [pinsByEntry, selectedRow, selectedWindowRow]);
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
   * It follows canonical publication and is adjusted during render because the render
   * that loses the row is the one that has to draw the header: settling it a
   * commit later would blank the entry for a frame and then bring it back,
   * which reads as the surface losing the entry and finding it again.
   */
  const heldRow = React.useRef<TriageLastKnownRowV1 | null>(null);
  /** The originating draft this detail may disclose evidence into, held by its own owner. */
  const detailOriginComposer = useTriageRetainedComposerOriginV1({
    launch: props.launch,
    selectedEntryRef: surface.selection?.entryRef ?? null,
  });

  const lastKnown = retainTriageLastKnownRowV1(heldRow.current, surface.selection, selectedRow);
  heldRow.current = lastKnown;
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
      rows: window.readOwner === null ? windowRowsRef.current
        : keys.flatMap(key => { const row = window.readOwner!.getRow(key); return row === null ? [] : [row]; }),
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
  }, [window.readOwner]);

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
    entries: readSelectedBulkEntries(input.keys).entries.map((entry) => ({
      ...entry,
      workflowSubject: resolveTriageSourceWorkflowSubjectV1(surfaceContext.targetedContributions, entry.entryRef),
    })),
  }), [readSelectedBulkEntries, surfaceContext.targetedContributions]);

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
  // A board is read by position, so it keeps every status lane, an empty one included ("Needs you 0" is the good
  // news). Pinned is the reader's own mark, not a status: on the board a pinned entry stays in its status column
  // and its card carries the pin (owner ruling 2026-10-31); the list keeps Pinned as its first group.
  // In a list, an empty Needs you stays as its band and one quiet line while that is the true answer (lab
  // `merged-quiet`): every source answered and nothing the reader chose narrows it.
  const quietNeedsYou = taskAudience === undefined && collectionView !== 'board' && readTriageQuietGroupClaimV1(state, narrowing);
  const quietNeedsYouStatement = text('plugins.triage.surface.group.needsYou.quiet', 'Nothing needs you right now.');
  const collectionGroups = React.useMemo(() => collectionView !== 'board' ? (!quietNeedsYou ? groupAxis : {
    ...groupAxis,
    axis: groupAxis.axis.map((group) => group.key !== 'needsYou' ? group : { ...group, emptyStatement: quietNeedsYouStatement }),
  }) : {
    ...groupAxis,
    axis: groupAxis.axis.filter((group) => group.key !== 'pinned'),
    groupOf: readTriageListItemStatusGroup,
    retainEmpty: true,
  }, [collectionView, groupAxis, quietNeedsYou, quietNeedsYouStatement]);
  const collection = useHappierCollection({
    items,
    keyOf: readTriageListItemKey,
    groups: collectionGroups,
    window: collectionWindow,
    // Open is the reducer's selection, whether or not the window still lists it: an entry that left the window
    // keeps its detail (with the last known header) until the reader closes it.
    openKey: creatingTask ? TRIAGE_TASK_DRAFT_KEY_V1
      : surface.selection === null ? null : triageEntryRowKey(surface.selection.entryRef),
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
  }, [applyLensEdit, selectedKey, visibleOrder]);
  // Tabs not represented by the canonical route stay mount-local. The same
  // controlled value is consumed by source Tabs and the mounted Action.
  const [detailTab, setDetailTab] = React.useState<Readonly<{ key: string; tab: string; sessionId?: string }> | null>(null);
  const pageNavigation = surfaceContext.page?.navigation;
  const detailTabs = pageNavigation?.pageKind.pluginId === TRIAGE_DETAIL_PAGE_KIND_V1.pluginId
    && pageNavigation.pageKind.localId === TRIAGE_DETAIL_PAGE_KIND_V1.localId ? pageNavigation.items : undefined;
  const [detailSessions, setDetailSessions] = React.useState<Readonly<{ key: string; sessions: readonly TriageLinkedSessionProjectionV1[]; loadMore: (() => void) | null }> | null>(null);
  const [detailFixRetry, setDetailFixRetry] = React.useState<Readonly<{ key: string; retry: () => void }> | null>(null);
  const reportDetailFixRetry = React.useCallback((retry: (() => void) | null) => {
    setDetailFixRetry(retry === null || selectedKey === null ? null : { key: selectedKey, retry });
  }, [selectedKey]);
  const chooseDetailTab = React.useCallback((tab: string) => {
    if (selectedKey !== null) setDetailTab((previous) => ({ ...(previous?.key === selectedKey ? previous : {}), key: selectedKey, tab }));
  }, [selectedKey]);
  const reportDetailSessions = React.useCallback((sessions: readonly TriageLinkedSessionProjectionV1[], loadMore: (() => void) | null) => {
    if (selectedKey !== null) setDetailSessions((previous) => previous?.key === selectedKey
      && previous.loadMore === loadMore
      && previous.sessions.length === sessions.length && previous.sessions.every((session, index) =>
        session.sessionId === sessions[index]?.sessionId && session.displayTitle === sessions[index]?.displayTitle)
      ? previous : { key: selectedKey, sessions, loadMore });
  }, [selectedKey]);
  const sharedScope = usePluginUiEphemeralSharedScope();
  const mountId = React.useId();
  const viewsUnreachable = savedViews.unavailableReason !== null;
  const pinsUnreachable = marks.unavailableReason !== null;
  const sourcePanel = useTriageSourcePanelActionsV1(sharedScope, mountId, selectedKey, surfaceActivity.active, hostApi);
  const runMountedOperation = React.useCallback(async (
    operation: TriageMountedUiOperationV1, signal: AbortSignal,
  ): Promise<TriageMountedUiResultV1> => {
    if (signal.aborted) return { status: 'unavailable' };
    switch (operation.kind) {
      case 'selectSourceOccurrence':
      case 'loadMoreSourceItems':
      case 'setSourceItemExpanded':
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
      case 'switchView':
        if (taskAudience !== undefined && operation.view === 'board') return { status: 'unavailable' };
        chooseCollectionView(operation.view); break;
      case 'setGroupExpanded': return chooseDoneExpanded(operation.expanded);
      case 'openDetail': {
        const key = triageEntryRowKey(operation.entryRef);
        const action = readEntryActivation(operation.entryRef);
        if (action === null || action.kind === 'none') return { status: 'unavailable' };
        if (operation.tab !== undefined) {
          const descriptor = readTriageSourceDescriptorV1(surfaceContext, operation.entryRef.source);
          const kind = descriptor?.kinds.find((candidate) => candidate.id === operation.entryRef.kindId);
          const composition = planTriageDetailTabsV1({ workflowSubject: kind?.workflowSubject ?? null, entryTabs: kind?.detailTabs, fixPullRequest: null });
          if (composition.kind !== 'tabs' || !composition.tabs.some((tab) => tab.frameId === operation.tab)) return { status: 'unavailable' };
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
      case 'attachEntry':
      case 'removeEntry':
        // Attachment intents address a mounted picker, never this list page.
        return { status: 'unavailable' };
      case 'selectDetailTab':
        if (selectedKey === null || !detailTabs?.some((tab) => tab.value === operation.tab && !tab.disabled)) return { status: 'unavailable' };
        chooseDetailTab(operation.tab);
        break;
      case 'selectLinkedSession':
        if (selectedKey === null || detailSessions?.key !== selectedKey
          || !detailSessions.sessions.some((session) => session.sessionId === operation.sessionId)) return { status: 'unavailable' };
        setDetailTab({ key: selectedKey, tab: 'session', sessionId: operation.sessionId });
        break;
      case 'setLens': {
        const smartPolicy = operation.smartPolicy === undefined ? surface.smartPolicy : parseCorpusSmartPolicy(operation.smartPolicy);
        if (smartPolicy === null) return { status: 'rejected' };
        // Old Tasks URLs seed Mine when the route omits an audience. Leave that
        // compatibility entrance when choosing PRs, so reload keeps the choice.
        if (props.tasksPage && operation.filters.tasks === undefined) {
          const location = preflightTriageRouteLensV1({ ...readTriageRouteLensV1(surface),
            query: operation.query, filters: operation.filters, order: operation.order, smartPolicy });
          if (location.kind === 'refused') return { status: 'rejected' };
          const selection = surface.selection;
          const launch = selection === null ? undefined : buildTriageEntryDetailLaunchInput({
            entryRef: selection.entryRef,
            sourceInstance: { source: selection.entryRef.source, sourceInstanceId: selection.sourceInstanceId },
            ...(detailOriginComposer === null ? {} : { originComposer: detailOriginComposer }),
          });
          await hostApi.openSurface(TRIAGE_ENTRY_DETAIL_DESTINATION_V1, launch, { subPath: location.subPath, signal });
          break;
        }
        if (await settleLensEditBeforeDurable({ kind: 'savedViewApplied', viewId: surface.selectedViewId,
          query: operation.query, filters: operation.filters, order: operation.order, smartPolicy }) === null) return { status: 'rejected' };
        break;
      }
      case 'selectSavedView': return await selectView(operation.viewId, signal);
      case 'setSelection': {
        const keys = operation.entryRefs.map(triageEntryRowKey);
        if (keys.some((key) => !bulkSelection.getSnapshot().eligibleKeys.has(key))) return { status: 'unavailable' };
        bulkSelection.setSelectedKeys(keys);
        break;
      }
      case 'retryAccountData':
        if (!viewsUnreachable && !pinsUnreachable) return { status: 'unavailable' };
        if (viewsUnreachable) savedViews.retry();
        if (pinsUnreachable) marks.retry();
        break;
      case 'retrySessionActivity':
        if (!sessionActivityUnavailable) return { status: 'unavailable' };
        sessionActivity.retry();
        break;
      case 'retryFixPullRequests':
        if (detailFixRetry === null || detailFixRetry.key !== selectedKey) return { status: 'unavailable' };
        detailFixRetry.retry();
        break;
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
        refreshPage();
        break;
      case 'loadMore': {
        if (operation.section === 'linkedSessions') {
          if (selectedKey === null || detailSessions?.key !== selectedKey || detailSessions.loadMore === null) return { status: 'unavailable' };
          detailSessions.loadMore();
          break;
        }
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
  }, [bulkSelection, bulkSessions, chooseCollectionView, chooseDetailTab, chooseDoneExpanded, collection.actions, collection.expanded, collection.keys, collectionWindow, surfaceContext, detailOriginComposer, detailTabs, detailSessions, detailFixRetry, hostApi, loadMoreEntries, loadMorePins, marks.retry, pinsUnreachable, props.tasksPage, readEntryActivation, refreshPage, refreshState.kind, savedViews.retry, selectView, selectedKey, sessionActivity.retry, sessionActivityUnavailable, settleLensEditBeforeDurable, surface, taskAudience, viewsUnreachable, visibleOrder]);
  const mountedOperationRef = React.useRef(runMountedOperation);
  React.useLayoutEffect(() => { mountedOperationRef.current = runMountedOperation; }, [runMountedOperation]);
  React.useLayoutEffect(() => sharedScope === null || !surfaceActivity.active ? undefined : bindTriageMountedUiActions(
    sharedScope, mountId, (operation, signal) => mountedOperationRef.current(operation, signal),
  ), [mountId, sharedScope, surfaceActivity.active]);
  const executeMountedOperation = React.useCallback((operation: TriageMountedUiOperationV1) => {
    executeTriageMountedUiAction(hostApi, mountId, operation, text);
  }, [hostApi, mountId, text]);
  const chooseLinkedSession = React.useCallback((sessionId: string) => {
    executeMountedOperation({ kind: 'selectLinkedSession', sessionId });
  }, [executeMountedOperation]);
  const retryDetailFixPullRequests = React.useCallback(() => {
    executeMountedOperation({ kind: 'retryFixPullRequests' });
  }, [executeMountedOperation]);
  const loadMoreLinkedSessions = React.useCallback(() => {
    executeMountedOperation({ kind: 'loadMore', section: 'linkedSessions' });
  }, [executeMountedOperation]);
  /**
   * The destination's two views (owner ruling Q1): Tasks and PRs & Issues are one lens apart. The page's switch and
   * the agent's commands apply the same mounted operation, so a view chosen either way settles the same location.
   */
  const pageViewOperations = React.useMemo(() => {
    const { tasks: _tasks, ...prsFilters } = surface.filters;
    return {
      tasks: { kind: 'setLens', query: surface.search.query, filters: { ...surface.filters, tasks: taskAudience ?? 'mine' },
        order: surface.order, smartPolicy: surface.smartPolicy } satisfies TriageMountedUiOperationV1,
      prs: { kind: 'setLens', query: surface.search.query, filters: prsFilters, order: surface.order,
        smartPolicy: surface.smartPolicy } satisfies TriageMountedUiOperationV1,
    };
  }, [surface.filters, surface.order, surface.search.query, surface.smartPolicy, taskAudience]);
  const mountedCommands = React.useMemo(() => {
    const command = (title: string, operation: TriageMountedUiOperationV1): CurrentUiCommandDeclarationV1 => ({
      title, command: { kind: 'executeAction', action: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, input: { mountId, operation } },
    });
    return [
      command(text('plugins.triage.tasks.title', 'Tasks'), pageViewOperations.tasks),
      command(TRIAGE_DISPLAY_NAME, pageViewOperations.prs),
      ...(taskAudience === undefined ? [] : [command(
        `${doneOpen ? text('plugins.triage.tasks.hideDone', 'Hide') : text('plugins.triage.tasks.showDone', 'Show')} ${text('plugins.triage.tasks.completed', 'Done')}`,
        { kind: 'setGroupExpanded', group: 'completed', expanded: !doneOpen },
      )]),
      ...(taskAudience === undefined ? [] : (['mine', 'agents', 'everyone'] as const).map((audience) => command(
        text(`plugins.triage.tasks.${audience}`, audience === 'mine' ? 'Mine' : audience === 'agents' ? 'Agents' : 'Everyone'),
        { kind: 'setLens', query: surface.search.query, filters: { ...surface.filters, tasks: audience }, order: surface.order, smartPolicy: surface.smartPolicy },
      ))),
      ...(detailSessions?.key !== selectedKey || detailSessions.loadMore === null ? [] : [command(
        `${text('plugins.triage.surface.loadMore', 'Load more')} ${text('plugins.triage.surface.detail.sessions', 'Sessions')}`,
        { kind: 'loadMore', section: 'linkedSessions' },
      )]),
      // Keep continuation reachable before per-row commands fill the host's
      // existing bounded current-context projection.
      ...[...sourcePanel.commands.filter(({ operation }) => operation.kind === 'loadMoreSourceItems'),
        ...sourcePanel.commands.filter(({ operation }) => operation.kind !== 'loadMoreSourceItems')].map(({ title, operation }): CurrentUiCommandDeclarationV1 => ({
        title, command: { kind: 'executeAction', action: triageSourcePanelActionIdV1(operation), input: { mountId, operation } },
      })),
      ...(taskAudience === undefined ? [command(text('plugins.triage.currentContext.board', 'Switch to Board'), { kind: 'switchView', view: 'board' })] : []),
      command(text('plugins.triage.currentContext.list', 'Switch to List'), { kind: 'switchView', view: 'list' }),
      ...(selectedKey === null ? [] : [command(text('plugins.triage.currentContext.closeDetail', 'Close detail'), { kind: 'closeDetail' })]),
      ...(selectedKey === null || !detailTabs ? [] : detailTabs.map((tab) => command(
        text('plugins.triage.currentContext.selectTab', 'Select {tab} tab', { tab: tab.title }), { kind: 'selectDetailTab', tab: tab.value },
      ))),
      ...(detailSessions?.key !== selectedKey ? [] : detailSessions.sessions.map((session) => command(
        text('plugins.triage.currentContext.selectLinkedSession', 'Select session {title}', { title: session.displayTitle ?? text('session.untitled', 'Untitled session') }),
        { kind: 'selectLinkedSession', sessionId: session.sessionId },
      ))),
      ...(refreshState.kind !== 'blocked' ? [command(text('plugins.triage.currentContext.refresh', 'Refresh PRs & Issues'), { kind: 'refresh' })] : []),
      ...(collectionWindow.kind !== 'partial' ? [] : collectionWindow.continuations.flatMap((continuation) => continuation.busy ? [] : [
        command(continuation.label, { kind: 'loadMore', section: continuation.key === 'pins' ? 'pins' : 'entries' }),
      ])),
      command(text('plugins.triage.currentContext.clearSelection', 'Clear bulk selection'), { kind: 'setSelection', entryRefs: [] }),
      ...(bulkSessions.retryable ? [command(text('plugins.triage.surface.bulk.retry', 'Try again'), { kind: 'retryRun' })] : []),
      ...(viewsUnreachable || pinsUnreachable ? [command(text('plugins.triage.surface.actions.retry', 'Retry'), { kind: 'retryAccountData' })] : []),
      ...(sessionActivityUnavailable ? [command(text('plugins.triage.surface.actions.retry', 'Retry'), { kind: 'retrySessionActivity' })] : []),
      ...(detailFixRetry === null || detailFixRetry.key !== selectedKey ? [] : [command(
        `${text('plugins.triage.surface.actions.retry', 'Retry')}: ${text('plugins.triage.surface.detail.fixPr.title', 'Fix pull request')}`,
        { kind: 'retryFixPullRequests' },
      )]),
      ...(isTriageBulkSessionsPhaseRunningV1(bulkSessions.phase) ? [command(text('plugins.triage.surface.bulk.cancel', 'Stop'), { kind: 'cancelRun' })] : []),
    ];
  }, [bulkSessions.phase, bulkSessions.retryable, collectionWindow, detailTabs, detailSessions, detailFixRetry, doneOpen, mountId, pageViewOperations, pinsUnreachable, refreshState.kind, selectedKey, sessionActivityUnavailable, sourcePanel.commands, surface.filters, surface.order, surface.search.query, surface.smartPolicy, taskAudience, text, viewsUnreachable]);
  // Focus and IME composition are local reader state, not published context.
  // Keep that producer's inputs stable so moving the cursor does not retire
  // and recreate every host command address for an unchanged selection/lens.
  const currentContextSurface = React.useMemo(() => ({
    selection: surface.selection,
    order: surface.order,
    smartPolicy: surface.smartPolicy,
    filters: surface.filters,
    selectedViewId: surface.selectedViewId,
    search: { query: surface.search.query },
  }), [surface.selection, surface.order, surface.smartPolicy, surface.filters, surface.selectedViewId, surface.search.query]);
  const projectCurrentContext = React.useCallback((visibleRows: readonly TriageListRowV1[]) => projectTriageCurrentUiContextV1({
    surface: currentContextSurface, visibleRows, mountedCommands,
    mountedAction: { action: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 }, mountId },
    ...(detailSessions?.key !== selectedKey ? {} : { linkedSessions: {
      ids: detailSessions.sessions.map((session) => session.sessionId),
      selectedId: detailSessions.sessions.find((session) => session.sessionId === (detailTab?.key === selectedKey ? detailTab.sessionId : null))?.sessionId
        ?? detailSessions.sessions[0]?.sessionId ?? null,
    } }),
    formatOpenEntryTitle: (title) => text('plugins.triage.currentContext.openEntry', 'Open {title}', { title }),
  }), [detailSessions, detailTab, selectedKey, mountId, mountedCommands, currentContextSurface, text]);
  const currentUiContext = React.useMemo(() => projectCurrentContext(currentUiContextRows), [currentUiContextRows, projectCurrentContext]);
  const contextPublication = React.useMemo(() => window.readOwner === null ? undefined : {
    subscribe: (listener: () => void) => window.readOwner!.subscribe(change => {
      // This layout subscriber can run before the shell's external-store subscriber.
      listPublication.synchronize(window.readOwner!.getSnapshot(), change);
      listener();
    }),
    read: () => {
      const rows = window.readOwner!.getSnapshot().window?.rows ?? EMPTY_WINDOW_ROWS;
      const currentItems = listPublication.getItems();
      const index = indexTriageListItems(currentItems);
      rowsByKeyRef.current = index;
      windowRowsRef.current = rows;
      const selected = selectedKey === null ? null : window.readOwner!.getRow(selectedKey);
      heldRow.current = retainTriageLastKnownRowV1(heldRow.current, currentContextSurface.selection, selected);
      return projectCurrentContext(rows.filter(row => index.has(triageEntryRowKey(row.entryRef))));
    },
  }, [window.readOwner, listPublication, currentContextSurface.selection, selectedKey, projectCurrentContext]);
  useTriageCurrentUiContextPublication(hostApi, currentUiContext, contextPublication);
  openChangeRef.current = (key) => {
    if (key === TRIAGE_TASK_DRAFT_KEY_V1) return;
    // Opening a row, or closing the pane, puts the draft away: nothing was sent while it was a draft.
    if (creatingTask) {
      closeTaskDraft();
      if (key === null) return;
    }
    if (key === null) dismissDetail();
    else activateRow(key);
  };
  /** The shared row facts the Collection's rows read: Pin/Unpin, and the one open path (the peek's Open). */
  const rowEnvironment = React.useMemo(
    () => ({ handlers: pinHandlers, onOpen: onCollectionOpenChange }),
    [onCollectionOpenChange, pinHandlers],
  );
  const itemAnatomy = useTriageListAnatomyV1({
    ...readTriageDataColumnsV1({ tasks: taskAudience !== undefined, items, sharedGroupReasons }),
    organizing,
    sharedGroupReasons,
    tasks: taskAudience !== undefined,
    taskAudience,
    taskItems: items,
    readBlockerName: listPublication.getBlockerName,
    personalTaskOrder: personalTaskOrder.available ? personalTaskOrder.value : null,
    onTaskOrderOutcome: personalTaskOrder.onDropOutcome,
    onTaskApplied: refresh,
    pinMarks: collectionView === 'board',
  });
  // Every row names its own selection below; the current detail must not
  // replace all row destinations when the rest of the lens is unchanged.
  const routeLens = React.useMemo(() => readTriageRouteLensV1({ ...surface, selection: null }), [
    surface.order, surface.smartPolicy, surface.filters, surface.search.query, surface.selectedViewId,
  ]);
  const anatomy = React.useMemo(() => ({ ...itemAnatomy,
    destination: (item: TriageListItemV1) => {
      const location = preflightTriageRouteLensV1({ ...routeLens, selection: item.row.entryRef });
      return location.kind === 'refused' ? null : { destination: TRIAGE_ENTRY_DETAIL_DESTINATION_V1, subPath: location.subPath };
    },
  }), [itemAnatomy, routeLens]);

  useTriageRouteBinding({
    queue: routeQueue,
    surface,
    readerChangedLens,
    settledRoute,
    latestRouteIntent,
    rowsByKeyRef,
    dispatch,
    onFailure: setRouteWriteFailure,
  });
  useTriageSavedViewBinding({
    saved: savedViews.saved,
    selectedViewId: surface.selectedViewId,
    applyLensEdit,
  });
  useTriageSettledLocation({
    queue: routeQueue,
    subPath: props.subPath,
    launch: props.launch,
    pageLaunch: props.pageLaunch,
    configuredSources: window.snapshot.configuredSources,
    targetedContributions: surfaceContext.targetedContributions,
    readEntryActivation,
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
    latestRouteIntent,
    onRouteWriteFailure: setRouteWriteFailure,
  });

  /**
   * A settled window that does not hold the location's entry says so without
   * requiring an inventory walk (`ui/shell/absentRoute.ts`).
   */
  const absentRoute = readTriageAbsentRouteV1({
    subPath: props.subPath,
    windowSettled: state.kind === 'window',
    selected: surface.selection !== null,
    pending: window.snapshot.pending,
    loadMore: window.snapshot.loadMore,
    rowsByKey,
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
  // The trackers the Tasks first run offers: the same destinations, only the sources that bring tasks.
  const taskTrackerOffers = React.useMemo(
    () => (taskAudience !== undefined && hostApi.version().methods.includes('openSurface')
      ? [...planTriageConfigureSourceOffersV1(surfaceContext.targetedContributions, { tasks: true })].sort(
        (left, right) => left.displayName.localeCompare(right.displayName, surfaceContext.locale))
      : []),
    [hostApi, surfaceContext.locale, surfaceContext.targetedContributions, taskAudience],
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
  ): Promise<void> => {
    if (await configuredSources.remove(sourceInstanceId)) refresh();
  }, [configuredSources, refresh]);

  // Admission already says which sources cannot run here. Their recovery belongs to the list,
  // through the existing source panel and its admitted Remove action, including when no rows remain.
  const sourceManagementAction = window.snapshot.configuredSources.some(source => !source.available) ? (
    <Button titleKey="plugins.triage.surface.sources.manage" title="Manage sources" variant="secondary"
      onPress={() => setEditingSources(true)} />
  ) : undefined;
  // Beside a status line the same fix is a plain action, as Retry is beside its sentence.
  const sourceManagementStatusAction = sourceManagementAction === undefined ? undefined : (
    <TriageFailureLineAction label={text('plugins.triage.surface.sources.manage', 'Manage sources')}
      onPress={() => setEditingSources(true)} />
  );

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
    onSelectView: (viewId) => executeMountedOperation({ kind: 'selectSavedView', viewId }),
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
          size="small"
          onPress={() => executeMountedOperation({ kind: 'retryAccountData' })}
        />
      )}
    />
  );

  /**
   * The one calm toolbar row above the list (`core/SURFACE.md` §6): the lens
   * pickers lead — Views, one Filters trigger for the facets, Order — and the page's own controls trail: its freshness, Refresh, and an
   * overflow holding the rare administration actions. The page's name leads the row (`slots.title`), except where
   * the host's navigation already shows it (a phone's header).
   *
   * It is the same toolbar before the first pass has answered, so Refresh and
   * the lens are reachable from the very first frame.
   */
  // At rest the toolbar states the read's age, quietly and without a mark: "Up to date" stops being true the moment
  // the window ages, while "Updated 5 minutes ago" stays true and sits beside the Refresh that renews it.
  // Muted: healthy is quiet, so on a phone it folds under Refresh in ⋯ (lab `merged-list-phone` shows no age).
  const readAge = readAgeAtMs === undefined ? null : {
    tone: 'muted' as const,
    pulsing: false,
    indicator: false,
    label: eligibilityNowMs - readAgeAtMs < 60_000
      ? text('plugins.triage.surface.updatedJustNow', 'Updated just now')
      : text('plugins.triage.surface.updatedAgo', 'Updated {age}', {
        age: formatTriageTimestampV1(surfaceContext.locale, readAgeAtMs, 'relative', eligibilityNowMs),
      }),
  };
  const freshness = state.kind !== 'window' || hostSpeaksForOutage ? null : state.refreshing
    ? { tone: 'neutral' as const, pulsing: true, indicator: true, label: text('plugins.triage.surface.refreshing', 'Refreshing') }
    : state.showReadWarning
      // "The last known list" is a claim about rows on screen. With none, the body's failure state is the
      // whole answer, and this line would be false and a second voice for one cause.
      // Over rows, a failed connection's notice already says whose list stopped and why; the line keeps only the
      // read's age, which the notice does not say.
      ? rowCount === 0 ? null : state.failure != null ? readAge
        : { tone: 'warning' as const, pulsing: false, indicator: true, label: text('plugins.triage.surface.lastKnown', 'Showing the last known list') }
      : readAge;
  const moreLabel = text('plugins.triage.surface.more', 'More');
  const activeFilterCount = readTriageRefineCountV1(facets);
  /**
   * The page's one header (lab `cbar`), composed by the shared Collection toolbar for the width it is drawn at: the
   * page's name, the search (its filter funnel at its end), the view and Order lead; freshness, Refresh, More and List |
   * Board trail; what is filtered stands on the token line under it. On a phone order, freshness and Refresh fold
   * behind ⋯ and the funnel opens the filters as the sheet. Inside the
   * Collection it receives the Collection's own pieces (`CollectionHeaderSlots`); placing `pageActions` there is what
   * retires the host's separate machine band. Outside a Collection (the page could not be read) it is the same toolbar
   * without them.
   */
  // The destination's two views (owner ruling Q1) as one segmented choice. Where the toolbar draws the page's name it
  // stands in that place, so the selected view is the page's name; where host chrome already shows the name (a
  // phone) it leads the lens, above whose tasks.
  const pageViewSwitch = (
    <Select
      label={text('plugins.triage.pageView', 'Page')}
      presentation="segmented"
      value={taskAudience === undefined ? 'prs' : 'tasks'}
      options={[
        { value: 'tasks', label: text('plugins.triage.tasks.title', 'Tasks') },
        { value: 'prs', label: TRIAGE_DISPLAY_NAME },
      ]}
      // The page applies the operation itself, through the same local handler its published Action dispatches into:
      // switching views is a lens change and needs no Action round trip (nor a Machine to run one).
      onChange={(value) => {
        const operation = value === 'tasks' && taskAudience === undefined ? pageViewOperations.tasks
          : value === 'prs' && taskAudience !== undefined ? pageViewOperations.prs : null;
        if (operation !== null) void runMountedOperation(operation, new AbortController().signal);
      }}
    />
  );
  const startNewTask = () => {
    if (creatingTask) return;
    const staged = stageTriageTaskDraft(sharedScope, {});
    if (staged === null) return;
    setLocalTaskDraft(staged);
    setCreatingTask(true);
  };
  const renderListToolbar = (slots?: CollectionHeaderSlots, orderedByTable = false) => {
    // Coverage is the window owner's fact: a loaded subset is never said as an authoritative total.
    const filterResult = { matchedCount: rowCount, coverage: state.kind !== 'window' ? 'unavailable' as const
      : state.window.coverage === 'complete' ? 'complete' as const : 'partial' as const };
    const switchAsTitle = slots?.title != null;
    // A first run with nothing listed (lab `merged-connect`): filters, an order and List | Board could change nothing,
    // so the toolbar keeps only the page switch, the saved views and More.
    const tasksFirstRun = empty?.kind === 'taskFirstRun';
    // On Tasks the lens leads with whose tasks (Mine · Agents · Everyone), three short options as one segmented
    // control, then the saved view.
    const lens = taskAudience === undefined ? views.control : <Row gap="small" align="center"><Select
        label={text('plugins.triage.tasks.audience', 'Show tasks')}
        presentation="segmented"
        value={taskAudience}
        options={(['mine', 'agents', 'everyone'] as const).map((value) => ({ value,
          label: text(`plugins.triage.tasks.${value}`, value === 'mine' ? 'Mine' : value === 'agents' ? 'Agents' : 'Everyone') }))}
        onChange={(value) => { if (value === 'mine' || value === 'agents' || value === 'everyone')
          applyLensEdit({ kind: 'taskAudienceChanged', audience: value }, 'lens'); }}
      />{views.control}</Row>;
    return (
    <CollectionToolbar
      {...(slots === undefined ? {} : { slots: switchAsTitle ? { ...slots, title: pageViewSwitch } : slots })}
      // Under host chrome (a phone) the switch leads the lens: beside the saved view on PRs & Issues, and on its own
      // line above whose tasks on Tasks, where the row would not hold both segmented controls.
      lens={tasksFirstRun ? (switchAsTitle ? views.control : <Row gap="small" align="center">{pageViewSwitch}{views.control}</Row>)
        : switchAsTitle ? lens : taskAudience === undefined
        ? <Row gap="small" align="center">{pageViewSwitch}{views.control}</Row>
        : <Stack gap="small">{pageViewSwitch}{lens}</Stack>}
      // New task is the Tasks page's one primary action; on the first run it is the personal list's own button.
      {...(taskAudience === undefined || tasksFirstRun ? {} : { primary: { label: text('plugins.triage.tasks.new', 'New task'),
        onPress: startNewTask } })}
      {...(nothingToArrange ? {} : { refine: {
        label: text('plugins.triage.surface.filters', 'Filters'),
        activeCount: activeFilterCount,
        render: () => (
          <TriageFilterRail
            order={surface.order}
            smartPolicy={surface.smartPolicy}
            text={text}
            onChangeOrder={changeOrder}
            onChangeSmartPolicy={changeSmartPolicy}
          />
        ),
        // The funnel at the search field's end opens this at every width: anchored under the field on a wide page,
        // the shared sheet on a phone. Folded, Order joins ⋯.
        sheet: {
          header: 'none',
          render: (controls) => (
            <TriageFilterSheet
              controls={controls}
              facets={facets}
              text={text}
              onToggleFilterValue={toggleFilterValue}
              onClearFacet={clearFilterFacet}
              onClearFilters={clearFilters}
              result={filterResult}
              doneLabel={readTriageFilterDoneLabelV1({ text, resultCount: rowCount, windowState: state })}
            />
          ),
        },
        ...(orderedByTable ? {} : { foldedChoices: readTriageOrderChoicesV1({
          order: surface.order,
          smartPolicy: surface.smartPolicy,
          text,
          onChangeOrder: changeOrder,
          onChangeSmartPolicy: changeSmartPolicy,
        }) }),
      } })}
      accessory={organizing ? (
        <Button
          titleKey="plugins.triage.sessionLinks.done"
          title="Done"
          variant="plain"
          onPress={() => setOrganizing(false)}
        />
      ) : (
        // While rows are selected, which action a bulk press applies is one compact menu beside "Done";
        // the destinations stay in the floating bar, so the list keeps its space.
        <TriageBulkActionPicker
          actions={configuredActions.actions}
          selectedWorkflowSubjects={selectedBulkWorkflowSubjects}
          selectedActionId={bulkActionId}
          disabled={isTriageBulkSessionsPhaseRunningV1(bulkSessions.phase)}
          onChange={setBulkActionId}
        />
      )}
      // Freshness is said, never implied by silence, but quietly while the list is current, so the one thing that
      // stands out is a list that is not. Stale is the only warning-toned state.
      freshness={freshness}
      refresh={{
        label: text('plugins.triage.surface.refresh', 'Refresh'),
        busy: refreshState.kind === 'running',
        disabled: refreshState.kind === 'blocked',
        onPress: refreshPage,
      }}
      more={{
        label: moreLabel,
        items: [
          ...(!organizing ? [{ id: 'organize-list', label: text('plugins.triage.surface.organizeList', 'Organize list') }] : []),
          { id: 'configure-actions', label: text('plugins.triage.surface.actions.configure', 'Configure actions') },
          { id: 'manage-sources', label: text('plugins.triage.surface.sources.manage', 'Manage sources') },
        ],
        onSelect: (id) => {
          if (id === 'organize-list') setOrganizing(true);
          else if (id === 'configure-actions') editAction();
          else if (id === 'manage-sources') setEditingSources(true);
        },
      }}
      {...(taskAudience !== undefined || nothingToArrange ? {} : { views: {
        label: text('plugins.triage.surface.view.label', 'View'),
        value: collectionView,
        options: [
          { value: 'list', label: text('plugins.triage.surface.view.list', 'List'), icon: 'list' },
          { value: 'board', label: text('plugins.triage.surface.view.board', 'Board'), icon: 'board' },
        ],
        onChange: (value) => {
          if (value === 'list' || value === 'board') chooseCollectionView(value);
        },
      } })}
    />
    );
  };

  /**
   * The assembled window, when there is one. The chrome below serves both it
   * and §6.2's reachability state 5, where the reader's pins are the only rows
   * and there is no window to make a freshness claim about.
   */
  const listWindow = state.kind === 'window' ? state : null;
  const empty = readTriageListEmptyState(state, rowCount, { narrowing, text, locale: surfaceContext.locale });
  // Pins stay listed under a narrowing (applying the filter to them is a separate product call, left as is), so a
  // narrowing that removed every other row says so below them instead of ending in a blank canvas.
  const pinnedCount = items.reduce((count, item) => item.group === 'pinned' ? count + 1 : count, 0);
  const emptyBelowPins = collectionView !== 'list' ? null
    : readTriageListEmptyBelowPinsV1(state, { pinned: pinnedCount, unpinned: rowCount - pinnedCount }, { narrowing, text, locale: surfaceContext.locale });
  const emptyAnswer = empty ?? emptyBelowPins;
  // A first run with nothing listed (labs `merged-connect`, `tasks-firstrun`) is the page's whole answer: filters, an
  // order (the toolbar's and the table's named order) and List | Board could change nothing, so none is drawn.
  const nothingToArrange = (state.kind === 'configureSources' && rowCount === 0) || empty?.kind === 'taskFirstRun';
  /**
   * The empty narrowed list's ways out, drawn from the one decision (`empty.next`): the first is the
   * primary control and the rest follow it quietly. Read-further is the entries continuation the
   * Collection footer offers, and is left out when the walk has nothing left to read.
   */
  const entriesContinuation = collectionWindow.kind === 'partial'
    ? collectionWindow.continuations.find((continuation) => continuation.key === 'entries')
    : undefined;
  // Each next step is one Button, typed by the Button contract itself: the first is the primary control and
  // the rest follow quietly.
  const emptyNextButtons: React.ReactElement[] = [];
  for (const step of emptyAnswer?.next ?? []) {
    const variant = emptyNextButtons.length === 0 ? 'secondary' : 'plain';
    switch (step) {
      case 'loadMore':
        if (entriesContinuation !== undefined) {
          emptyNextButtons.push(
            <Button key={step} title={entriesContinuation.label} busy={entriesContinuation.busy} variant={variant} onPress={entriesContinuation.load} />,
          );
        }
        break;
      case 'clearSearch':
        emptyNextButtons.push(
          <Button key={step} titleKey="plugins.triage.surface.search.clear" title="Clear search" variant={variant} onPress={() => changeSearch('')} />,
        );
        break;
      case 'clearFilters':
        emptyNextButtons.push(
          <Button key={step} titleKey="plugins.triage.surface.filters.clear" title="Clear filters" variant={variant} onPress={clearFilters} />,
        );
        break;
    }
  }
  const [primaryNext, ...quietNext] = emptyNextButtons;
  const emptyNextControls = {
    ...(primaryNext === undefined ? {} : { action: primaryNext }),
    ...(quietNext.length === 0 ? {} : { secondaryAction: <>{quietNext}</> }),
  };

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
  const detailRow = selectedRow ?? lastKnown?.row ?? null;
  const detailContent = (headerHosted: boolean, pushed: boolean): React.ReactNode => surface.selection === null ? null : (
    detailRow !== null ? (
      <TriagePublishedDetail
        exactRead={exactRead}
        sourcePanelActions={sourcePanel.actions}
        onFixPullRequestsRetryChange={reportDetailFixRetry}
        onRetryFixPullRequests={retryDetailFixPullRequests}
        tabSelection={{ value: detailTab?.key === selectedKey ? detailTab.tab : 'overview', onChange: chooseDetailTab }}
        sessionSelection={{ value: detailTab?.key === selectedKey ? detailTab.sessionId ?? null : null,
          onChange: chooseLinkedSession, onAvailableSessionsChange: reportDetailSessions, onLoadMore: loadMoreLinkedSessions }}
        headerHosted={headerHosted}
        pushed={pushed}
        row={detailRow}
        lastKnown={selectedRow === null}
        completePostMutation={completePostMutation}
        refreshGeneration={detailRefreshGeneration}
        lanes={listWindow?.window.lanes ?? []}
        rows={windowRows}
        connectionLabel={selectedConnectionLabel}
        // The ONE aggregate action target (`ui/state/actionTarget.ts`), resolved
        // where the reducer state lives and passed down. The detail region holds
        // the source descriptor a control set needs but no `sectionId`, so
        // resolving it there would be a second target reader for one concept.
        target={actionTarget}
        actions={configuredActions}
        onEditAction={editAction}
        originComposer={detailOriginComposer}
        pin={{
          row: projectTriageWindowRow(detailRow, pinsByEntry, { text }),
          handlers: pinHandlers,
        }}
        onClose={dismissDetail}
      />
    ) : unobservedSelection !== null ? (
      readFailed ? <Stack gap="small"><ErrorState
        titleKey="plugins.triage.surface.detail.accountError.title" title="These details could not be read"
        descriptionKey="plugins.triage.surface.detail.accountError.description"
        description="This entry's details are unavailable right now. Try again when the connection is available."
        action={<Button titleKey="plugins.triage.surface.actions.retry" title="Retry" variant="secondary" onPress={completePostMutation} />}
      /><PullRequestFailureDetails
        codes={[selectedReadFailure?.code, ...(selectedReadFailure?.diagnostics?.map(diagnostic => diagnostic.code) ?? [])]}
        requestId={readPluginErrorRequestIdV1(selectedReadFailure)}
      /></Stack> : <LoadingState titleKey="plugins.triage.surface.detail.reading" title="Reading this entry" />
    ) : (
      // Keep the selection visible without inferring source absence or a
      // filter exclusion from details this page has not loaded.
      <Stack gap="small">
        {headerHosted ? null : <Row justify="space-between" align="center">
          <Heading
            level={2}
            value={text('plugins.triage.surface.entryNotLoaded.heading', 'These details are not loaded')}
          />
          <IconButton
            icon={<Icon name="close" tone="secondary" />}
            accessibilityLabel={text('plugins.triage.surface.close', 'Close')}
            onPress={dismissDetail}
          />
        </Row>}

        <EmptyState
          titleKey="plugins.triage.surface.entryNotLoaded.heading"
          title="These details are not loaded"
          descriptionKey="plugins.triage.surface.entryNotLoaded.description"
          description="This page has not loaded details for this entry."
        />
      </Stack>
    )
  );

  /** The one detail composition, in whichever container the Collection holds it. */
  const renderDetail = (key: string, { headerHosted, pushed }: CollectionDetailRenderContext): React.ReactNode => key === TRIAGE_TASK_DRAFT_KEY_V1
    ? <TriageCreateTaskFields key={props.createDraftId ?? localTaskDraft?.input.draftId ?? 'task-draft'}
      draftId={props.createDraftId ?? localTaskDraft?.input.draftId} sources={configuredSources.sources}
      sourcesLoaded={configuredSources.loaded} sourcesUnavailableReason={configuredSources.unavailableReason}
      suggestionRows={listWindow?.window.rows}
      {...(props.createDraft === undefined ? {} : { draft: props.createDraft })}
      onApplied={refresh} onClose={closeTaskDraft}
      onCreated={(created) => {
        closeTaskDraft();
        applyLensEdit({ kind: 'rowActivated', sectionId: null, entryRef: created.entryRef, sourceInstanceId: created.sourceInstanceId }, 'selection');
      }} />
    : detailContent(headerHosted, pushed);
  const selectedHeader = selectedRow === null ? lastKnownHeader : projectTriageDetailHeaderV1({
    row: selectedRow,
    lanes: listWindow?.window.lanes ?? [],
    connectionLabel: selectedConnectionLabel,
    sourceDescriptor: readTriageSourceDescriptorV1(surfaceContext, selectedRow.entryRef.source),
    linkedSessions: [],
    linkedSessionsHasMore: false,
    text,
  });
  const detailHeader = (key: string) => {
    if (key === TRIAGE_TASK_DRAFT_KEY_V1) return { title: text('plugins.triage.tasks.new', 'New task') };
    if (selectedHeader === null && unobservedSelection !== null) {
      // A pin already knows its title; the read failure belongs to the body below, not to the page title.
      const pinnedTitle = pinsByEntry.get(triageEntryRowKey(unobservedSelection.entryRef))?.displayAtMark.title;
      if (pinnedTitle !== undefined) return { title: pinnedTitle };
      return { title: readFailed
        ? text('plugins.triage.surface.detail.accountError.title', 'These details could not be read')
        : text('plugins.triage.surface.detail.reading', 'Reading this entry') };
    }
    if (selectedHeader === null) return { title: text('plugins.triage.surface.entryNotLoaded.heading', 'These details are not loaded') };
    const pinRow = selectedRow === null ? lastKnownPinRow : projectTriageWindowRow(selectedRow, pinsByEntry, { text });
    return renderTriageDetailHeaderV1({ header: selectedHeader, text, locale: surfaceContext.locale, nowMs: Date.now(),
      ...(pinRow === null ? {} : { pin: { row: pinRow, handlers: pinHandlers } }) });
  };
  const entryPublication = React.useMemo(() => ({
    store: window.readOwner,
    readItem: listPublication.getItem,
    projectPin: (row: TriageListRowV1) => projectTriageWindowRow(row, pinsByEntry, { text }),
  }), [window.readOwner, listPublication, pinsByEntry, text]);
  const readPublishedHeader = (key: string, row: TriageListRowV1 | null) => {
      if (row === null || key === TRIAGE_TASK_DRAFT_KEY_V1) return detailHeader(key);
      const selected = selectedWindowRow?.selected;
      const detail = selected?.kind === 'selected' && selected.reason === 'override' ? { ...row, selected } : row;
      const header = projectTriageDetailHeaderV1({ row: detail,
        lanes: window.readOwner?.getSnapshot().window?.lanes ?? listWindow?.window.lanes ?? [],
        connectionLabel: selectedConnectionLabel,
        sourceDescriptor: readTriageSourceDescriptorV1(surfaceContext, detail.entryRef.source),
        linkedSessions: [], linkedSessionsHasMore: false, text,
      });
      return renderTriageDetailHeaderV1({ header, text, locale: surfaceContext.locale, nowMs: Date.now(),
        pin: { row: projectTriageWindowRow(detail, pinsByEntry, { text }), handlers: pinHandlers } });
  };
  /** The window-honesty line (COLLECTION.md §2): how many rows are loaded and which connections have more. */
  const windowStatement = readTriageWindowStatementV1({
    loadedCount: rowCount,
    window: listWindow?.window ?? null,
    configuredSources: window.snapshot.configuredSources,
    readSourceName: (source) => readTriageSourceDescriptorV1(surfaceContext, source)?.displayName,
    entries: planTriageListContinuationV1({ section: 'entries', state: windowLoadMore, text }),
    pins: marks.more || pinsLoadMore?.kind === 'failed' || pinsLoadMore?.kind === 'unresumable'
      ? planTriageListContinuationV1({ section: 'pins', state: pinsLoadMore, text })
      : null,
    firstRead: state.kind === 'initial',
    text,
  });

  // The one failure line, wherever the list shows it: beside rows, below pins, or in the empty list's place.
  const listFailureStatus = listWindow?.failure == null || hostSpeaksForOutage ? null : (
    <TriageListFailureStatus failure={listWindow.failure} manageSources={sourceManagementStatusAction}
      retry={<TriageFailureLineAction label={retryLabel}
        busy={refreshState.kind === 'running'} disabled={refreshState.kind === 'blocked'} onPress={refreshPage} />} />
  );

  return (
    <Screen safeArea style={TRIAGE_FILL_STYLE_V1}>
      <Stack gap="small" style={TRIAGE_FILL_STYLE_V1}>
      {entryOpenFailure === null ? null : <Banner tone="warning"
        title={text('plugins.triage.surface.detail.noConnection.title', 'No connection to open this through')}
        description={text('plugins.triage.surface.detail.noActiveConnection', 'No active connection is available for this entry’s source. Configure or reconnect a source, then open the entry again.')}
      />}
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
      {absentRoute === null ? null : (
        <Status
          tone="warning"
          label={text('plugins.triage.surface.entryNotLoaded.heading', 'These details are not loaded')}
          value={text('plugins.triage.surface.entryNotLoaded.description', 'This page has not loaded details for this entry.')}
          action={(
            <Button titleKey="plugins.triage.surface.absentRoute.retry" title="Check again" variant="plain" size="small"
              busy={refreshState.kind === 'running'} disabled={refreshState.kind === 'blocked'} onPress={refreshPage} />
          )}
        />
      )}
      <TriageEntryPublicationContext.Provider value={entryPublication}>
      <TriageHeaderPublicationContext.Provider value={readPublishedHeader}>
      <TriageListRowEnvironmentContext.Provider value={rowEnvironment}>
        <Collection<TriageListItemV1>
          resizeKey="triage"
          model={collection}
          anatomy={anatomy}
          accessibilityLabel={pageTitle}
          title={pageTitle}
          presentation={taskAudience === undefined && collectionView === 'board' ? 'board' : 'table'}
          // The first run is a page to read, not a list to scan: it scrolls with the page, toolbar included, so the
          // lower sources and the steps stay reachable on a phone. A populated list keeps its one scroller.
          {...(state.kind === 'configureSources' || empty?.kind === 'taskFirstRun' ? { scroll: 'page' as const } : {})}
          {...(nothingToArrange ? {} : { sort: {
            key: surface.order,
            direction: surface.order === 'oldest' ? 'ascending' as const : 'descending' as const,
            orders: orderOptions,
            onChange: changeCollectionOrder,
          } })}
          detail="auto"
          renderDetail={renderDetail}
          detailHeader={detailHeader}
          useDetailHeader={useTriagePublishedDetailHeader}
          minListWidth={minListWidth}
          minDetailWidth={minDetailWidth}
          preferredListRatio={TRIAGE_SPLIT_LIST_RATIO_PREFERENCE_V1}
          minCardWidth={TRIAGE_BOARD_CARD_MIN_WIDTH_V1}
          useRowItem={useTriagePublishedListItem}
          useRowActions={useTriageListRowActions}
          // Done sits collapsed as its band ("Done 6 · This week"): the week's finished tasks, one press away.
          {...(taskAudience === undefined ? {} : {
            collapsedGroups,
            groupAction: (groupKey: string) => groupKey !== 'completed' ? null : {
              label: doneOpen ? text('plugins.triage.tasks.hideDone', 'Hide') : text('plugins.triage.tasks.showDone', 'Show'),
              onPress: () => executeMountedOperation({ kind: 'setGroupExpanded', group: 'completed', expanded: !doneOpen }),
            },
          })}
          testID={TRIAGE_SHELL_FILL_TEST_ID_V1}
          listTestID={TRIAGE_SHELL_LIST_REGION_TEST_ID_V1}
          detailTestID={TRIAGE_SHELL_DETAIL_REGION_TEST_ID_V1}
          windowStatement={windowStatement}
          // New task is also the page's `C` key, named in the key line (lab `tasks-list`: "C new task").
          {...(taskAudience === undefined || empty?.kind === 'taskFirstRun' ? {} : {
            create: { hint: text('plugins.triage.tasks.newTaskHint', 'new task'), onPress: startNewTask },
          })}
          // The first read has not answered: the list's own region holds its geometry in skeleton rows, and the
          // toolbar above it stays reachable, so the page does not swap a stand-in tree for the list.
          loading={state.kind === 'initial'}
          header={(slots) => (
            <Stack gap="small">
          <TriageOrderPlacement>{(orderedByTable) => renderListToolbar(slots, orderedByTable)}</TriageOrderPlacement>
              {/* A linked Session problem is a note under the toolbar: the page's name leads. A read in progress says
                  nothing here: each row's Agent cell already holds its place, so no line appears and goes and moves the list. */}
              {listedEntryRefs.length === 0 || (!sessionActivityUnavailable && !sessionActivity.unreachable) ? null : (
                <Status
                  tone={sessionActivityUnavailable ? 'warning' : 'muted'}
                  labelKey={sessionActivityUnavailable
                    ? 'plugins.triage.surface.sessionActivity.unavailable'
                    : 'plugins.triage.surface.sessionActivity.unreachable'}
                  label={sessionActivityUnavailable
                    ? 'Some linked Session activity could not be read.'
                    : 'Some linked Sessions are unavailable.'}
                  // The sentence wraps beside its Retry, as the account notice's does, never above it on a line of its own.
                  action={sessionActivityUnavailable ? (
                    <Button
                      titleKey="plugins.triage.surface.actions.retry"
                      title="Retry"
                      variant="plain"
                      size="small"
                      onPress={() => executeMountedOperation({ kind: 'retrySessionActivity' })}
                    />
                  ) : undefined}
                />
              )}
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
            The list read failed, so there is no window or freshness claim.
            Only a classified Machine failure claims source unreachability.
            The reader's own durable state is still live, which is
            why this is a notice above their pins rather than a screen instead of
            them.
          */}
          {state.kind !== 'sourcesUnreachable' && state.kind !== 'readFailed' ? null : (
              // The line and its one press stay on one baseline; Details opens beneath the line, on its left edge.
              <Stack gap="xsmall" align="flex-start">
                <Status tone="warning" label={readTriageListReadFailureNotice(state, text).title}
                  value={readTriageListReadFailureNotice(state, text).description}
                  action={state.retryable ? (
                    <TriageFailureLineAction label={retryLabel}
                      busy={refreshState.kind === 'running'} disabled={refreshState.kind === 'blocked'} onPress={refreshPage} />
                    ) : <TriageFailureLineAction label={text('plugins.triage.surface.sources.manage', 'Manage sources')}
                      onPress={() => setEditingSources(true)} />}
                />
                <PullRequestFailureDetails
                  codes={[window.snapshot.error?.code, ...(window.snapshot.error?.diagnostics ?? [])]}
                  requestId={window.snapshot.error?.requestId}
                />
              </Stack>
          )}

          {/*
            The configured actions, edited where they are pressed.
            `triage.actions` is an Account KV catalog because the declarative
            Settings form is not a repeatable record editor. This is the only
            writer of that catalog on this page.
          */}
          {editingActions ? (
            <TriageActionsEditor
              // Remounts per request, so a second "Edit action…" opens that action rather than keeping the first.
              key={editingActions.actionId ?? ''}
              actions={configuredActions}
              {...(editingActions.actionId === undefined ? {} : { initialActionId: editingActions.actionId })}
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
                  size="small"
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
                  title={configuredSources.notice.kind === 'refused'
                    ? configuredSources.notice.message
                    : text(
                      'plugins.triage.surface.sources.changedTitle',
                      'Configured sources changed',
                    )}
                  description={configuredSources.notice.kind === 'refused' ? undefined : configuredSources.notice.message}
                />
              )}
              {configuredSources.sources.length === 0 ? (
                <Status
                  tone="muted"
                  label={text('plugins.triage.surface.sources.none', 'No configured sources')}
                />
              ) : (
                <ItemGroup accessibilityLabel={text('plugins.triage.surface.sources.title', 'Configured sources')}>
                  {configuredSources.sources.map((source) => {
                    // A bare account name ("leeroybrun") does not say what it is: the source's own name does.
                    const sourceName = resolveTriageSourceDescriptorV1(surfaceContext.targetedContributions,
                      source.configured.instance.source)?.displayName;
                    const subtitle = source.displayPath ?? sourceName;
                    // Each connection says its own health on its row: a quiet word and its reason, its fix at the end.
                    const failure = listWindow?.failure?.sources.find((entry) => entry.sourceInstanceId === source.sourceInstanceId);
                    const health = failure === undefined ? null : readTriageSourceFailureRowV1(failure, text);
                    const repair = health?.fix === 'connection'
                      ? configureOffers.find((offer) => offer.destination.pluginId === source.configured.instance.source.pluginId)
                      : undefined;
                    const fixLabel = health?.fix === 'retry' ? retryLabel
                      : repair === undefined ? null : text('plugins.triage.surface.sources.fix', 'Fix');
                    const detailsOpen = openSourceDetails === source.sourceInstanceId && health?.details != null;
                    return (
                      <Item
                        key={source.sourceInstanceId}
                        title={source.displayLabel}
                        icon={<TriageSourceMark source={source.configured.instance.source} />}
                        {...(subtitle === undefined ? {} : { subtitle })}
                        {...(health === null ? {} : {
                          detail: `${text('plugins.triage.surface.sources.notRead', 'Not read')} · ${health.reason}`,
                          detailTone: 'warning' as const,
                        })}
                        {...(fixLabel === null ? {} : { accessory: (
                          <TriageFailureLineAction label={fixLabel} accessibilityLabel={`${fixLabel} ${source.displayLabel}`}
                            busy={health?.fix === 'retry' && refreshState.kind === 'running'}
                            disabled={health?.fix === 'retry' && refreshState.kind === 'blocked'}
                            onPress={repair === undefined ? refreshPage : () => openConfigureSource(repair)} />
                        ) })}
                        {...(detailsOpen ? { expanded: true, expandedContent: (
                          <Text variant="micro" tone="secondary" value={health!.details!} />
                        ) } : {})}
                        // Removing is the row's only operation and it is destructive, so it waits in the row's menu
                        // (as on a source's own settings page) instead of standing as a column of Remove buttons.
                        secondaryActions={[...(health?.details == null ? [] : [{
                          id: 'details',
                          label: detailsOpen
                            ? text('plugins.triage.surface.sources.hideDetails', 'Hide details')
                            : text('plugins.triage.surface.detail.tab.details', 'Details'),
                        }]), ...(source.removable === false ? [] : [{
                          id: 'remove',
                          label: text('plugins.triage.surface.sources.remove', 'Remove'),
                          destructive: true,
                          disabled: configuredSources.unavailableReason !== null
                            || configuredSources.busySourceInstanceId !== null,
                        }])]}
                        secondaryActionAccessibilityLabel={text('plugins.triage.surface.row.moreActions',
                          'More actions for {title}', { title: source.displayLabel })}
                        onSecondaryAction={(id) => {
                          if (id === 'details') {
                            setOpenSourceDetails(detailsOpen ? null : source.sourceInstanceId);
                            return;
                          }
                          void removeConfiguredSource(source.sourceInstanceId);
                        }}
                      />
                    );
                  })}
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
            Only beside rows. With none, the empty slot below takes this same
            line in the list's place, and a second one here would say it twice.

            The notice names the connection, not "a source": `REQ-01` asks for
            per-source health, and a reader with several connections configured
            cannot act on health that will not say whose it is.
          */}
          {/* Rows are still listed, so one unread connection is a status line with its fix beside it, not a card that
              leads every page: the name and why, then its recovery (lab c7: the page's name and rows lead). */}
          {rowCount === 0 || emptyBelowPins?.kind === 'sourceFailure' ? null : listFailureStatus}

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
          {...((state.kind === 'configureSources' || empty?.kind === 'taskFirstRun') && rowCount === 0 && surface.search.query === ''
            ? {}
            : {
                search: {
                  label: taskAudience === undefined
                    ? text('plugins.triage.surface.search', 'Search PRs & Issues')
                    : text('plugins.triage.tasks.search', 'Search tasks'),
                  value: surface.search.query,
                  onValueChange: changeSearch,
                  onComposingValueChange: changeComposingSearch,
                  tokens: searchTokens,
                },
              })}
          footer={(
            <TriageBulkActionBar
              actions={configuredActions.actions}
              selectedWorkflowSubjects={selectedBulkWorkflowSubjects}
              destinationUnavailableReason={readBulkDestinationUnavailableReason}
              phase={bulkSessions.phase}
              selectedActionId={bulkActionId}
              onRun={runBulkAction}
              retryable={bulkSessions.retryable}
              onRetry={bulkSessions.retry}
              onCancel={bulkSessions.cancel}
              onDismiss={dismissBulkSelection}
            />
          )}
          // Nothing about the reader could be read. The page stays the page: the same one header (its name, search,
          // lens, Refresh and Run on) leads, and the failure is said in words in the list's own place. The host's code
          // is a diagnostic behind Details, and a retry is offered only when the host says one can succeed.
          {...(emptyBelowPins === null ? {} : { afterRows: (
            emptyBelowPins.kind === 'sourceFailure' && (listFailureStatus !== null || hostSpeaksForOutage) ? listFailureStatus : <EmptyState
              title={text(readTriageListEmptyStateKeys(emptyBelowPins.kind).title, emptyBelowPins.title)}
              description={text(readTriageListEmptyStateKeys(emptyBelowPins.kind).description, emptyBelowPins.description)}
              {...emptyNextControls}
            />
          ) })}
          empty={state.kind === 'unavailable' ? (
            <ErrorState
              titleKey="plugins.triage.surface.listFailed"
              title="The list could not be read"
              {...(state.retryable
                ? {
                    descriptionKey: 'plugins.triage.surface.listFailed.retryable',
                    description: 'Happier could not reach your sources or your saved views just now. Try again in a moment.',
                    action: (
                      <Button
                        title={retryLabel}
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
          ) : empty === null ? null : empty.kind === 'taskFirstRun' ? (
            <TriageTasksFirstRun offers={taskTrackerOffers} onConnect={(offer) => { void openConfigureSource(offer); }}
              onNewTask={startNewTask} />
          ) : empty.kind === 'sourceFailure' && (listFailureStatus !== null || hostSpeaksForOutage) ? (
            /*
              No rows to sit beside, so the list's own place takes the same one line the rows would carry: who could
              not be read, what that means for the list, and its one recovery (`readTriageListFailureLine`). The
              header's Refresh stays the page's refresh; each connection's code waits in Manage sources.
            */
            listFailureStatus
          ) : (
            <EmptyState
              scene={readTriageListEmptyScene(empty.kind)}
              title={text(readTriageListEmptyStateKeys(empty.kind).title, empty.title)}
              description={text(readTriageListEmptyStateKeys(empty.kind).description, empty.description)}
              {...emptyNextControls}
            />
          )}
        />
      </TriageListRowEnvironmentContext.Provider>
      </TriageHeaderPublicationContext.Provider>
      </TriageEntryPublicationContext.Provider>
      </Stack>
    </Screen>
  );
}


/**
 * Clear a page-local selected id that the saved catalog no longer answers to.
 * A deleted or cross-Account id clears without an Account write. The valid
 * route facets, order and policy survive; restoration belongs to the host's
 * device-local page location, not this Account catalog reader.
 *
 * A set this build cannot read clears nothing. "I cannot parse this" is not
 * "your view is gone", and acting on the second would drop a live selection on
 * the say-so of a value written by a newer client.
 */
function useTriageSavedViewBinding(input: Readonly<{
  saved: CorpusSavedViewsReadV1 | null;
  selectedViewId: string | null;
  applyLensEdit: (action: TriageSurfaceActionV1, refusal: 'selection' | 'lens') => void;
}>): void {
  const {
    applyLensEdit,
    saved,
    selectedViewId,
  } = input;
  React.useEffect(() => {
    // `null` is "not read yet", which is neither an empty set nor an unknown
    // view: clearing on it would drop a location-carried selection every time.
    if (saved === null) return;

    if (selectedViewId === null || saved.kind === 'unreadable') return;
    if (saved.value.views.some((view) => view.viewId === selectedViewId)) return;
    applyLensEdit({ kind: 'savedViewSelectionCleared' }, 'lens');
  }, [
    applyLensEdit,
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
 * The queue's mount effect publishes the opening route and its view. Subsequent
 * writes wait for a lens change. The initial publication retains the route's
 * entry rather than the reducer's selection, which needs the qualified instance
 * only the window can supply.
 */
function useTriageRouteBinding(input: Readonly<{
  queue: TriageRouteWriteQueueV1;
  surface: TriageSurfaceStateV1;
  readerChangedLens: React.RefObject<boolean>;
  settledRoute: React.RefObject<TriageSettledRouteV1>;
  latestRouteIntent: React.RefObject<TriageSettledRouteV1>;
  rowsByKeyRef: React.RefObject<TriageRouteRowIndexV1>;
  dispatch: React.Dispatch<TriageSurfaceActionV1>;
  onFailure: (failure: 'unavailable' | 'rejected' | null) => void;
}>): void {
  const {
    dispatch,
    latestRouteIntent,
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
    // A host move can publish an entry before its connection is qualified.
    // That intermediate reducer state is not a local navigation intent: writing
    // its empty selection would replace the very route we are adopting.
    if (requestedSubPath !== latestRouteIntent.current.subPath) return undefined;
    if (requestedSubPath === settledRoute.current.subPath) {
      settledRoute.current = { subPath: requestedSubPath, state: surface };
      return undefined;
    }
    queue.write(requested, (settlement) => {
      const previous = settledRoute.current;
      const superseded = settlement.superseded
        || requestedSubPath !== latestRouteIntent.current.subPath;
      const result = settlement.result;
      if (result === null) return;
      if (result.kind === 'settled') {
        // A newer host navigation already settled the current reader intent.
        // Its rollback base outranks this earlier write's delayed ack too.
        if (superseded && latestRouteIntent.current.subPath === previous.subPath) return;
        const subPath = canonicalTriageSubPathV1(result.subPath);
        if (subPath === requestedSubPath) {
          // The optimistic state already is the host's exact answer. Recording
          // it as settled is sufficient; dispatching a whole-state clone here
          // would restart entry-scoped reads for no visible location change.
          settledRoute.current = { subPath, state: surface };
          if (!superseded) {
            latestRouteIntent.current = settledRoute.current;
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
        latestRouteIntent.current = settledRoute.current;
        onFailure(null);
        dispatch({ kind: 'settledRouteApplied', state });
        return;
      }
      if (superseded) return;
      latestRouteIntent.current = previous;
      onFailure(result.reason === 'unavailable' ? 'unavailable' : 'rejected');
      dispatch({ kind: 'settledRouteApplied', state: previous.state });
    });
    return undefined;
  }, [
    dispatch,
    filters,
    latestRouteIntent,
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
  const completedSinceMs = lens.tasks?.completedSinceMs;

  // Called before the page-view demand and after the window subscription.
  // Binding a cold window is not itself a materialization producer.
  React.useEffect(() => {
    setLens({ filters, limit, order, query, smartPolicy,
      ...(completedSinceMs === undefined ? {} : { tasks: { completedSinceMs } }) });
  }, [completedSinceMs, filters, limit, order, query, setLens, smartPolicy]);
}

/** A connection that could not be read while others still list rows: its name and why, and the fix beside them. */
