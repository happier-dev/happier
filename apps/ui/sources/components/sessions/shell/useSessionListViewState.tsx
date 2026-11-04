import {
    normalizeSessionAddress,
    sessionAddressKey as audienceSessionAddressKey,
    type SessionAddress,
} from '@/sync/domains/session/sessionAddress';
import * as React from 'react';
import { useSessionMruOrder } from '@/sync/domains/session/navigation/recentSessions';
import { normalizeSessionListActiveColorMode } from './row/sessionRowTitleColorRole';
import { buildSessionListCollapseContextKey, buildSessionListCollapseKey, readSessionListCollapsedGroups } from '@/sync/domains/session/listing/sessionListCollapseState';
import { collapsedGroupsState, useCollapsedGroupKeys } from '@/sync/domains/state/disclosureUiState';
import { Platform, useWindowDimensions, type ViewToken } from 'react-native';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1 } from '@happier-dev/protocol/sessions/external/statusDemandV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveWorkflowRunParentSessionId } from '@/sync/domains/session/listing/nestSessionListReports';
import { useWorkspaceRefs, useSetting, useSettingMutable, useProfile, useLocalSetting, useSessionListRowRenderablesForItems, useSessionOrganizationProjections } from '@/sync/domains/state/storage';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readProjectAccountWorkspaceRefs, useProjectAccountRows } from '@/sync/domains/workspaces/projectAccountRows';
import { useIsTablet } from '@/utils/platform/responsive';
import { useSessionListSelectionState } from '@/hooks/session/useSessionListSelectionState';
import { getAllKnownTags, getTagsForSession } from './sessionTagUtils';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { resolveSessionListShellFlags } from './resolveSessionListShellFlags';
import { resolveSessionListDensityViewState } from './resolveSessionListDensityViewState';
import { resolveSessionListOrderingPersistenceState } from './resolveSessionListOrderingPersistenceState';
import { SessionListHeaderItem } from './sessionListHeaderItem';
import { SESSION_LIST_SUPPORTING_SECTIONS_NODE } from './sessionListVirtualizedNodes';
import { SessionListRowViewModelBoundary } from './SessionListRowViewModelBoundary';
import { selectSessionListRowContextInput } from './sessionListRowViewModels';
import { resolveSessionSectionDraftAnchor, useSessionSectionDraft, type SessionSectionDraftController } from '@/components/sessions/organization/useSessionSectionDraft';
import { normalizeSessionListIdentityDisplay } from './SessionListIdentity';
import { SessionItem } from './SessionItem';
import type { WorkflowRunItemProps } from './row/WorkflowRunItemBody';
import { useSessionListRowViewport, useSessionListRowViewportFact, type SessionListRowViewport } from './sessionListRowViewport';
import { resolveSessionListRowViewModelAdjacency, resolveSessionListUnscopedSelectionIsUnique } from './sessionListRowViewModels';
import { useSessionListRenderModels } from './useSessionListRenderModels';
import { useSessionListSearchTextByKey } from './useSessionListSearchTextByKey';
import { useSessionListNavigationActions } from './useSessionListNavigationActions';
import { useSessionListRowInteractions } from './useSessionListRowInteractions';
import {
    SessionListAttentionInteractionContext,
    useSessionListAttentionInteractionHeld,
    useSessionListAttentionInteractionOwner,
    type SessionListAttentionInteraction,
} from './useSessionListAttentionInteraction';
import { readSessionListDestinationIntent } from './useSessionListEntityDragDrop';
import { readSessionListFolderAssignmentDestination } from './drag/resolveSessionListEntityDrop';
import { buildSessionSectionMoveMenuItems, readSessionSectionMoveMenuChoice, type SessionSectionMoveChoice } from '@/components/sessions/organization/sessionSectionMoveMenu';
import { buildSessionSpaceMembershipMenu, type SessionSpaceMembershipMenuChoice } from '@/components/sessions/organization/sessionSpaceMembershipMenu';
import { useSessionListOrganizationWriters } from './useSessionListOrganizationWriters';
import { useSessionListRowMoveActionHandlers } from './useSessionListRowMoveActionHandlers';
import { useSessionListWorkspaceHeaderActions } from './useSessionListWorkspaceHeaderActions';
import { useSessionListWorkspaceLabelMigration } from './useSessionListWorkspaceLabelMigration';
import { useFrozenSessionListItemsDuringDrag } from './drag/useFrozenSessionListItemsDuringDrag';
import {
    normalizeSessionListSurfaceOwnership,
    type SessionListSurfaceOwnership,
} from './surface/sessionListSurfaceOwnership';
import { useVisibleSessionListPaneState, type VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import { useSessionListLayoutChoice } from '@/hooks/session/sessionListLayoutIntent';
import {
    areSessionListIndexItemsEqual,
    buildSessionListIndexEntityId,
    buildSessionListIndexNodeId,
    resolveSessionListItemOrganizationEligibility,
    type SessionListContextualSearchReason,
    type SessionListIndexItem,
} from '@/sync/domains/sessionList/sessionListIndex';
import { normalizeSessionListShellState } from './normalizeSessionListShellState';
import { resolveSelectedSessionIdForList } from '@/sync/domains/session/listing/resolveSelectedSessionIdForList';
import { useSessionCanvasSelection } from './view/useSessionCanvasSelection';
import { useSessionListA11yAnnouncements } from './accessibility/useSessionListA11yAnnouncements';

import { useSessionListMoveSheet } from './move-sheet/useSessionListMoveSheet';
import {
    buildServerScopedSessionKey,
    buildVisibleSessionNavigationEntries,
    findVisibleSessionNavigationEntryByScope,
    moveSessionMruEntryToFront,
    resolveVisibleSessionEdgeNavigation,
    resolveSessionMruNavigation,
    resolveVisibleSessionNavigation,
    type VisibleSessionNavigationEntry,
} from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { useSessionNavigationCursorPublisher } from '@/sync/domains/session/navigation/useSessionNavigationCursorPublisher';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import {
    useFocusedSessionAddress,
    useSessionSurfaceVisibilitySnapshot,
    getSessionSurfaceVisibilityResetVersion,
    subscribeSessionSurfaceVisibilityReset,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { TranslationKey } from '@/text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type { TreeDropMeasurableRef } from '@/components/ui/treeDragDrop';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    resolveSessionListLayoutApplicability,
    resolveSessionListSessionRowDragPolicy,
} from '@/sync/domains/session/listing/sessionListLayout';
import {
    replaceExternalSessionStatusDemandViewport,
} from '@/sync/runtime/orchestration/externalSessions/externalSessionStatusDemandCoordinator';
import {
    collectExternalSessionStatusDemandViewportEntries,
} from '@/sync/runtime/orchestration/externalSessions/collectExternalSessionStatusDemandViewportEntries';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    archiveSessionSection,
    requireSessionOrganizationMutationScope,
    writeSessionOrganizationFolderAssignment,
    writeSessionOrganizationTagLabels,
    writeSessionSectionDefinition,
    type SessionOrganizationMutationScope,
} from '@/sync/ops/sessionOrganization';
import { randomUUID } from '@/platform/randomUUID';
import { resolveSessionSectionArchiveOutcome } from '@/components/sessions/organization/sessionSectionArchiveOutcome';
import { writeNewSessionDraftToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { buildNewSessionConfigurationDraft } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { buildSessionSectionGroupKey } from '@/sync/domains/session/organization/sections';
import { buildSessionOrganizationServerKey } from '@/sync/domains/session/organization/keys';
import { sessionOrganizationActions } from '@/sync/ops/sessionOrganization/sessionOrganizationActions';
import {
    sessionSetManualReadStateWithServerScope,
} from '@/sync/ops';
import { executeSessionLifecycleAction } from '../actions/sessionActionExecution';
import {
    stopSessionAndMaybeArchive,
} from '../sessionStopArchiveFlow';
import {
    selectAvailableSessionFolders,
    type SessionFolderWorkspaceRefV1,
    type SessionFoldersV1,
} from '@/sync/domains/session/folders';
import { openSessionFolderSelection } from '@/components/sessions/organization/SessionFolderSelection';
import {
    buildSessionOrganizationListViewStateForServers,
    completeSessionOrganizationOrderItemAddresses,
} from '@/sync/domains/session/organization/viewState';
import type { SessionSection } from '@/sync/domains/session/organization/sections';
import { readSessionListProjectDisplay, type ProjectGroupDisplay } from '@/sync/domains/workspaces/projectGroupDisplay';
import { resolveSessionListOrganizationServerIds } from '@/sync/domains/session/organization/sessionListOrganizationServerIds';
import {
    resolveSessionAttentionStanding,
    type SessionAttentionStandingPolicy,
} from '@/sync/domains/session/organization/attentionStanding';
import { useSessionAttentionStandingInputs } from '@/hooks/session/useSessionAttentionStandingInputs';
import { sessionSetAttentionStandingWithServerScope } from '@/sync/ops/sessionOrganization';
import { resolveWorkspaceRootTreeRowId, treeRowId } from './drop-resolution/treeRowId';
import { hasActiveSessionListHeaderFilters } from './sessionListFilters';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { HappyError } from '@/utils/errors/errors';
import {
    useActiveServerAccountScope,
    useOrdinarySessionListMembershipByServerId,
    useSessionListHomeObservations,
    useSessionListRowsByServerId,
} from '@/sync/store/hooks';
import { readSessionListRowForServerId, readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import {
    readSessionListSearchCorpusSessionIdsForHome,
    resolveSessionListSearchCorpus,
    reuseSessionListSearchCorpus,
    type SessionListSearchCorpus,
} from './search/sessionListSearchCorpus';
import {
    SESSION_LIST_MEMORY_SEARCH_MIN_QUERY_LENGTH,
    useSessionListMemorySearchAugmentationForContext,
    useSessionListMemorySearchContext,
    type SessionListMemorySearchTarget,
} from './search/useSessionListMemorySearchAugmentation';
import {
    useSessionListViewFilterController,
    type SessionListCorpusStorage,
    type SessionListViewFilterController,
} from './search/useSessionListViewFilterController';
import {
    resolveSessionListMetadataSearchTargets,
    type SessionListSearchOutsideMatch,
} from './search/sessionListSearchGroups';
import {
    SESSION_LIST_FILTERED_NO_RESULTS_MESSAGE_KEY,
    type SessionListVirtualizedNode,
} from './sessionListVirtualizedContent';
import {
    buildSessionListRowStorePriorityKeys,
    resolveSessionListRowStoreScopeKey,
    resolveSessionListRowStoreSubscriptionKeysForViewport,
    reuseSessionListRowStoreKeySet,
} from './row/sessionListVisibleRowStoreScopes';
import { useSessionListRuntimePriorityRowKeysForItems } from '@/sync/store/hooks';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import type {
    SessionBulkActionExecutionContext,
    SessionBulkActionTarget,
} from '@/components/sessions/actions/sessionBulkActionExecution';
import {
    buildSessionListSelectionScopeKeyForView,
    readSessionListSelectionKeysFromVisibleEntries,
    readSessionListSelectionRowsFromVisibleEntries,
} from './selection/sessionListSelectionKeys';
import {
    useSessionListSelectionController,
} from './selection/SessionListSelectionContext';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { transcriptSearchUnavailableHint } from '@/components/appShell/search/transcriptSearchUnavailableHint';
import { SessionListFilterControl } from './search/SessionListFilterControl';
import { useSessionListSpaceChrome } from './search/useSessionListSpaceChrome';
import { retainPresentedSessionHomeObservations } from '@/sync/domains/session/presentation/sessionContextPresentation';
import type {
    QualifiedTagAddress,
    SessionListViewContext,
} from './search/sessionListViewFilters';

const NATIVE_LIST_ALL_RENDERED_ROW_STORE_MAX_ITEMS = 200;
const EMPTY_MEMORY_MATCHED_SESSION_KEYS: ReadonlySet<string> = new Set();
const EMPTY_VIEWABLE_SESSION_ROW_KEYS: ReadonlySet<string> = new Set();
const EMPTY_KNOWN_TAGS: ReadonlyArray<string> = [];
const EMPTY_LOCAL_TAG_SELECTIONS: ReadonlyArray<QualifiedTagAddress> = [];
const EMPTY_MEMORY_MATCHED_SESSION_TARGETS: ReadonlyArray<SessionListMemorySearchTarget> = [];

export type RegisterSessionFolderDropTarget = (target: Readonly<{
    type: 'folder' | 'workspace-root';
    id: string;
    workspace: SessionFolderWorkspaceRefV1;
    serverId: string | null;
    bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
    folderId?: string;
}>) => () => void;

function resolveTreeRowIdForSessionItem(item: Extract<SessionListIndexItem, { type: 'session' }>): string {
    const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
    const sessionId = String(item.sessionId ?? '').trim();
    return serverId ? treeRowId.session(serverId, sessionId, item.keyParts, item.occurrenceRole) : buildSessionListIndexNodeId(item);
}

function mergeSessionListRowStoreKeySets(
    primary: ReadonlySet<string>,
    secondary: ReadonlySet<string>,
): ReadonlySet<string> {
    if (secondary.size === 0) return primary;
    if (primary.size === 0) return secondary;
    const merged = new Set(primary);
    for (const key of secondary) {
        merged.add(key);
    }
    return merged;
}

function resolveSessionTreeRowId(
    sessionKey: string | null,
    knownSessionEntries: readonly VisibleSessionNavigationEntry[],
): string | null {
    if (!sessionKey) return null;
    const entry = knownSessionEntries.find((candidate) => candidate.occurrenceKey === sessionKey)
        ?? knownSessionEntries.find((candidate) => candidate.sessionKey === sessionKey);
    return entry?.serverId ? treeRowId.session(entry.serverId, entry.sessionId, undefined, entry.occurrenceRole) : null;
}

function resolveAdjacentSessionSelectionKey(params: Readonly<{
    visibleKeys: readonly string[];
    currentKey: string | null;
    direction: 'previous' | 'next';
}>): string | null {
    if (params.visibleKeys.length === 0) return null;
    const currentIndex = params.currentKey ? params.visibleKeys.indexOf(params.currentKey) : -1;
    if (currentIndex < 0) {
        return params.direction === 'previous'
            ? params.visibleKeys[params.visibleKeys.length - 1] ?? null
            : params.visibleKeys[0] ?? null;
    }
    const targetIndex = params.direction === 'previous'
        ? Math.max(0, currentIndex - 1)
        : Math.min(params.visibleKeys.length - 1, currentIndex + 1);
    return params.visibleKeys[targetIndex] ?? null;
}

function buildSessionBulkActionTargetFromSessionItem(params: Readonly<{
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    session: SessionListRenderableSession;
    currentUserId: string | null;
    pinnedKeySet: ReadonlySet<string>;
    sessionTags: Record<string, string[]>;
    foldersFeatureEnabled: boolean;
    attentionStandingEnabled: boolean;
    attentionStandingPolicy: SessionAttentionStandingPolicy;
}>): SessionBulkActionTarget | null {
    const selectionKey = buildServerScopedSessionKey(params.item.sessionId, params.item.serverId);
    if (!selectionKey) return null;
    const serverId = typeof params.item.serverId === 'string' && params.item.serverId.trim()
        ? params.item.serverId.trim()
        : null;
    const isPinned = params.item.pinned === true || params.pinnedKeySet.has(selectionKey);
    const actionTarget = createSessionActionTarget({
        session: params.session,
        serverId,
        currentUserId: params.currentUserId,
        isPinned,
        attentionStandingEnabled: params.attentionStandingEnabled,
        attentionStanding: resolveSessionAttentionStanding(params.attentionStandingPolicy, selectionKey),
    });
    const readState = actionTarget.readStateAction.visible
        ? actionTarget.readStateAction.targetState === 'read'
            ? 'unread'
            : 'read'
        : undefined;
    const organizationEligibility = resolveSessionListItemOrganizationEligibility(params.item, {
        foldersFeatureEnabled: params.foldersFeatureEnabled,
    });

    return {
        key: selectionKey,
        sessionId: params.session.id,
        serverId,
        active: actionTarget.isActive,
        archived: actionTarget.isArchived,
        pinned: actionTarget.isPinned,
        canUnarchive: actionTarget.canUnarchive,
        canStop: actionTarget.canStop,
        canArchive: actionTarget.canArchive,
        canMoveToFolder: organizationEligibility.canUseSessionFolders,
        workspace: params.item.workspace ?? null,
        tags: getTagsForSession(params.sessionTags, selectionKey),
        readState,
        // Left undefined when the action is unreachable for this session (band off, archived,
        // view-only) so the selection bar offers neither direction rather than inventing one.
        standing: actionTarget.attentionStandingAction.visible
            ? actionTarget.attentionStandingAction.targetStanding === false
            : undefined,
    };
}

function buildStringListSignature(values: ReadonlyArray<string> | null | undefined): string {
    if (!values || values.length === 0) return '';
    return JSON.stringify(values);
}

function buildStringRecordSignature(value: Readonly<Record<string, string>> | null | undefined): string {
    if (!value) return '';
    const entries = Object.entries(value);
    if (entries.length === 0) return '';
    return JSON.stringify(entries.sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * Content signature for the attention standing policy. The org view state mints a
 * fresh overrides record on every projection build, so the raw policy object would
 * invalidate every virtualized row on unrelated organization traffic; the rows are
 * only allowed to re-render when the standing CONTENT actually changed.
 */
function buildAttentionStandingSignature(policy: SessionAttentionStandingPolicy): string {
    const defaultPart = policy.defaultStanding ? '1' : '0';
    const overrides = Object.entries(policy.overridesBySessionKey);
    if (overrides.length === 0) return defaultPart;
    return JSON.stringify([
        defaultPart,
        ...overrides.sort(([left], [right]) => left.localeCompare(right)),
    ]);
}

function buildStringArrayRecordSignature(value: Readonly<Record<string, readonly string[]>> | null | undefined): string {
    if (!value) return '';
    const entries = Object.entries(value);
    if (entries.length === 0) return '';
    return JSON.stringify(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function buildSessionFolderWorkspaceSignature(workspace: SessionFolderWorkspaceRefV1): string {
    if (workspace.t === 'managedSessions') {
        return JSON.stringify([workspace.t, workspace.serverId, workspace.machineId]);
    }
    if (workspace.t === 'workspaceScope') {
        return JSON.stringify([
            workspace.t,
            workspace.serverId ?? '',
            workspace.machineId ?? '',
            workspace.rootPath,
        ]);
    }
    return JSON.stringify([
        workspace.t,
        workspace.serverId ?? '',
        workspace.workspaceRefId,
    ]);
}

function buildSessionFoldersSignature(value: SessionFoldersV1): string {
    if (value.folders.length === 0) return '';
    return JSON.stringify(value.folders.map((folder) => [
            folder.id,
            folder.name,
            folder.parentId ?? '',
            folder.renderWorkspaceKey ?? '',
            buildSessionFolderWorkspaceSignature(folder.workspace),
            folder.sortKey ?? '',
        ]));
}

/** A stable empty Home selection: not searching follows no Home's rows. */
const NO_SEARCH_ROW_SERVER_IDS: readonly string[] = Object.freeze([]);

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

function stringSetsEqual(left: ReadonlySet<string> | null, right: ReadonlySet<string>): boolean {
    if (left === right) return true;
    if (left === null || left.size !== right.size) return false;
    for (const value of right) {
        if (!left.has(value)) return false;
    }
    return true;
}

function buildSessionListRowStoreSubscriptionTelemetryFields(params: Readonly<{
    dataActive: boolean;
    platformOS: string;
    priorityRowKeys: ReadonlySet<string>;
    rowSubscriptionKeys: ReadonlySet<string> | null;
    totalRows: number;
    visibleRowKeys: ReadonlySet<string> | null;
}>): Record<string, number> {
    const allRenderedRowsSubscribed = params.rowSubscriptionKeys === null;
    return {
        allRenderedRowsSubscribed: allRenderedRowsSubscribed ? 1 : 0,
        dataActive: params.dataActive ? 1 : 0,
        nativeAllRenderedRowsSubscribed: allRenderedRowsSubscribed && params.platformOS !== 'web' ? 1 : 0,
        priorityRows: params.priorityRowKeys.size,
        subscribedRows: allRenderedRowsSubscribed ? params.totalRows : params.rowSubscriptionKeys.size,
        totalRows: params.totalRows,
        visibleRows: params.visibleRowKeys?.size ?? 0,
    };
}

function useStableSessionListRowStoreKeySet<T extends ReadonlySet<string>>(value: T): T {
    const previousRef = React.useRef<T | null>(null);
    const stableValue = reuseSessionListRowStoreKeySet(previousRef.current, value);
    previousRef.current = stableValue;
    return stableValue;
}

function useStableSessionListSearchCorpus(value: SessionListSearchCorpus): SessionListSearchCorpus {
    const previousRef = React.useRef<SessionListSearchCorpus | null>(null);
    const stableValue = reuseSessionListSearchCorpus(previousRef.current, value);
    previousRef.current = stableValue;
    return stableValue;
}

function useStableNullableSessionListRowStoreKeySet<T extends ReadonlySet<string>>(
    value: T | null,
): T | null {
    const previousRef = React.useRef<T | null>(null);
    if (value === null) {
        return null;
    }
    const stableValue = reuseSessionListRowStoreKeySet(previousRef.current, value);
    previousRef.current = stableValue;
    return stableValue;
}

function areVirtualizedNodeArraysReferenceEqual(
    left: ReadonlyArray<SessionListVirtualizedNode>,
    right: ReadonlyArray<SessionListVirtualizedNode>,
): boolean {
    if (left.length !== right.length) return false;
    return left.every((node, index) => node === right[index]);
}

export type SessionListViewStateOptions = Readonly<{
    collapseContextKey?: string;
    pathname?: string;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
    corpusStorage?: SessionListCorpusStorage;
    viewContext?: SessionListViewContext;
    attentionInteraction?: SessionListAttentionInteraction;
}>;

export function useSessionListViewState(
    storageKind: SessionListStorageFilter,
    options: SessionListViewStateOptions = {},
) {
    const attentionInteraction = useSessionListAttentionInteractionOwner();
    const attentionInteractionHeld = useSessionListAttentionInteractionHeld(attentionInteraction);
    const surfaceOwnership = normalizeSessionListSurfaceOwnership(options.surfaceOwnership);
    const filterController = useSessionListViewFilterController(
        options.corpusStorage ?? 'active',
        options.viewContext,
    );
    const layout = useSessionListLayoutChoice();
    const collapseContextKey = options.collapseContextKey ?? buildSessionListCollapseContextKey(filterController, layout);
    const effectiveStorageKind = filterController.sourceAvailable ? filterController.displayFilters.source : 'persisted';
    const sessionListPaneState = useVisibleSessionListPaneState(effectiveStorageKind, {
        collapseContextKey,
        pathname: options.pathname,
        sessionListSurfaceDataActive: surfaceOwnership.dataActive,
        attentionInteractionHeld: surfaceOwnership.interactive && attentionInteractionHeld,
        queryHomes: filterController.pagingHomes,
        emptyQuerySelectionComplete: filterController.emptyQuerySelectionComplete,
        corpusStorage: options.corpusStorage ?? 'active',
        workFilter: filterController.displayFilters,
        spaceMembership: filterController.spaceMembership,
        filterControlsRequired: filterController.filterControlsRequired,
        includeNeedsYouEverywhere: filterController.includeNeedsYouEverywhere,
        fixedTeam: filterController.viewContext.kind === 'team' ? filterController.viewContext.team : undefined,
    });
    return useSessionListViewStateFromPaneState(effectiveStorageKind, sessionListPaneState, filterController, {
        ...options,
        collapseContextKey,
        surfaceOwnership,
        attentionInteraction,
    });
}

export function useSessionListViewStateFromPaneState(
    storageKind: SessionListStorageFilter,
    sessionListPaneState: VisibleSessionListPaneState,
    filterController: SessionListViewFilterController,
    options: SessionListViewStateOptions = {},
) {
    const mountedAttentionInteraction = React.useContext(SessionListAttentionInteractionContext);
    const attentionInteraction = options.attentionInteraction ?? mountedAttentionInteraction;
    const pathname = usePathname();
    const effectivePathname = options.pathname ?? pathname;
    const surfaceOwnership = normalizeSessionListSurfaceOwnership(options.surfaceOwnership);
    React.useEffect(() => {
        attentionInteraction?.releaseKeyboard();
    }, [attentionInteraction, effectivePathname, pathname]);
    React.useEffect(() => () => attentionInteraction?.reset(), [attentionInteraction]);
    React.useEffect(() => {
        if (!surfaceOwnership.interactive) attentionInteraction?.reset();
    }, [attentionInteraction, surfaceOwnership.interactive]);
    const selection = useSessionListSelectionState();
    const activeOrganizationServerId = typeof selection.activeServerId === 'string'
        ? selection.activeServerId.trim()
        : '';
    // Same scope identity the pane retention keys by, so a published order and the pane
    // it was captured from can never describe different server/selection scopes.
    const sessionNavigationSourceScopeKey = filterController.retentionScopeKey;
    const transcriptSearchServerId = filterController.viewContext.kind === 'team'
        ? filterController.viewContext.team.serverId
        : activeOrganizationServerId;
    // Team surfaces are already qualified to one Home and must not borrow the
    // globally focused Home for transcript search. Global surfaces deliberately
    // retain the selected Home's incumbent contextual-provider semantics.
    const searchQuery = filterController.filters.searchQuery;
    const memorySearchContext = useSessionListMemorySearchContext(
        { serverId: transcriptSearchServerId },
        { searchQuery, enabled: surfaceOwnership.dataActive },
    );
    const renderPaneState = sessionListPaneState;
    const setSearchQuery = filterController.setSearchQuery;
    const isTablet = useIsTablet();
    const { width: windowWidth } = useWindowDimensions();
    const sessionListLayoutChoice = useSessionListLayoutChoice();
    const sessionFolderViewModeV1 = 'tree' as const;
    const sessionTagsEnabled = useSetting('sessionTagsEnabled');
    const workspaceRefsV1 = useWorkspaceRefs();
    const projectOrganizations = useProjectAccountRows(rows => rows
        && readProjectAccountWorkspaceRefs({ projectAccountRows: rows }) !== undefined ? rows.organizations : undefined,
    surfaceOwnership.dataActive);
    const workspacePathDisplayModeV1 = 'name' as const;
    const workspaceFaviconsEnabled = useSetting('workspaceFaviconsEnabled') !== false;
    const workspaceMachineSubtitlesEnabled = useSetting('workspaceMachineSubtitlesEnabled') !== false;
    const collapseContextKey = options.collapseContextKey ?? buildSessionListCollapseContextKey(filterController, sessionListLayoutChoice);
    const storedCollapsedGroupKeysV1 = useCollapsedGroupKeys(buildSessionListCollapseKey(collapseContextKey, ''));
    const collapsedGroupKeysV1 = React.useMemo(() => readSessionListCollapsedGroups(storedCollapsedGroupKeysV1, collapseContextKey),
        [collapseContextKey, storedCollapsedGroupKeysV1]);
    const handleSetReportsCollapsed = React.useCallback((nodeId: string, collapsed: boolean) => {
        collapsedGroupsState.set(buildSessionListCollapseKey(collapseContextKey, nodeId), collapsed);
    }, [collapseContextKey]);
    const toggleCollapsedGroup = React.useCallback((groupKey: string) => {
        const key = buildSessionListCollapseKey(collapseContextKey, groupKey);
        collapsedGroupsState.set(key, !collapsedGroupsState.read(key));
    }, [collapseContextKey]);
    const sessionMruOrder = useSessionMruOrder();
    const folderFeatureEnabledServerIds = renderPaneState.folderFeatureEnabledServerIds ?? EMPTY_KNOWN_TAGS;
    const folderFeatureEnabledServerIdSet = React.useMemo(
        () => new Set(folderFeatureEnabledServerIds),
        [folderFeatureEnabledServerIds],
    );
    const isFolderActionsEnabledForServerId = React.useCallback((serverId: string | null | undefined) => (
        Boolean(serverId && folderFeatureEnabledServerIdSet.has(serverId))
    ), [folderFeatureEnabledServerIdSet]);
    const folderActionsEnabled = folderFeatureEnabledServerIds.length > 0;
    const sessionListLayoutApplicability = resolveSessionListLayoutApplicability({
        choice: sessionListLayoutChoice,
        folderViewModeV1: sessionFolderViewModeV1,
        foldersFeatureEnabled: folderActionsEnabled,
    });
    const sessionListDensity = useSetting('sessionListDensity');
    const uiFontScale = useLocalSetting('uiFontScale');
    const sessionListIdentityDisplay = useSetting('sessionListIdentityDisplay');
    const sessionListRowContextV1 = useSetting('sessionListRowContextV1');
    const sessionListStatusWords = useSetting('sessionListStatusWords');
    const sessionListActiveColorMode = useSetting('sessionListActiveColorModeV1');
    const hideInactiveSessions = useSetting('hideInactiveSessions');
    const sessionReplayEnabled = useSetting('sessionReplayEnabled');
    const sessionReplayMaxSeedChars = useSetting('sessionReplayMaxSeedChars');
    const sessionReplayStrategy = useSetting('sessionReplayStrategy');
    const sessionReplaySummaryRunnerV1 = useSetting('sessionReplaySummaryRunnerV1');
    const sessionForkReplaySettings = React.useMemo(() => ({
        sessionReplayEnabled,
        sessionReplayMaxSeedChars,
        sessionReplayStrategy,
        sessionReplaySummaryRunnerV1,
    }), [
        sessionReplayEnabled,
        sessionReplayMaxSeedChars,
        sessionReplayStrategy,
        sessionReplaySummaryRunnerV1,
    ]);
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const forkActionContext = React.useMemo(() => ({
        settings: sessionForkReplaySettings,
        replayEnabled: sessionReplayEnabled === true,
        executionRunsEnabled: executionRunsEnabled === true,
    }), [executionRunsEnabled, sessionForkReplaySettings, sessionReplayEnabled]);
    const currentUserId = useProfile(profile => typeof profile?.id === 'string' ? profile.id : null);
    const draftScope = useActiveServerAccountScope();
    const navigateToSession = useNavigateToSession();
    const { openMoveSheet } = useSessionListMoveSheet();
    const sessionListA11y = useSessionListA11yAnnouncements();
    const densityViewState = resolveSessionListDensityViewState(sessionListDensity, {
        isTablet,
        platform: Platform.OS,
        uiFontScale,
        windowWidth,
    });
    // The exact Homes this surface can present rows for. Resolved through the one
    // organization owner both here and in the index hook, so a legacy/ordinary corpus
    // cannot show a Home's rows while their organization state is never read.
    const organizationServerIds = React.useMemo(() => resolveSessionListOrganizationServerIds({
        queryHomeServerIds: filterController.pagingHomes?.map((home) => home.serverId),
        allowedServerIds: selection.allowedServerIds,
        activeServerId: selection.activeServerId,
    }), [filterController.pagingHomes, selection.activeServerId, selection.allowedServerIds]);
    const organizationProjectionServerIds = React.useMemo(
        () => filterController.homeOptions.map((home) => home.serverId),
        [filterController.homeOptions],
    );
    const selectedOrganizationProjectionsByServerId = useSessionOrganizationProjections(
        organizationServerIds,
    );
    const organizationProjectionsByServerId = useSessionOrganizationProjections(
        organizationProjectionServerIds,
    );
    const organizationListViewState = React.useMemo(() => buildSessionOrganizationListViewStateForServers({
        serverIds: organizationServerIds,
        projectionsByServerId: selectedOrganizationProjectionsByServerId,
    }), [organizationServerIds, selectedOrganizationProjectionsByServerId]);
    // A Home that answered the strict query already applied the tag predicate
    // before pagination, so its rows are authoritative. Only the legacy
    // owner/direct adapter, whose released GET cannot express tags, filters the
    // loaded rows locally.
    const locallyFilteredTagIds = filterController.corpusPresentation === 'legacy_owner_or_direct'
        ? filterController.filters.tagIds
        : EMPTY_LOCAL_TAG_SELECTIONS;
    // One policy for the whole selection instead of a per-row settings subscription: the selection
    // bar needs the same stored standing the row's own menu reads, and the overrides record is
    // already held by the organization view state above.
    const attentionStanding = useSessionAttentionStandingInputs(
        organizationListViewState.attentionStandingOverridesBySessionKey,
    );
    const pinnedSessionKeysV1 = organizationListViewState.pinnedSessionKeysV1 as string[];
    const sessionListGroupOrderV1 = organizationListViewState.sessionListGroupOrderV1 as Record<string, string[]>;
    const sessionWorkspaceOrderV1 = organizationListViewState.sessionWorkspaceOrderV1 as Record<string, string[]>;
    const sessionTagsV1 = React.useMemo(
        () => Object.fromEntries(
            Object.entries(organizationListViewState.sessionTagsV1).map(
                ([sessionKey, tags]) => [
                    sessionKey,
                    tags.flatMap((tag) =>
                        tag.display.status === 'available'
                            ? [tag.display.value]
                            : []),
                ],
            ),
        ),
        [organizationListViewState.sessionTagsV1],
    );
    // Home-local tag ids per loaded Session. The legacy adapter filters by these
    // opaque ids rather than by the labels beside them, so renaming a tag keeps the
    // selection and two Homes' same-label tags never match each other's rows.
    const sessionTagIdsBySessionKey = React.useMemo(
        () => Object.fromEntries(
            Object.entries(organizationListViewState.sessionTagsV1).map(
                ([sessionKey, tags]) => [sessionKey, tags.map((tag) => tag.tagId)],
            ),
        ),
        [organizationListViewState.sessionTagsV1],
    );
    const workspaceLabelsV1 = React.useMemo(
        () => Object.fromEntries(
            Object.entries(organizationListViewState.workspaceLabelsV1).map(
                ([scopeKey, display]) => [
                    scopeKey,
                    display.status === 'available'
                        ? display.value
                        : t('common.unavailable'),
                ],
            ),
        ),
        [organizationListViewState.workspaceLabelsV1],
    );
    const availableWorkspaceLabelsV1 = React.useMemo(
        () => Object.fromEntries(
            Object.entries(organizationListViewState.workspaceLabelsV1)
                .flatMap(([scopeKey, display]) =>
                    display.status === 'available'
                        ? [[scopeKey, display.value] as const]
                        : []),
        ),
        [organizationListViewState.workspaceLabelsV1],
    );
    const sessionFoldersV1 = organizationListViewState.sessionFoldersV1;
    const availableSessionFoldersV1 = React.useMemo(
        () => selectAvailableSessionFolders(sessionFoldersV1),
        [sessionFoldersV1],
    );
    const orderingPersistenceState = resolveSessionListOrderingPersistenceState({
        pinnedSessionKeysV1,
        sessionListGroupOrderV1,
    });
    const currentWorkspaceOrderMap = React.useMemo(() => (
        sessionWorkspaceOrderV1 && typeof sessionWorkspaceOrderV1 === 'object' && !Array.isArray(sessionWorkspaceOrderV1)
            ? sessionWorkspaceOrderV1 as Record<string, string[]>
            : {}
    ), [sessionWorkspaceOrderV1]);
    const normalizedShellState = normalizeSessionListShellState({
        collapsedGroupKeys: collapsedGroupKeysV1,
        sessionTags: sessionTagsV1,
        workspaceLabels: workspaceLabelsV1,
        workspaceRefs: workspaceRefsV1,
    });
    const shellFlags = resolveSessionListShellFlags({
        selectedServerCount: selection.selectedServerCount,
        selectionEnabled: selection.enabled,
        selectionPresentation: selection.presentation,
        isTablet,
        sessionListLayoutChoice,
        usesProjectGrouping: sessionListLayoutApplicability.usesProjectGrouping,
        usesFolderTreePresentation: sessionListLayoutApplicability.usesFolderTreePresentation,
        hasAnySessionFolderInAccount: sessionFoldersV1.folders.length > 0,
    });
    const allKnownTags = getAllKnownTags(normalizedShellState.sessionTags);
    const getAvailableOrganizationMutationScope = React.useCallback(async (
        serverIdRaw?: string | null,
    ): Promise<SessionOrganizationMutationScope> => {
        const serverId = typeof serverIdRaw === 'string' && serverIdRaw.trim()
            ? serverIdRaw.trim()
            : activeOrganizationServerId;
        return await requireSessionOrganizationMutationScope(serverId);
    }, [activeOrganizationServerId]);
    const runOrganizationMutation = React.useCallback((mutation: () => Promise<void>) => {
        void mutation().catch((error: unknown) => {
            Modal.alert(
                t('common.error'),
                error instanceof HappyError ? error.message : t('errors.unknownError'),
            );
        });
    }, []);
    const setSessionPinForTarget = React.useCallback(async (
        target: SessionBulkActionTarget,
        pinned: boolean,
    ) => {
        const result = await sessionOrganizationActions.setPin(target.sessionId, pinned, { serverId: target.serverId ?? null });
        if (!result.ok) throw new HappyError(result.error, false, { code: result.errorCode });
    }, []);
    const setSessionTagAssignmentsForTarget = React.useCallback(async (
        target: SessionBulkActionTarget,
        tags: readonly string[],
    ) => {
        const scope = await getAvailableOrganizationMutationScope(target.serverId ?? null);
        await writeSessionOrganizationTagLabels({
            scope,
            sessionId: target.sessionId,
            tags,
        });
    }, [getAvailableOrganizationMutationScope]);
    // Structural admission for every contextual search result. The per-Home paging
    // owner's applied addresses (or the canonical ordinary membership when no paging
    // owner is mounted) decide what belongs to the current corpus; the row cache only
    // resolves an admitted address into a row.
    const ordinarySessionListMembershipByServerId = useOrdinarySessionListMembershipByServerId();
    // One exact-Home currentness fact for rows and every secondary surface. A mounted query
    // controller is the authority for the Homes it applies; the ordinary list lifecycle owns the
    // rest. Rows never time their own staleness (Lane 07.4 §2).
    const observedHomes = useSessionListHomeObservations(
        renderPaneState.query?.active === true ? renderPaneState.query.statesByServerId : undefined,
    );
    // Rows redraw on `extraData` identity, so they receive a Home's observation only when what it
    // presents changes; a current Home's success clock advances on every refetch.
    const presentedHomeObservationsRef = React.useRef(observedHomes);
    const homeObservations = React.useMemo(() => {
        presentedHomeObservationsRef.current = retainPresentedSessionHomeObservations(presentedHomeObservationsRef.current, observedHomes);
        return presentedHomeObservationsRef.current;
    }, [observedHomes]);
    const searchCorpus = useStableSessionListSearchCorpus(React.useMemo(() => resolveSessionListSearchCorpus(
        renderPaneState.query?.active === true
            ? {
                query: {
                    homes: filterController.queryHomes,
                    statesByServerId: renderPaneState.query.statesByServerId,
                },
            }
            : {
                ordinary: {
                    serverIds: filterController.homeOptions.map((home) => home.serverId),
                    membershipByServerId: ordinarySessionListMembershipByServerId,
                },
            },
    ), [
        filterController.homeOptions,
        filterController.queryHomes,
        ordinarySessionListMembershipByServerId,
        renderPaneState.query,
    ]));
    // A drag produces one merged order map for the whole selected corpus. Each Home owns
    // and persists only its own items, resolved from published addresses rather than from the
    // current viewport, so an offscreen row keeps its place and no Home is asked to store
    // another Home's Session, folder or workspace ordering.
    const orderItemAddressByItemKey = React.useMemo(() => completeSessionOrganizationOrderItemAddresses({
        orderItemAddressByItemKey: organizationListViewState.orderItemAddressByItemKey,
        memberHomes: searchCorpus.homes,
    }), [organizationListViewState.orderItemAddressByItemKey, searchCorpus]);
    const { setSessionListGroupOrderV1, setSessionWorkspaceOrderV1 } = useSessionListOrganizationWriters({
        availableSessionFoldersV1,
        orderItemAddressByItemKey,
    });
    // The transcript provider request is bound to one exact Home. Passing the admitted
    // ids lets the canonical adapter filter before limiting, and an unselected Home
    // resolves to an explicit empty eligibility rather than an unrestricted search.
    const transcriptEligibleSessionIds = React.useMemo(
        () => readSessionListSearchCorpusSessionIdsForHome(searchCorpus, memorySearchContext.serverId),
        [memorySearchContext.serverId, searchCorpus],
    );
    const memorySearch = useSessionListMemorySearchAugmentationForContext(
        {
            searchQuery,
            enabled: surfaceOwnership.dataActive,
            eligibleSessionIds: transcriptEligibleSessionIds,
        },
        memorySearchContext,
    );
    const transcriptSearchHomeLabel = React.useMemo(() => {
        const serverId = memorySearchContext.serverId.trim();
        if (!serverId) return undefined;
        const homeLabel = filterController.homeOptions.find((home) => home.serverId === serverId)?.label ?? serverId;
        return `${t('sessionsList.searchMatchTranscript')} · ${t('teams.homeLabel')} · ${homeLabel}`;
    }, [filterController.homeOptions, memorySearchContext.serverId]);
    // A hit that arrived under an earlier corpus is never promoted by identity alone:
    // accessible-by-ID is not membership, so admission is re-checked against the
    // current structural corpus every render.
    const activeMemoryMatchedSessionTargets = React.useMemo(() => {
        const query = searchQuery.trim();
        if (
            !query
            || memorySearch.lastSuccessfulQuery !== query
            || memorySearch.lastSuccessfulScopeKey !== memorySearch.activeScopeKey
        ) {
            return EMPTY_MEMORY_MATCHED_SESSION_TARGETS;
        }
        const targets = memorySearch.memoryMatchedSessionTargets;
        const admitted = targets.filter((target) => searchCorpus.sessionKeys.has(target.sessionKey));
        if (admitted.length === 0) return EMPTY_MEMORY_MATCHED_SESSION_TARGETS;
        return admitted.length === targets.length ? targets : admitted;
    }, [
        memorySearch.activeScopeKey,
        memorySearch.lastSuccessfulQuery,
        memorySearch.lastSuccessfulScopeKey,
        memorySearch.memoryMatchedSessionTargets,
        searchCorpus,
        searchQuery,
    ]);
    const activeMemoryMatchedSessionKeys = React.useMemo(() => {
        if (activeMemoryMatchedSessionTargets.length === 0) return EMPTY_MEMORY_MATCHED_SESSION_KEYS;
        return new Set(activeMemoryMatchedSessionTargets.map((target) => target.sessionKey));
    }, [activeMemoryMatchedSessionTargets]);
    const searchOrganization = React.useMemo(() => ({
        sessionTags: normalizedShellState.sessionTags,
        workspaceRefs: normalizedShellState.workspaceRefs,
        workspacePathDisplayModeV1,
    }), [
        normalizedShellState.sessionTags,
        normalizedShellState.workspaceRefs,
        workspacePathDisplayModeV1,
    ]);
    // Rows are read only to search them: follow the search corpus's Homes while a query is active, and
    // nothing otherwise, so a session row write does not re-render the list when no one is searching.
    const searchingRows = searchQuery.trim().length > 0;
    const searchRowServerIds = React.useMemo(
        () => (searchingRows ? searchCorpus.homes.map((home) => home.serverId) : NO_SEARCH_ROW_SERVER_IDS),
        [searchCorpus.homes, searchingRows],
    );
    const sessionListRowsByServerId = useSessionListRowsByServerId(searchRowServerIds);
    // Structural membership admits; the canonical row cache only resolves an admitted
    // address. Enumerating the cache itself would readmit rows that satisfied an older
    // query, another Home's corpus, or another storage/scope/audience/tag selection.
    const inventorySessionItems = React.useMemo<ReadonlyArray<Extract<SessionListIndexItem, { type: 'session' }>>>(() => {
        if (searchQuery.trim().length === 0) return [];
        const items: Array<Extract<SessionListIndexItem, { type: 'session' }>> = [];
        for (const home of searchCorpus.homes) {
            const rows = readSessionListRowsForServerId(sessionListRowsByServerId, home.serverId);
            if (!rows) continue;
            for (const sessionId of home.sessionIds) {
                const session = rows[sessionId];
                if (!session) continue;
                items.push({
                    type: 'session',
                    sessionId: session.id,
                    serverId: home.serverId,
                    archivedAt: session.archivedAt ?? null,
                });
            }
        }
        return items;
    }, [searchCorpus, searchQuery, sessionListRowsByServerId]);
    const searchItems = React.useMemo(() => inventorySessionItems.length > 0
        ? [...inventorySessionItems, ...(renderPaneState.visibleSessionListIndex ?? []).filter((item) => item.type === 'workflow_run')]
        : renderPaneState.visibleSessionListIndex ?? [], [inventorySessionItems, renderPaneState.visibleSessionListIndex]);
    const {
        searchableTextBySessionKey,
        primarySearchableTextBySessionKey,
        searchableTextByWorkflowRunKey,
    } = useSessionListSearchTextByKey(
        searchItems,
        searchQuery.trim().length > 0,
        searchOrganization,
    );
    const inventoryMetadataMatchedSessionTargets = React.useMemo<ReadonlyArray<SessionListSearchOutsideMatch>>(() => {
        if (inventorySessionItems.length === 0) return [];
        return resolveSessionListMetadataSearchTargets({
            inventoryItems: inventorySessionItems,
            filters: {
                searchQuery,
                selectedTagIds: locallyFilteredTagIds,
                sessionTagIdsBySessionKey,
                searchableTextBySessionKey,
                primarySearchableTextBySessionKey,
            },
        });
    }, [
        inventorySessionItems,
        locallyFilteredTagIds,
        primarySearchableTextBySessionKey,
        searchQuery,
        searchableTextBySessionKey,
        sessionTagIdsBySessionKey,
    ]);
    // Metadata bands lead, transcript-only matches retain provider order, and a
    // duplicate exact identity becomes one ordinary Session row with all reasons.
    const activeContextualSearchTargets = React.useMemo(() => {
        const merged = new Map<string, SessionListSearchOutsideMatch>();
        for (const target of [...inventoryMetadataMatchedSessionTargets, ...activeMemoryMatchedSessionTargets]) {
            const previous = merged.get(target.sessionKey);
            if (!previous) {
                merged.set(target.sessionKey, target);
                continue;
            }
            const reasons: SessionListContextualSearchReason[] = [
                ...new Set([...previous.reasons, ...target.reasons]),
            ];
            merged.set(target.sessionKey, {
                ...previous,
                reasons,
                sourceMachineId: previous.sourceMachineId ?? target.sourceMachineId,
            });
        }
        return [...merged.values()];
    }, [activeMemoryMatchedSessionTargets, inventoryMetadataMatchedSessionTargets]);
    // The render/materialization owner compares exact targets with the current
    // filtered view, retaining local rows and grouping every absent match after it.
    const searchOtherMatches = React.useMemo(() => {
        if (activeContextualSearchTargets.length === 0) return null;
        return {
            matches: activeContextualSearchTargets,
            inThisViewTitle: t('sessionsList.searchGroupInThisView'),
            otherMatchesTitle: t('sessionsList.searchGroupOtherMatches'),
            resolveSessionRow: (serverId: string | null, sessionId: string) => readSessionListRowForServerId(sessionListRowsByServerId, serverId, sessionId),
            resolveRunOriginSession: (serverId: string, runId: string) => {
                if (!draftScope || !areServerProfileIdentifiersEquivalent(serverId, draftScope.serverId)) return null;
                const summary = renderPaneState.workflowRunWindow?.rows.find((row) => row.id === runId)?.summary;
                return resolveWorkflowRunParentSessionId(summary);
            },
        };
    }, [activeContextualSearchTargets, draftScope, renderPaneState.workflowRunWindow?.rows, sessionListRowsByServerId]);
    const searchTrailingAccessory = React.useMemo(() => {
        const queryLength = searchQuery.trim().length;
        const transcriptLoading = memorySearch.isSearchingMemory
            && queryLength >= SESSION_LIST_MEMORY_SEARCH_MIN_QUERY_LENGTH;
        if (!transcriptLoading) return undefined;
        return (
            <ActivitySpinner
                testID="session-list-memory-search-loading-indicator"
                size={14}
            />
        );
    }, [memorySearch.isSearchingMemory, searchQuery]);
    const searchStatus = React.useMemo(() => {
        if (
            searchQuery.trim().length < SESSION_LIST_MEMORY_SEARCH_MIN_QUERY_LENGTH
            || !memorySearch.memorySearchUnavailableReason
        ) {
            return undefined;
        }
        return {
            message: transcriptSearchUnavailableHint(memorySearch.memorySearchUnavailableReason),
        };
    }, [
        memorySearch.memorySearchUnavailableReason,
        searchQuery,
    ]);
    const headerFilters = React.useMemo(() => ({
        searchQuery,
        selectedTagIds: locallyFilteredTagIds,
        sessionTagIdsBySessionKey,
        searchableTextBySessionKey,
        searchableTextByWorkflowRunKey,
        primarySearchableTextBySessionKey,
        memoryMatchedSessionKeys: activeMemoryMatchedSessionKeys,
    }), [
        activeMemoryMatchedSessionKeys,
        locallyFilteredTagIds,
        primarySearchableTextBySessionKey,
        searchQuery,
        searchableTextBySessionKey,
        searchableTextByWorkflowRunKey,
        sessionTagIdsBySessionKey,
    ]);
    const universalSearchAccountId = memorySearchContext.accountBinding?.accountId
        ?? (filterController.viewContext.kind === 'global' && draftScope?.serverId === transcriptSearchServerId
            ? draftScope.accountId
            : null);
    const universalSearchScope = React.useMemo(() => (
        universalSearchAccountId && transcriptSearchServerId
            ? {
                accountId: universalSearchAccountId,
                serverId: transcriptSearchServerId,
                sessionId: null,
                machineId: null,
                rootPath: null,
            }
            : undefined
    ), [transcriptSearchServerId, universalSearchAccountId]);
    const {
        handleOpenProject,
        handleCreateSessionFromWorkspaceScope,
        handleOpenArchivedSessions,
        handleOpenUniversalSearch,
    } = useSessionListNavigationActions(universalSearchScope);

    const selectedSession = useSessionCanvasSelection({
        selectable: shellFlags.selectable,
        pathname: effectivePathname,
    });
    const selectedSessionId = selectedSession?.sessionId ?? null;
    const selectedSessionServerId = selectedSession?.serverId ?? null;
    const sessionSurfaceVisibility = useSessionSurfaceVisibilitySnapshot();
    const focusedSessionId = sessionSurfaceVisibility.focusedSessionId;
    const focusedSessionAddress = useFocusedSessionAddress();
    const statusDemandViewportId = React.useId();
    const activeMruSessionId = React.useMemo(() => resolveSelectedSessionIdForList({
        selectable: true,
        pathname: effectivePathname,
        focusedSessionId,
    }), [effectivePathname, focusedSessionId]);
    const [viewableSessionRowKeys, setViewableSessionRowKeys] = React.useState<ReadonlySet<string> | null>(null);
    const surfaceDataActiveRef = React.useRef(surfaceOwnership.dataActive);
    surfaceDataActiveRef.current = surfaceOwnership.dataActive;
    const visibilityResetVersion = React.useSyncExternalStore(
        subscribeSessionSurfaceVisibilityReset,
        getSessionSurfaceVisibilityResetVersion,
        getSessionSurfaceVisibilityResetVersion,
    );
    const viewableSessionRowKeysRef = React.useRef<ReadonlySet<string> | null>(null);
    React.useEffect(() => {
        viewableSessionRowKeysRef.current = viewableSessionRowKeys;
    }, [viewableSessionRowKeys]);
    const indexPrioritySessionRowKeysRaw = React.useMemo(() => buildSessionListRowStorePriorityKeys(
        renderPaneState.visibleSessionListIndex ?? [],
        { selectedSessionId, selectedSessionServerId },
    ), [selectedSessionId, selectedSessionServerId, renderPaneState.visibleSessionListIndex]);
    const runtimePrioritySessionRowKeysRaw = useSessionListRuntimePriorityRowKeysForItems(
        renderPaneState.visibleSessionListIndex,
        { enabled: surfaceOwnership.dataActive },
    );
    const prioritySessionRowKeysRaw = React.useMemo(() => mergeSessionListRowStoreKeySets(
        indexPrioritySessionRowKeysRaw,
        runtimePrioritySessionRowKeysRaw,
    ), [indexPrioritySessionRowKeysRaw, runtimePrioritySessionRowKeysRaw]);
    const prioritySessionRowKeys = useStableSessionListRowStoreKeySet(prioritySessionRowKeysRaw);
    const rowSubscriptionKeysRaw = React.useMemo(() => (
        surfaceOwnership.dataActive
            ? resolveSessionListRowStoreSubscriptionKeysForViewport({
                nativeAllRenderedMaxRows: NATIVE_LIST_ALL_RENDERED_ROW_STORE_MAX_ITEMS,
                platformOS: Platform.OS,
                priorityRowKeys: prioritySessionRowKeys,
                renderedSessionRows: renderPaneState.summary.sessionCount,
                visibleRowKeys: viewableSessionRowKeys,
            })
            : EMPTY_VIEWABLE_SESSION_ROW_KEYS
    ), [prioritySessionRowKeys, renderPaneState.summary.sessionCount, surfaceOwnership.dataActive, viewableSessionRowKeys]);
    const rowSubscriptionKeys = useStableNullableSessionListRowStoreKeySet(rowSubscriptionKeysRaw);
    // Rows read their own viewport membership; neither set is a shared cell input (extraData).
    const rowViewport = useSessionListRowViewport(rowSubscriptionKeys, viewableSessionRowKeys);
    React.useEffect(() => {
        if (!syncPerformanceTelemetry.isEnabled()) return;
        syncPerformanceTelemetry.count('ui.sessionsList.rowStoreSubscriptions', buildSessionListRowStoreSubscriptionTelemetryFields({
            dataActive: surfaceOwnership.dataActive,
            platformOS: Platform.OS,
            priorityRowKeys: prioritySessionRowKeys,
            rowSubscriptionKeys,
            totalRows: renderPaneState.summary.sessionCount,
            visibleRowKeys: viewableSessionRowKeys,
        }));
    }, [
        prioritySessionRowKeys,
        renderPaneState.summary.sessionCount,
        rowSubscriptionKeys,
        surfaceOwnership.dataActive,
        viewableSessionRowKeys,
    ]);

    const renderModels = useSessionListRenderModels({
        projectOrganizations,
        paneState: renderPaneState,
        collapsedGroupKeys: normalizedShellState.collapsedGroupKeys,
        workspaceLabels: normalizedShellState.workspaceLabels,
        workspaceRefs: normalizedShellState.workspaceRefs,
        workspaceRefsServerId: activeOrganizationServerId,
        legacyWorkspaceLabelDisplayStatesByKey: organizationListViewState.labelDisplayStatesByKey,
        workspacePathDisplayModeV1,
        pinnedKeySet: orderingPersistenceState.pinnedKeySet,
        sessionTags: normalizedShellState.sessionTags,
        headerFilters,
        searchOtherMatches,
        selectedSessionId,
        selectedSessionServerId,
        showServerBadge: shellFlags.showServerBadge,
        showPinnedServerBadge: shellFlags.showPinnedServerBadge,
        attentionStandingEnabled: attentionStanding.actionEnabled,
        attentionStandingPolicy: attentionStanding.policy,
        identityDisplay: sessionListIdentityDisplay === 'agentLogo' || sessionListIdentityDisplay === 'none'
            ? sessionListIdentityDisplay
            : 'avatar',
        activeColorMode: sessionListActiveColorMode === 'attentionOnly' || sessionListActiveColorMode === 'allActive'
            ? sessionListActiveColorMode
            : 'activityAndAttention',
        hideInactiveSessions: hideInactiveSessions === true,
        rowSubscriptionKeys,
        clocksActive: surfaceOwnership.dataActive,
        rowViewModelMode: 'deferred',
    });

    const visibleSessionNavigationEntries = React.useMemo<VisibleSessionNavigationEntry[]>(
        () => buildVisibleSessionNavigationEntries(renderModels.listItems),
        [renderModels.listItems],
    );
    // Freezing the lateral-navigation order is a side effect of this surface going
    // data-inactive: on phone that happens on every `/session/*` route, so the last
    // published order is exactly the one the user was looking at when they opened a
    // session. The rows published are the ones rendered, so the order the cursor walks
    // and the order on screen cannot diverge.
    useSessionNavigationCursorPublisher({
        active: surfaceOwnership.dataActive,
        origin: 'session-list',
        sourceScopeKey: sessionNavigationSourceScopeKey,
        storageKind,
        items: renderModels.listItems,
    });
    const filteredNoResultsMessage: TranslationKey | undefined = hasActiveSessionListHeaderFilters(headerFilters) && !renderModels.listItems.some((item) => item.type !== 'header')
        ? SESSION_LIST_FILTERED_NO_RESULTS_MESSAGE_KEY
        : undefined;
    const selectionScopeSessionNavigationEntries = React.useMemo<VisibleSessionNavigationEntry[]>(
        () => buildVisibleSessionNavigationEntries(renderModels.selectionScopeListItems),
        [renderModels.selectionScopeListItems],
    );
    const filterResult = renderModels.filterResult;
    // The filter editor is the only host of `Hide inactive sessions`, Source, Homes
    // and Tags, so it stays mounted for every corpus. Each section is individually
    // availability-gated inside the editor model, and the control's own
    // `legacy_owner_or_direct` label already names a corpus with no semantic query.
    const spaceChrome = useSessionListSpaceChrome({ controller: filterController, organizationProjectionsByServerId });
    const filterControl = React.useMemo(() => (
        <SessionListFilterControl
            spaceChrome={spaceChrome}
            controller={filterController}
            keyboardEnabled={surfaceOwnership.interactive}
            organizationProjectionsByServerId={organizationProjectionsByServerId}
            onOpenArchived={filterController.corpusStorage === 'active' ? handleOpenArchivedSessions : undefined}
            filterResult={filterResult}
            conditionValueCounts={sessionListPaneState.conditionValueCounts}
            onConditionValueCountRequest={sessionListPaneState.onConditionValueCountRequest}
        />
    ), [
        spaceChrome,
        filterController,
        filterResult,
        sessionListPaneState.conditionValueCounts,
        sessionListPaneState.onConditionValueCountRequest,
        handleOpenArchivedSessions,
        organizationProjectionsByServerId,
        surfaceOwnership.interactive,
    ]);
    const searchChrome = React.useMemo(() => ({
        filterControl,
        spacesStrip: spaceChrome.strip,
        spaceSwipe: spaceChrome.spaceSwipe,
        filterTokens: spaceChrome.filterTokens,
        overlays: spaceChrome.overlays,
        anchorRef: spaceChrome.anchorRef,
        filterButton: filterController.fixedShow === 'runs' ? undefined : {
            activeCount: spaceChrome.activeCount,
            open: spaceChrome.filterOpen,
            onPress: () => spaceChrome.setFilterOpen(!spaceChrome.filterOpen),
        },
        searchQuery,
        searchScopeLabel: transcriptSearchHomeLabel,
        organizationServerId: transcriptSearchServerId,
        searchStatus,
        searchTrailingAccessory,
        onSearchQueryChange: setSearchQuery,
        // A Team-context escalation must never fall through to Universal Search's
        // ambient (globally focused Home) scope while its exact credential-backed
        // Account binding is still resolving. Keep the action unavailable until
        // the qualified Team Home/Account seed exists.
        onSearchEverything: filterController.viewContext.kind === 'global' || universalSearchScope
            ? handleOpenUniversalSearch
            : undefined,
    }), [
        filterControl,
        spaceChrome,
        filterController.fixedShow,
        filterController.viewContext.kind,
        handleOpenUniversalSearch,
        searchQuery,
        transcriptSearchHomeLabel,
        transcriptSearchServerId,
        universalSearchScope,
        searchStatus,
        searchTrailingAccessory,
        setSearchQuery,
    ]);
    const knownSessionEntries = visibleSessionNavigationEntries;
    // Row-level pin/tag writes resolve their exact Home through the same published addresses the
    // order writes use, so one Session key never means two different Homes on two surfaces.
    const resolveOrganizationTargetForSessionKey = React.useCallback((sessionKey: string): Readonly<{ serverId: string; sessionId: string }> | null => {
        const address = orderItemAddressByItemKey[sessionKey];
        return address?.itemKind === 'session'
            ? { serverId: address.serverId, sessionId: address.sessionId }
            : null;
    }, [orderItemAddressByItemKey]);
    const setSessionPinForSessionKey = React.useCallback((sessionKey: string, pinned: boolean) => {
        runOrganizationMutation(async () => {
            const target = resolveOrganizationTargetForSessionKey(sessionKey);
            if (!target) throw new HappyError(t('errors.unknownError'), false, { code: 'session_organization_target_unavailable' });
            const result = await sessionOrganizationActions.setPin(target.sessionId, pinned, { serverId: target.serverId });
            if (!result.ok) throw new HappyError(result.error, false, { code: result.errorCode });
        });
    }, [resolveOrganizationTargetForSessionKey, runOrganizationMutation]);
    const setSessionTagsForSessionKey = React.useCallback((sessionKey: string, tags: readonly string[]) => {
        runOrganizationMutation(async () => {
            const target = resolveOrganizationTargetForSessionKey(sessionKey);
            if (!target) throw new HappyError(t('errors.unknownError'), false, { code: 'session_organization_target_unavailable' });
            const scope = await getAvailableOrganizationMutationScope(target.serverId);
            await writeSessionOrganizationTagLabels({
                scope,
                sessionId: target.sessionId,
                tags,
            });
        });
    }, [getAvailableOrganizationMutationScope, resolveOrganizationTargetForSessionKey, runOrganizationMutation]);

    const activeSessionKey = React.useMemo(() => {
        if (!activeMruSessionId) return null;
        return findVisibleSessionNavigationEntryByScope(
            visibleSessionNavigationEntries,
            activeMruSessionId,
            focusedSessionAddress?.sessionId === activeMruSessionId
                ? focusedSessionAddress.serverId
                : null,
        )?.sessionKey ?? null;
    }, [activeMruSessionId, focusedSessionAddress, visibleSessionNavigationEntries]);

    const visibleCursorOccurrenceKeyRef = React.useRef<string | null>(null);
    const mruCursorSessionKeyRef = React.useRef<string | null>(null);
    const sessionListKeyboardFocusedRef = React.useRef(false);
    const [sessionListKeyboardFocused, setSessionListKeyboardFocused] = React.useState(false);
    const visibleSessionSelectionRows = React.useMemo(
        () => readSessionListSelectionRowsFromVisibleEntries(visibleSessionNavigationEntries),
        [visibleSessionNavigationEntries],
    );
    const visibleSessionSelectionKeys = visibleSessionSelectionRows.visibleOrderedKeys;
    const selectionScopeSelectionKeys = React.useMemo(
        () => readSessionListSelectionKeysFromVisibleEntries(selectionScopeSessionNavigationEntries),
        [selectionScopeSessionNavigationEntries],
    );
    const sessionListSelectionScopeKey = React.useMemo(() => buildSessionListSelectionScopeKeyForView({
        filters: filterController.filters,
        eligibility: {
            eligibleHomeServerIds: filterController.homeOptions.map((home) => home.serverId),
            // The filter lifetime owner removes these only after their canonical
            // producers prove deletion. Until then a retained qualified value is
            // eligible even while its catalog is loading or its Home is offline.
            eligibleAudiences: filterController.filters.audiences,
            eligibleTagIds: filterController.filters.tagIds,
        },
        storageKind,
        includeInactive: filterController.includeInactive,
    }), [
        filterController.filters,
        filterController.homeOptions,
        filterController.includeInactive,
        storageKind,
    ]);
    const sessionListSelectionStore = useSessionListSelectionController({
        scopeKey: sessionListSelectionScopeKey,
        visibleOrderedKeys: visibleSessionSelectionKeys,
        entityKeysByOccurrenceKey: visibleSessionSelectionRows.entityKeysByOccurrenceKey,
        eligibleKeys: selectionScopeSelectionKeys,
        enabled: surfaceOwnership.interactive,
    });
    const sessionListSelectionSnapshot = React.useSyncExternalStore(
        sessionListSelectionStore.subscribe,
        sessionListSelectionStore.getSnapshot,
        sessionListSelectionStore.getSnapshot,
    );
    React.useEffect(() => {
        visibleCursorOccurrenceKeyRef.current = sessionListSelectionSnapshot.focusedKey;
    }, [sessionListSelectionSnapshot.focusedKey]);
    const previousSelectionCountRef = React.useRef(sessionListSelectionSnapshot.count);
    React.useEffect(() => {
        if (!sessionListSelectionSnapshot.isSelectionMode) {
            previousSelectionCountRef.current = sessionListSelectionSnapshot.count;
            return;
        }
        if (previousSelectionCountRef.current === sessionListSelectionSnapshot.count) return;
        previousSelectionCountRef.current = sessionListSelectionSnapshot.count;
        sessionListA11y.announceSelectionCount({ count: sessionListSelectionSnapshot.count });
    }, [sessionListA11y, sessionListSelectionSnapshot.count, sessionListSelectionSnapshot.isSelectionMode]);
    useEscapeLayer({
        enabled: sessionListSelectionSnapshot.isSelectionMode,
        priority: ESCAPE_LAYER_PRIORITIES.sessionListSelection,
        onEscape: () => {
            sessionListSelectionStore.exit();
            return true;
        },
    });
    React.useEffect(() => {
        if (!surfaceOwnership.dataActive) return;
        if (!activeSessionKey) return;
        mruCursorSessionKeyRef.current = null;
    }, [activeSessionKey, surfaceOwnership.dataActive]);

    const navigateToSessionTarget = React.useCallback((target: VisibleSessionNavigationEntry | null) => {
        if (!target) return;
        attentionInteraction?.releaseKeyboard();
        void navigateToSession(target.sessionId, target.serverId ? { serverId: target.serverId } : undefined);
    }, [attentionInteraction, navigateToSession]);
    const handleVisibleSessionShortcut = React.useCallback((direction: 'previous' | 'next') => {
        const target = resolveVisibleSessionNavigation({
            visibleEntries: visibleSessionNavigationEntries,
            activeSessionKey,
            cursorOccurrenceKey: visibleCursorOccurrenceKeyRef.current,
            direction,
        });
        if (!target) return;
        visibleCursorOccurrenceKeyRef.current = target.occurrenceKey ?? target.sessionKey;
        navigateToSessionTarget(target);
    }, [activeSessionKey, navigateToSessionTarget, visibleSessionNavigationEntries]);
    const handleMruSessionShortcut = React.useCallback((direction: 'previous' | 'next') => {
        const order = moveSessionMruEntryToFront({
            order: sessionMruOrder,
            activeSessionKey,
            knownSessionEntries,
        });
        const target = resolveSessionMruNavigation({
            order,
            knownSessionEntries,
            activeSessionKey,
            cursorSessionKey: mruCursorSessionKeyRef.current,
            direction,
        });
        if (!target) return;
        mruCursorSessionKeyRef.current = target.sessionKey;
        navigateToSessionTarget(target);
    }, [activeSessionKey, knownSessionEntries, navigateToSessionTarget, sessionMruOrder]);
    const resolveSelectionKeyboardCurrentKey = React.useCallback(() => {
        const snapshot = sessionListSelectionStore.getSnapshot();
        return snapshot.focusedKey
            ?? snapshot.anchorKey
            ?? visibleSessionNavigationEntries.find((entry) => entry.sessionKey === activeSessionKey)?.occurrenceKey
            ?? visibleSessionSelectionKeys[0]
            ?? null;
    }, [activeSessionKey, sessionListSelectionStore, visibleSessionNavigationEntries, visibleSessionSelectionKeys]);
    const handleSessionSelectionToggleFocused = React.useCallback(() => {
        const currentKey = resolveSelectionKeyboardCurrentKey();
        if (!currentKey) return;
        attentionInteraction?.zoneProps.onKeyDownCapture({ key: ' ' });
        sessionListSelectionStore.toggle(currentKey);
    }, [attentionInteraction, resolveSelectionKeyboardCurrentKey, sessionListSelectionStore]);
    const handleSessionSelectionExtend = React.useCallback((direction: 'previous' | 'next') => {
        const snapshot = sessionListSelectionStore.getSnapshot();
        const currentKey = resolveSelectionKeyboardCurrentKey();
        if (!currentKey) return;
        const targetKey = resolveAdjacentSessionSelectionKey({
            visibleKeys: visibleSessionSelectionKeys,
            currentKey,
            direction,
        });
        if (!targetKey) return;
        attentionInteraction?.zoneProps.onKeyDownCapture({ key: 'ArrowDown' });
        if (snapshot.selectedKeys.size === 0 || snapshot.anchorKey == null) {
            sessionListSelectionStore.replaceWith(currentKey);
        }
        sessionListSelectionStore.selectRange(targetKey);
    }, [attentionInteraction, resolveSelectionKeyboardCurrentKey, sessionListSelectionStore, visibleSessionSelectionKeys]);
    const handleSessionListKeyDown = React.useCallback((event: any) => {
        if (!surfaceOwnership.interactive) return;
        if (event?.altKey !== true) return;

        const key = String(event?.key ?? '');
        const target = key === 'ArrowDown'
            ? resolveVisibleSessionNavigation({
                visibleEntries: visibleSessionNavigationEntries,
                activeSessionKey,
                cursorOccurrenceKey: visibleCursorOccurrenceKeyRef.current,
                direction: 'next',
            })
            : key === 'ArrowUp'
                ? resolveVisibleSessionNavigation({
                    visibleEntries: visibleSessionNavigationEntries,
                    activeSessionKey,
                    cursorOccurrenceKey: visibleCursorOccurrenceKeyRef.current,
                    direction: 'previous',
                })
                : key === 'Home'
                    ? resolveVisibleSessionEdgeNavigation({
                        visibleEntries: visibleSessionNavigationEntries,
                        edge: 'first',
                    })
                    : key === 'End'
                        ? resolveVisibleSessionEdgeNavigation({
                            visibleEntries: visibleSessionNavigationEntries,
                            edge: 'last',
                        })
                        : null;
        if (!target) return;

        event?.preventDefault?.();
        event?.stopPropagation?.();
        visibleCursorOccurrenceKeyRef.current = target.occurrenceKey ?? target.sessionKey;
        navigateToSessionTarget(target);
    }, [activeSessionKey, navigateToSessionTarget, surfaceOwnership.interactive, visibleSessionNavigationEntries]);
    useKeyboardShortcutHandlers(React.useMemo(() => (
        surfaceOwnership.interactive
            ? {
                'session.visible.previous': () => handleVisibleSessionShortcut('previous'),
                'session.visible.next': () => handleVisibleSessionShortcut('next'),
                'session.mru.previous': () => handleMruSessionShortcut('next'),
                'session.mru.next': () => handleMruSessionShortcut('previous'),
                ...(sessionListKeyboardFocused
                    ? {
                        'sessions.selection.toggleFocused': handleSessionSelectionToggleFocused,
                        'sessions.selection.extendUp': () => handleSessionSelectionExtend('previous'),
                        'sessions.selection.extendDown': () => handleSessionSelectionExtend('next'),
                        'sessions.selection.selectAll': () => sessionListSelectionStore.selectAllVisible(),
                        'sessions.selection.clear': () => sessionListSelectionStore.exit(),
                    }
                    : {}),
            }
            : {}
    ), [
        handleMruSessionShortcut,
        handleSessionSelectionExtend,
        handleSessionSelectionToggleFocused,
        handleVisibleSessionShortcut,
        sessionListKeyboardFocused,
        sessionListSelectionStore,
        surfaceOwnership.interactive,
    ]));



    const virtualizedListRef = React.useRef<VirtualizedListRef | null>(null);
    const treeViewportRef = React.useRef<TreeDropMeasurableRef | null>(null);
    const scrollToTreeOffset = React.useCallback((offsetY: number) => {
        virtualizedListRef.current?.scrollToOffset?.({ offset: offsetY, animated: false });
    }, []);
    const scrollToRetainedOffset = React.useCallback((params: { offset: number; animated?: boolean }) => {
        virtualizedListRef.current?.scrollToOffset?.(params);
    }, []);
    const scrollToRetainedIndex = React.useCallback((params: {
        index: number;
        animated?: boolean;
        viewOffset?: number;
        viewPosition?: number;
    }) => {
        void virtualizedListRef.current?.scrollToIndex(params);
    }, []);
    const rowInteractions = useSessionListRowInteractions({
        presentationScopeKey: JSON.stringify([
            filterController.retentionScopeKey,
            filterController.viewContextKey,
            filterController.selectedSpaceId,
            filterController.corpusStorage,
            filterController.filters,
        ]),
        folderActionsEnabled: Boolean(folderActionsEnabled),
        isFolderActionsEnabledForServerId,
        sessionSections: organizationListViewState.sections,
        spaceMembershipSourceSpaceId: filterController.activeSpace?.id,
        spaceMembershipTargets: filterController.spacesEnabled && filterController.spaceSettingsScope
            ? filterController.spaces.map(space => ({ spaceId: space.id, name: space.name,
                spaceSettingsTarget: filterController.spaceSettingsScope! })) : undefined,
        listItems: renderModels.listItems,
        currentGroupOrderMap: orderingPersistenceState.currentGroupOrderMap,
        currentWorkspaceOrderMap,
        sessionListLayoutV1: sessionListLayoutChoice,
        manualSessionOrderingEnabled: shellFlags.canReorderSessions,
        setSessionListGroupOrderV1,
        setSessionWorkspaceOrderV1,
        pinnedKeySet: orderingPersistenceState.pinnedKeySet,
        sessionTags: normalizedShellState.sessionTags,
        setSessionPinForKey: setSessionPinForSessionKey,
        setSessionTagsForKey: setSessionTagsForSessionKey,
        scrollToOffset: scrollToTreeOffset,
        scrollToIndex: index => scrollToRetainedIndex({ index, animated: true, viewPosition: 0.5 }),
    });
    const measureVirtualizedNodeViewportOffset = React.useCallback((nodeId: string) => {
        const listRef = virtualizedListRef.current;
        const viewportRef = (listRef?.getNativeScrollRef?.() ?? listRef?.getScrollableNode?.() ?? null) as TreeDropMeasurableRef | null;
        return rowInteractions.measureTreeRowViewportOffset(nodeId, viewportRef);
    }, [rowInteractions]);
    const frozenListProjection = useFrozenSessionListItemsDuringDrag({
        activeSnapshot: rowInteractions.activeDragSnapshot,
        liveViewItems: renderModels.listItems,
    });
    const renderedListItems = frozenListProjection.viewItems;
    const unscopedSelectionIsUnique = React.useMemo(() => (
        !String(selectedSessionServerId ?? '').trim()
        && resolveSessionListUnscopedSelectionIsUnique(renderedListItems, selectedSessionId)
    ), [renderedListItems, selectedSessionId, selectedSessionServerId]);
    const sessionListItemBySelectionKey = React.useMemo(() => {
        const map = new Map<string, Extract<SessionListIndexItem, { type: 'session' }>>();
        for (const item of renderedListItems) {
            if (item.type !== 'session') continue;
            map.set(buildServerScopedSessionKey(item.sessionId, item.serverId, item.keyParts), item);
        }
        return map;
    }, [renderedListItems]);
    const visibleSessionListAddressesRef = React.useRef<readonly SessionAddress[]>([]);
    const visibleSessionListAddresses = React.useMemo(() => {
        const addresses: SessionAddress[] = [];
        for (const key of viewableSessionRowKeys ?? []) {
            const item = sessionListItemBySelectionKey.get(key);
            const address = item ? normalizeSessionAddress(item.serverId, item.sessionId) : null;
            if (address) addresses.push(address);
        }
        addresses.sort((a, b) => a.serverId.localeCompare(b.serverId) || a.sessionId.localeCompare(b.sessionId));
        const previous = visibleSessionListAddressesRef.current;
        if (previous.length === addresses.length && addresses.every((address, index) => (
            address.serverId === previous[index].serverId && address.sessionId === previous[index].sessionId
        ))) return previous;
        visibleSessionListAddressesRef.current = addresses;
        return addresses;
    }, [sessionListItemBySelectionKey, viewableSessionRowKeys]);
    useSessionContentDemand(visibleSessionListAddresses, {
        tag: 'sessionsList.hydrateVisibleRows',
        hydrate: 'viewport',
        active: surfaceOwnership.dataActive,
        resetVersion: visibilityResetVersion,
    });
    const statusDemandSubscriptionItems = React.useMemo(() => {
        if (viewableSessionRowKeys !== null) {
            const visibleItems: Array<Extract<SessionListIndexItem, { type: 'session' }>> = [];
            for (const rowKey of viewableSessionRowKeys) {
                const item = sessionListItemBySelectionKey.get(rowKey) ?? null;
                if (!item) continue;
                visibleItems.push(item);
                if (visibleItems.length >= EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1) break;
            }
            return visibleItems;
        }

        return [];
    }, [sessionListItemBySelectionKey, viewableSessionRowKeys]);
    // The rows' content is read by the demand publisher leaf (`SessionListExternalStatusDemandPublisher`),
    // not here: subscribing the list to every listed row re-rendered the whole list on each session write.
    const externalStatusDemand = React.useMemo(() => ({
        items: statusDemandSubscriptionItems,
        viewportId: statusDemandViewportId,
        visibleRowKeys: viewableSessionRowKeys,
    }), [statusDemandSubscriptionItems, statusDemandViewportId, viewableSessionRowKeys]);
    const selectedSessionListItems = React.useMemo(() => {
        if (!sessionListSelectionSnapshot.isSelectionMode || sessionListSelectionSnapshot.selectedKeys.size === 0) {
            return [] as Array<Extract<SessionListIndexItem, { type: 'session' }>>;
        }
        return renderModels.selectionScopeListItems.filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => (
            item.type === 'session'
            && sessionListSelectionSnapshot.selectedKeys.has(buildServerScopedSessionKey(item.sessionId, item.serverId, item.keyParts))
        ));
    }, [
        renderModels.selectionScopeListItems,
        sessionListSelectionSnapshot.isSelectionMode,
        sessionListSelectionSnapshot.selectedKeys,
    ]);
    const selectedRowRenderableByKey = useSessionListRowRenderablesForItems(selectedSessionListItems);
    const sessionListSelectionTargetsByKey = React.useMemo(() => {
        if (selectedSessionListItems.length === 0) return new Map<string, SessionBulkActionTarget>();
        const targets = new Map<string, SessionBulkActionTarget>();
        for (const item of selectedSessionListItems) {
            const rowKey = resolveSessionListRowStoreScopeKey(item);
            const session = selectedRowRenderableByKey.get(rowKey);
            if (!session) continue;
            const target = buildSessionBulkActionTargetFromSessionItem({
                item,
                session,
                currentUserId,
                pinnedKeySet: orderingPersistenceState.pinnedKeySet,
                sessionTags: normalizedShellState.sessionTags,
                foldersFeatureEnabled: isFolderActionsEnabledForServerId(item.serverId),
                attentionStandingEnabled: attentionStanding.actionEnabled,
                attentionStandingPolicy: attentionStanding.policy,
            });
            if (target) targets.set(target.key, target);
        }
        return targets;
    }, [
        attentionStanding.actionEnabled,
        attentionStanding.policy,
        currentUserId,
        isFolderActionsEnabledForServerId,
        normalizedShellState.sessionTags,
        orderingPersistenceState.pinnedKeySet,
        selectedRowRenderableByKey,
        selectedSessionListItems,
    ]);
    const rowLabelByTreeRowId = React.useMemo(() => {
        const labels = new Map<string, string>();
        for (const item of renderedListItems) {
            if (item.type === 'session') {
                labels.set(resolveTreeRowIdForSessionItem(item), item.sessionId);
                continue;
            }
            if (item.type !== 'header') continue;
            if (item.headerKind === 'folder' && item.folderId) {
                const serverId = item.serverId ?? item.workspace?.serverId;
                if (serverId) labels.set(treeRowId.folder(serverId, item.folderId), item.title);
            } else if (item.headerKind === 'project' && (item.groupKey || item.workspaceKey)) {
                labels.set(resolveWorkspaceRootTreeRowId(item), item.title);
            }
        }
        return labels;
    }, [renderedListItems]);



    const resolveDropResultDestinationLabel = React.useCallback((
        result: Parameters<typeof sessionListA11y.announceDropResult>[0]['result'],
    ) => {
        const instruction = result.instruction;
        if (instruction.kind === 'move-to-root') return t('sessionsList.moveToWorkspaceRoot');
        if (instruction.kind === 'nest-into') return rowLabelByTreeRowId.get(instruction.targetId) ?? null;
        if (instruction.kind === 'reorder-before' || instruction.kind === 'reorder-after') {
            return rowLabelByTreeRowId.get(instruction.targetId) ?? null;
        }
        return null;
    }, [rowLabelByTreeRowId]);

    // Read at activation only: the sheet names the Session by its title, never its id, without a per-row read.
    const renderedListItemsRef = React.useRef(renderedListItems);
    renderedListItemsRef.current = renderedListItems;
    // New section is named in place, where it will land (lab `clsections:custom`); a list that draws no
    // group at all has no such place, so it asks in the shared prompt instead.
    const sectionDraft = useSessionSectionDraft();
    const requestSectionDraft = sectionDraft.request;
    const requestNewSection = React.useCallback(async (
        serverId: string | null,
        create: (name: string) => Promise<boolean>,
    ): Promise<boolean> => {
        if (resolveSessionSectionDraftAnchor(renderedListItemsRef.current, {
            serverId, sections: sectionMoveSourcesRef.current?.sections ?? [],
        })) return requestSectionDraft(serverId, create);
        const name = await Modal.prompt(t('sessionsList.newSection'), undefined, {
            placeholder: t('sessionsList.sectionNamePlaceholder'),
            confirmText: t('common.create'),
        });
        return name?.trim() ? create(name.trim()) : false;
    }, [requestSectionDraft]);
    const resolveSessionTitleForTreeRow = React.useCallback((sourceRowId: string): string | null => {
        const item = renderedListItemsRef.current.find((candidate) => candidate.type === 'session'
            && resolveTreeRowIdForSessionItem(candidate) === sourceRowId);
        if (!item || item.type !== 'session') return null;
        const row = readSessionListRowForServerId(getStorage().getState().sessionListRowsByServerId, item.serverId ?? null, item.sessionId);
        return row ? getSessionName(row, item.serverId ?? null) : null;
    }, []);
    const openMoveSheetForTreeRow = React.useCallback(async (sourceRowId: string, sourceLabel: string) => {
        await openMoveSheet({
            sourceLabel: resolveSessionTitleForTreeRow(sourceRowId) ?? sourceLabel,
            runtime: rowInteractions.entityDragDrop.runtime,
            // Move to section offers this list's own filing places (its sections and Back to project), not
            // every surface a Session could be dropped on nor every lead it could report to.
            includeDestination: (entry) => entry.targetId === rowInteractions.entityDragDrop.targetId
                && readSessionListFolderAssignmentDestination(entry.destination) !== null,
            prepareSource: () => rowInteractions.prepareTreeRowSource(sourceRowId),
        });
    }, [openMoveSheet, resolveSessionTitleForTreeRow, rowInteractions.entityDragDrop.runtime,
        rowInteractions.entityDragDrop.targetId, rowInteractions.prepareTreeRowSource]);

    // Move to section files a row through the same drop destination its drag uses (one Action, one admission).
    const moveTreeRowToFolder = React.useCallback((sourceRowId: string, sourceLabel: string, folderId: string | null, destinationLabel: string) => {
        runOrganizationMutation(async () => {
            const source = rowInteractions.prepareTreeRowSource(sourceRowId);
            if (!source) {
                Modal.alert(t('sessionsList.moveToFolder'), t('sessionsList.moveSheetEmpty'));
                return;
            }
            try {
                const runtime = rowInteractions.entityDragDrop.runtime;
                const destination = runtime.getDestinations(source.sourceId).find(entry => entry.targetId === rowInteractions.entityDragDrop.targetId
                    && (readSessionListFolderAssignmentDestination(entry.destination)?.folderId === folderId
                        || (folderId === null && readSessionListDestinationIntent(entry.destination, source.scope)?.instructionKind === 'move-to-root')));
                if (!destination || destination.admission.status !== 'allowed') return;
                const outcome = await runtime.perform(source.sourceId, destination.targetId, destination.destination, 'chooser');
                if (outcome?.status === 'applied') sessionListA11y.announceDropResult({ label: sourceLabel,
                    destinationLabel, result: { instruction: folderId === null
                        ? { kind: 'move-to-root', containerId: sourceRowId, rootId: sourceRowId, depth: 0 }
                        : { kind: 'nest-into', targetId: treeRowId.folder(source.scope.serverId, folderId),
                            containerId: treeRowId.folder(source.scope.serverId, folderId),
                            parentId: treeRowId.folder(source.scope.serverId, folderId), depth: 0 },
                    visual: { kind: 'none' } } });
            } finally {
                source.dispose();
            }
        });
    }, [rowInteractions.entityDragDrop.runtime, rowInteractions.entityDragDrop.targetId, rowInteractions.prepareTreeRowSource, runOrganizationMutation, sessionListA11y]);
    const moveTreeRowToWorkspaceRoot = React.useCallback((sourceRowId: string, sourceLabel: string) => {
        moveTreeRowToFolder(sourceRowId, sourceLabel, null, t('sessionsList.moveToWorkspaceRoot'));
    }, [moveTreeRowToFolder]);

    // Read when a row menu opens: the row's Home, section and project, against the list's current sections.
    const sectionMoveSourcesRef = React.useRef<Readonly<{
        sections: readonly SessionSection[];
        projectDisplayByKey: ReadonlyMap<string, ProjectGroupDisplay>;
    }> | null>(null);
    const findSessionItemForTreeRow = React.useCallback((sourceRowId: string) => {
        const item = renderedListItemsRef.current.find((candidate) => candidate.type === 'session'
            && resolveTreeRowIdForSessionItem(candidate) === sourceRowId);
        return item?.type === 'session' && item.serverId ? item : null;
    }, []);
    const spaceMembershipMenuSources = filterController.spacesEnabled && filterController.spaceSettingsScope
        ? { spaces: filterController.spaces, target: filterController.spaceSettingsScope } : null;
    const spaceMembershipMenuSourcesRef = React.useRef(spaceMembershipMenuSources);
    spaceMembershipMenuSourcesRef.current = spaceMembershipMenuSources;
    // Open menus retain the displayed catalog's Account; choosing never rereads a later sidebar scope.
    const readSpaceMembershipMenu = React.useCallback((sourceRowId: string, iconColor: string) => {
        const catalog = spaceMembershipMenuSourcesRef.current;
        if (!catalog || !findSessionItemForTreeRow(sourceRowId)) return null;
        return { ...buildSessionSpaceMembershipMenu(catalog.spaces, iconColor), choose: (choice: SessionSpaceMembershipMenuChoice) => {
            runOrganizationMutation(async () => {
                const source = rowInteractions.prepareTreeRowSource(sourceRowId);
                if (!source) return;
                try {
                    await rowInteractions.entityDragDrop.runtime.perform(source.sourceId, rowInteractions.entityDragDrop.targetId,
                        { kind: 'space-membership', ...choice, spaceSettingsTarget: catalog.target }, 'chooser');
                } finally {
                    source.dispose();
                }
            });
        } };
    }, [findSessionItemForTreeRow, rowInteractions.prepareTreeRowSource, rowInteractions.entityDragDrop.runtime,
        rowInteractions.entityDragDrop.targetId, runOrganizationMutation]);
    const readSectionMoveMenuItems = React.useCallback((sourceRowId: string, iconColor: string) => {
        const item = findSessionItemForTreeRow(sourceRowId);
        const sources = sectionMoveSourcesRef.current;
        if (!item?.serverId || !sources) return null;
        return buildSessionSectionMoveMenuItems({
            serverId: item.serverId,
            sections: sources.sections,
            currentSectionIds: [item.folderId ?? null],
            projectTitle: readSessionListProjectDisplay(item, sources.projectDisplayByKey)?.title ?? null,
            iconColor,
            canCreate: true,
        });
    }, [findSessionItemForTreeRow]);
    const moveTreeRowToSection = React.useCallback((sourceRowId: string, sourceLabel: string, choice: SessionSectionMoveChoice) => {
        if (choice.kind === 'project') {
            moveTreeRowToWorkspaceRoot(sourceRowId, sourceLabel);
            return;
        }
        if (choice.kind === 'section') {
            const section = sectionMoveSourcesRef.current?.sections.find((candidate) => candidate.address.sectionId === choice.sectionId);
            moveTreeRowToFolder(sourceRowId, sourceLabel, choice.sectionId,
                section?.display.status === 'available' ? section.display.value.name : t('common.unavailable'));
            return;
        }
        const item = findSessionItemForTreeRow(sourceRowId);
        if (!item?.serverId) return;
        const serverId = item.serverId;
        // New section… is named in place, then files the row on its own captured Home, as one continuation.
        void requestNewSection(serverId, async (name) => {
            const scope = await getAvailableOrganizationMutationScope(serverId);
            const created = await writeSessionSectionDefinition({ scope, actionId: 'session.sections.create', input: { name } });
            const sectionId = (created as { section?: { sectionId?: unknown } } | null)?.section?.sectionId;
            if (typeof sectionId !== 'string') return false;
            // The section exists now: a failed filing says so once, and Enter never creates it twice.
            runOrganizationMutation(() => writeSessionOrganizationFolderAssignment({ scope, sessionId: item.sessionId, folderId: sectionId }));
            return true;
        });
    }, [findSessionItemForTreeRow, getAvailableOrganizationMutationScope, moveTreeRowToFolder, moveTreeRowToWorkspaceRoot,
        requestNewSection, runOrganizationMutation]);

    const moveTreeRowByKeyboard = React.useCallback((
        sourceRowId: string,
        sourceLabel: string,
        direction: 'up' | 'down',
    ) => {
        const move = rowInteractions.applyKeyboardMove(sourceRowId, direction);
        if (!move) return;
        void sessionListA11y.announceDropResultAfterCommit(move.committed, {
            label: sourceLabel,
            destinationLabel: resolveDropResultDestinationLabel(move.result),
            result: move.result,
        });
    }, [resolveDropResultDestinationLabel, rowInteractions.applyKeyboardMove, sessionListA11y]);
    const getRowMoveActionHandlers = useSessionListRowMoveActionHandlers({
        openMoveSheetForTreeRow,
        moveTreeRowToWorkspaceRoot,
        moveTreeRowByKeyboard,
        readSectionMoveMenuItems,
        moveTreeRowToSection,
        readSpaceMembershipMenu,
    });

    useKeyboardShortcutHandlers(React.useMemo(() => (
        surfaceOwnership.interactive
            ? {
                'sessions.row.moveToFolder': () => {
                    const rowId = resolveSessionTreeRowId(activeSessionKey, knownSessionEntries);
                    if (!rowId) return;
                    void openMoveSheetForTreeRow(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'));
                },
                'sessions.row.moveToWorkspaceRoot': () => {
                    const rowId = resolveSessionTreeRowId(activeSessionKey, knownSessionEntries);
                    if (!rowId) return;
                    moveTreeRowToWorkspaceRoot(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'));
                },
                'sessions.row.moveUp': () => {
                    const rowId = resolveSessionTreeRowId(activeSessionKey, knownSessionEntries);
                    if (!rowId) return;
                    moveTreeRowByKeyboard(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'), 'up');
                },
                'sessions.row.moveDown': () => {
                    const rowId = resolveSessionTreeRowId(activeSessionKey, knownSessionEntries);
                    if (!rowId) return;
                    moveTreeRowByKeyboard(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'), 'down');
                },
            }
            : {}
    ), [
        activeSessionKey,
        knownSessionEntries,
        moveTreeRowByKeyboard,
        moveTreeRowToWorkspaceRoot,
        openMoveSheetForTreeRow,
        rowLabelByTreeRowId,
        surfaceOwnership.interactive,
    ]));

    const {
        handleRenameWorkspace,
        handleResetWorkspaceName,
        handleToggleCollapse,
    } = useSessionListWorkspaceHeaderActions({
        projectOrganizations,
        toggleCollapsedGroup,
    });

    // Sections are Account filing on one Home (P5 §4): every definition write goes through the section
    // Actions on the header's captured Home, the same admission agents use; nothing writes a folder tree.
    const sectionByGroupKey = React.useMemo(() => new Map(organizationListViewState.sections.map(section => [
        buildSessionSectionGroupKey(section.address), section,
    ])), [organizationListViewState.sections]);
    // Sections whose rows this view draws; the facts change identity only when that set changes.
    const sectionGroupKeysWithRowsSignature = React.useMemo(() => {
        const keys = new Set<string>();
        for (const item of renderedListItems) {
            if (item.type === 'session' && item.groupKind === 'folder' && item.groupKey) keys.add(item.groupKey);
        }
        return [...keys].sort().join('\n');
    }, [renderedListItems]);
    const sectionFactsByGroupKey = React.useMemo(() => {
        const withRows = new Set(sectionGroupKeysWithRowsSignature.split('\n'));
        return new Map(organizationListViewState.sections.map((section) => {
            const members = organizationListViewState.sectionMemberSessionKeysBySectionKey[
                buildSessionOrganizationServerKey(section.address.serverId, section.address.sectionId)];
            const complete = organizationListViewState.sectionMembershipCompleteByServerId[section.address.serverId] === true;
            const groupKey = buildSessionSectionGroupKey(section.address);
            return [groupKey, {
                icon: section.display.status === 'available' ? section.display.value.icon : null,
                ...(complete && members ? { memberCount: members.length } : {}),
                hasRowsInView: withRows.has(groupKey),
            }] as const;
        }));
    }, [organizationListViewState.sectionMemberSessionKeysBySectionKey,
        organizationListViewState.sectionMembershipCompleteByServerId, organizationListViewState.sections,
        sectionGroupKeysWithRowsSignature]);
    const writeSectionDefinition = React.useCallback((
        serverId: string | null | undefined,
        actionId: Parameters<typeof writeSessionSectionDefinition>[0]['actionId'],
        input: Readonly<Record<string, unknown>>,
    ) => {
        runOrganizationMutation(async () => {
            await writeSessionSectionDefinition({ scope: await getAvailableOrganizationMutationScope(serverId), actionId, input });
        });
    }, [getAvailableOrganizationMutationScope, runOrganizationMutation]);
    const handleCreateSection = React.useCallback(async (serverId?: string | null) => {
        await requestNewSection(serverId ?? null, async (name) => {
            await writeSessionSectionDefinition({
                scope: await getAvailableOrganizationMutationScope(serverId),
                actionId: 'session.sections.create',
                input: { name },
            });
            return true;
        });
    }, [getAvailableOrganizationMutationScope, requestNewSection]);
    const handleAddFolderToWorkspace = React.useCallback(async (item: Extract<SessionListIndexItem, { type: 'header' }>) => {
        await handleCreateSection(item.serverId ?? item.workspace?.serverId);
    }, [handleCreateSection]);

    const router = useRouter();
    const handleCreateSessionInSection = React.useCallback((item: Extract<SessionListIndexItem, { type: 'header' }>) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !item.folderId) return;
        // New session here preselects only the section; Machine, Agent and directory keep their own choices.
        const draftId = randomUUID();
        writeNewSessionDraftToRepository({
            scope: lifetime.scope, draftId, materializationIntent: 'seeded',
            draft: buildNewSessionConfigurationDraft({ organizationPlacement: { folderId: item.folderId, tagIds: [] } }),
        });
        router.push({ pathname: '/new', params: buildNewSessionLaunchRouteParams({ draftId, targetServerId: item.serverId }) } as never);
    }, [router]);

    const handleRenameSection = React.useCallback(async (item: Extract<SessionListIndexItem, { type: 'header' }>) => {
        if (!item.folderId) return;
        const name = await Modal.prompt(t('common.rename'), undefined, {
            defaultValue: item.title,
            placeholder: t('sessionsList.sectionNamePlaceholder'),
            confirmText: t('common.rename'),
        });
        if (!name?.trim() || name.trim() === item.title) return;
        writeSectionDefinition(item.serverId, 'session.sections.update', { sectionId: item.folderId, name: name.trim() });
    }, [writeSectionDefinition]);

    const handleChangeSectionIcon = React.useCallback((item: Extract<SessionListIndexItem, { type: 'header' }>, icon: string) => {
        if (!item.folderId) return;
        writeSectionDefinition(item.serverId, 'session.sections.update', { sectionId: item.folderId, icon });
    }, [writeSectionDefinition]);

    const handleRemoveSection = React.useCallback(async (item: Extract<SessionListIndexItem, { type: 'header' }>) => {
        if (!item.folderId) return;
        const section = sectionByGroupKey.get(item.groupKey ?? '');
        const parent = section?.legacyContext?.ancestors.at(-1);
        const parentName = parent?.display?.status === 'available' ? parent.display.value.name : null;
        const confirmed = await Modal.confirm(
            t('sessionsList.removeSectionConfirmTitle', { name: item.title || t('common.unavailable') }),
            parentName
                ? t('sessionsList.removeNestedSectionConfirmDescription', { parent: parentName })
                : t('sessionsList.removeSectionConfirmDescription'),
            { confirmText: t('sessionsList.removeSectionConfirm'), cancelText: t('common.cancel') },
        );
        if (!confirmed) return;
        writeSectionDefinition(item.serverId, 'session.sections.delete', { sectionId: item.folderId });
    }, [sectionByGroupKey, writeSectionDefinition]);

    // Archive all: no confirmation (archive is reversible); it speaks only when some members stayed (P5 §7).
    const handleArchiveSection = React.useCallback((item: Extract<SessionListIndexItem, { type: 'header' }>) => {
        const sectionId = item.folderId;
        if (!sectionId) return;
        runOrganizationMutation(async () => {
            const result = await archiveSessionSection({ scope: await getAvailableOrganizationMutationScope(item.serverId), sectionId });
            const outcome = resolveSessionSectionArchiveOutcome(result);
            if (!outcome) return;
            Modal.alert(
                t('sessionsList.sectionArchivePartialTitle'),
                outcome.total === null
                    ? t('sessionsList.sectionArchiveUnknown')
                    : outcome.recovery === 'stop_sessions'
                        ? t('sessionsList.sectionArchiveNeedsStop', { archived: outcome.archived, total: outcome.total })
                        : t('sessionsList.sectionArchivePartial', { archived: outcome.archived, total: outcome.total }),
            );
        });
    }, [getAvailableOrganizationMutationScope, runOrganizationMutation]);

    const sessionFoldersSignature = React.useMemo(
        () => buildSessionFoldersSignature(availableSessionFoldersV1),
        [availableSessionFoldersV1],
    );
    const sessionListBulkActionContext = React.useMemo<SessionBulkActionExecutionContext>(() => ({
        setSessionPin: async ({ target, pinned }) => {
            await setSessionPinForTarget(target, pinned);
        },
        setSessionTagAssignments: async ({ target, tags }) => {
            await setSessionTagAssignmentsForTarget(target, tags);
        },
        setSessionAttentionStanding: async ({ target, standing }) => {
            const result = await sessionSetAttentionStandingWithServerScope(
                target.sessionId,
                standing,
                { serverId: target.serverId ?? null },
            );
            if (!result.success) {
                throw new Error(result.message || 'Failed to update session attention standing');
            }
        },
        hideInactiveSessions: hideInactiveSessions === true,
        foldersFeatureDecision: { state: folderActionsEnabled ? 'enabled' : 'disabled' },
        stopErrorMessage: t('sessionInfo.failedToStopSession'),
        archiveErrorMessage: t('sessionInfo.failedToArchiveSession'),
        stopSession: async (target) => await executeSessionLifecycleAction('session.stop', target.sessionId, { serverId: target.serverId ?? null }),
        archiveSession: async (target, archiveOperation) => await executeSessionLifecycleAction('session.archive', target.sessionId, { serverId: target.serverId ?? null, archiveOperation }),
        unarchiveSession: async (target) => await executeSessionLifecycleAction('session.unarchive', target.sessionId, { serverId: target.serverId ?? null }),
        setManualReadState: async (target, readState) => await sessionSetManualReadStateWithServerScope(
            target.sessionId,
            readState,
            { serverId: target.serverId ?? null },
        ),
        stopSessionAndMaybeArchive: async (params) => {
            return await stopSessionAndMaybeArchive({
                address: params.address,
                hideInactiveSessions: params.hideInactiveSessions,
                isPinned: params.isPinned,
                archiveAfterStop: params.archiveAfterStop,
                stopSession: params.stopSession,
                archiveSession: params.archiveSession,
                stopErrorMessage: params.stopErrorMessage,
                archiveErrorMessage: params.archiveErrorMessage,
            });
        },
    }), [
        folderActionsEnabled,
        hideInactiveSessions,
        setSessionPinForTarget,
        setSessionTagAssignmentsForTarget,
    ]);
    const {
        scopeHintByLegacyWorkspaceKey,
        projectHeaderViewModelByGroupKey,
        projectDisplayByKey,
        groupProjectByGroupKey,
    } = renderModels.projectHeaderViewModelState;
    sectionMoveSourcesRef.current = { sections: organizationListViewState.sections, projectDisplayByKey };
    const handleRequestBulkMoveToFolder = React.useCallback(async (targets: readonly SessionBulkActionTarget[]) => {
        if (!folderActionsEnabled || targets.length === 0) return null;
        const firstMovableItem = targets
            .filter((target) => target.canMoveToFolder === true)
            .map((target) => sessionListItemBySelectionKey.get(target.key) ?? null)
            .find((item): item is Extract<SessionListIndexItem, { type: 'session' }> => Boolean(item && item.serverId
                && resolveSessionListItemOrganizationEligibility(item, { foldersFeatureEnabled: isFolderActionsEnabledForServerId(item.serverId) }).canUseSessionFolders));
        if (!firstMovableItem) return null;
        const destinationServerId = firstMovableItem.serverId;
        if (!destinationServerId) return null;
        // Capture the chosen Home's Account before the picker can await user input. Every
        // child Action retains this scope instead of selecting replacement credentials later.
        const scope = await getAvailableOrganizationMutationScope(destinationServerId);
        const currentFolderIds = targets.flatMap((target) => {
            if (target.canMoveToFolder !== true) return [];
            const item = sessionListItemBySelectionKey.get(target.key);
            if (!item || !resolveSessionListItemOrganizationEligibility(item, {
                foldersFeatureEnabled: isFolderActionsEnabledForServerId(item.serverId),
                destinationServerId,
            }).canUseSessionFolders) return [];
            return [item.folderId ?? null];
        });
        // Bulk move offers the row menu's own choices (lab `clsections:menu`: sections, New section…, Back to project).
        const projectTitles = new Set(targets.flatMap((target) => {
            const item = sessionListItemBySelectionKey.get(target.key);
            return item?.type === 'session'
                ? [readSessionListProjectDisplay(item, projectDisplayByKey)?.title ?? null] : [null];
        }));
        const selected = await openSessionFolderSelection({
            sourceLabel: t('sessionsList.selectionMoveSheetSourceLabel', { count: targets.length }),
            serverId: destinationServerId, sections: organizationListViewState.sections,
            value: null, currentSectionIds: currentFolderIds,
            projectTitle: projectTitles.size === 1 ? [...projectTitles][0] ?? null : null,
            onCreate: async () => {
                let createdSectionId: string | null = null;
                const created = await requestNewSection(destinationServerId, async (name) => {
                    const result = await writeSessionSectionDefinition({ scope, actionId: 'session.sections.create', input: { name } });
                    const sectionId = (result as { section?: { sectionId?: unknown } } | null)?.section?.sectionId;
                    createdSectionId = typeof sectionId === 'string' ? sectionId : null;
                    return createdSectionId !== null;
                });
                return created && createdSectionId !== null ? { serverId: destinationServerId, sectionId: createdSectionId } : null;
            },
        });
        if (selected === undefined) return null;
        const folderId = selected?.sectionId ?? null;
        return {
            folderId,
            destinationServerId,
            executionContext: {
                setSessionFolderAssignment: async ({ target, folderId }: Parameters<NonNullable<SessionBulkActionExecutionContext['setSessionFolderAssignment']>>[0]) => {
                    scope.assertCurrent?.();
                    if (target.serverId !== destinationServerId) throw new HappyError('session_organization_scope_mismatch', false);
                    await writeSessionOrganizationFolderAssignment({ scope, sessionId: target.sessionId, folderId });
                },
            },
        };
    }, [folderActionsEnabled, getAvailableOrganizationMutationScope, isFolderActionsEnabledForServerId,
        organizationListViewState.sections, projectDisplayByKey, requestNewSection, sessionListItemBySelectionKey]);

    useSessionListWorkspaceLabelMigration({
        workspaceLabels: normalizedShellState.workspaceLabels,
        scopeHintByLegacyWorkspaceKey,
    });

    const collapsedKeys = normalizedShellState.collapsedGroupKeys;
    // A Runs-only list holds no place a Session could start: its group headers carry no "+".
    const newSessionEnabled = filterController.displayFilters.show !== 'runs';
    const renderHeaderItem = React.useCallback((item: Extract<SessionListIndexItem, { type: 'header' }>, first: boolean) => (
        <SessionListHeaderItem
            item={item}
            first={first}
            collapsedKeys={collapsedKeys}
            projectHeaderViewModelByGroupKey={projectHeaderViewModelByGroupKey}
            hasMultipleMachines={renderModels.hasMultipleMachines}

            onOpenProject={handleOpenProject}
            onCreateSessionFromWorkspaceScope={handleCreateSessionFromWorkspaceScope}
            onAddFolderToWorkspace={handleAddFolderToWorkspace}
            onRenameWorkspace={handleRenameWorkspace}
            onResetWorkspaceName={handleResetWorkspaceName}
            onToggleCollapse={handleToggleCollapse}
            getRowMoveActionHandlers={getRowMoveActionHandlers}
            sectionFactsByGroupKey={sectionFactsByGroupKey}
            onCreateSessionInSection={handleCreateSessionInSection}
            onRenameSection={handleRenameSection}
            onChangeSectionIcon={handleChangeSectionIcon}
            onRemoveSection={handleRemoveSection}
            onArchiveSection={handleArchiveSection}
            workspaceFaviconsEnabled={workspaceFaviconsEnabled}
            workspaceMachineSubtitlesEnabled={workspaceMachineSubtitlesEnabled}
            newSessionEnabled={newSessionEnabled}
            overlayShared={rowInteractions.dropOverlayShared}
            onRegisterTreeRowBounds={rowInteractions.registerTreeRowBounds}
            onUnregisterTreeRowBounds={rowInteractions.unregisterTreeRowBounds}
            onFolderDragStart={rowInteractions.handleDragStart}
            onFolderDragCancel={rowInteractions.handleDragCancel}
            resolveDropResult={rowInteractions.resolveTreeDropResult}
            onFolderDropResult={rowInteractions.handleFolderHeaderTreeDropResult}
        />
    ), [
        collapsedKeys,
        getRowMoveActionHandlers,
        handleOpenProject,
        handleCreateSessionFromWorkspaceScope,
        handleCreateSessionInSection,
        handleRemoveSection,
        handleArchiveSection,
        handleAddFolderToWorkspace,
        handleRenameSection,
        handleChangeSectionIcon,
        sectionFactsByGroupKey,
        handleRenameWorkspace,
        handleResetWorkspaceName,
        handleToggleCollapse,
        projectHeaderViewModelByGroupKey,
        renderModels.hasMultipleMachines,
        renderModels.audience,
        rowInteractions.dropOverlayShared,
        rowInteractions.handleFolderHeaderTreeDropResult,
        rowInteractions.handleDragCancel,
        rowInteractions.handleDragStart,
        rowInteractions.registerTreeRowBounds,
        rowInteractions.resolveTreeDropResult,
        rowInteractions.unregisterTreeRowBounds,
        newSessionEnabled,
        workspaceFaviconsEnabled,
        workspaceMachineSubtitlesEnabled,
    ]);

    const renderSessionItem = React.useCallback((
        item: Extract<SessionListIndexItem, { type: 'session' }>,
    ) => {
        const treeRowIdForItem = resolveTreeRowIdForSessionItem(item);
        const moveActionHandlers = getRowMoveActionHandlers({
            sourceRowId: treeRowIdForItem,
            sourceLabel: rowLabelByTreeRowId.get(treeRowIdForItem) ?? item.sessionId,
        });
        const canUseSessionFolders = resolveSessionListItemOrganizationEligibility(item, {
            foldersFeatureEnabled: isFolderActionsEnabledForServerId(item.serverId),
        }).canUseSessionFolders;
        const rowDragPolicy = resolveSessionListSessionRowDragPolicy({
            manualSessionOrderingEnabled: shellFlags.canReorderSessions,
            folderContainmentEnabled: shellFlags.canMoveSessionRowsBetweenFolders && canUseSessionFolders,
            // A live Home Session can be dropped on another to report to it; the drop rule checks
            // the person's rights and the tree against the latest Sessions.
            putUnderEnabled: Boolean(item.serverId) && item.archivedAt == null,
            item,
            layoutV1: sessionListLayoutChoice,
        });
        return (
            <SessionListRowViewModelBoundary
                audienceScope={item.serverId ? renderModels.audience.scopes.get(item.serverId) : undefined}
                homeObservation={item.serverId ? homeObservations[item.serverId] ?? null : null}
                audienceLabel={item.serverId ? renderModels.audience.labelsBySessionKey.get(audienceSessionAddressKey({ serverId: item.serverId, sessionId: item.sessionId })) : null}
                item={item}
                unscopedSelectionIsUnique={selectedSessionId === item.sessionId && unscopedSelectionIsUnique}
                rowHeight={densityViewState.rowHeight}
                dataActive={surfaceOwnership.dataActive}
                dragEnabled={rowDragPolicy.canDrag}
                treeRowId={treeRowIdForItem}
                onDragStart={rowInteractions.handleDragStart}
                resolveDropResult={rowInteractions.resolveTreeDropResult}
                onDropResult={rowInteractions.handleTreeDropResult}
                onDragCancel={rowInteractions.handleDragCancel}
                onTogglePinnedSessionKey={rowInteractions.handleTogglePinnedSessionKey}
                onSetTagsSessionKey={rowInteractions.handleSetTagsSessionKey}
                onNativeContextMenuOpenChangeSessionKey={rowInteractions.handleNativeContextMenuOpenChangeSessionKey}
                draggingSessionKey={rowInteractions.draggingSessionKey}
                draggingTreeRowId={rowInteractions.activeDragSnapshot?.source.sourceRowId ?? null}
                nativeContextMenuSessionKey={rowInteractions.nativeContextMenuSessionKey}
                overlayShared={rowInteractions.dropOverlayShared}
                onRegisterTreeRowBounds={rowInteractions.registerTreeRowBounds}
                onUnregisterTreeRowBounds={rowInteractions.unregisterTreeRowBounds}
                currentUserId={currentUserId}
                allKnownTags={allKnownTags}
                attentionStandingEnabled={attentionStanding.actionEnabled}
                attentionStandingPolicy={attentionStanding.policy}
                tagsEnabled={sessionTagsEnabled === true}
                activeColorMode={sessionListActiveColorMode === 'attentionOnly' || sessionListActiveColorMode === 'allActive'
                    ? sessionListActiveColorMode
                    : 'activityAndAttention'}
                compact={Boolean(densityViewState.compact)}
                compactMinimal={Boolean(densityViewState.compact && densityViewState.compactMinimal)}
                hideInactiveSessions={hideInactiveSessions === true}
                identityDisplay={sessionListIdentityDisplay === 'agentLogo' || sessionListIdentityDisplay === 'none'
                    ? sessionListIdentityDisplay
                    : 'avatar'}
                draftScope={draftScope}
                {...selectSessionListRowContextInput(item, {
                    enabled: sessionListRowContextV1 !== false,
                    identityDisplay: normalizeSessionListIdentityDisplay(sessionListIdentityDisplay),
                    projectDisplayByKey,
                    groupProjectByGroupKey,
                    statusWords: sessionListStatusWords === true,
                    faviconsEnabled: workspaceFaviconsEnabled,
                })}
                pinnedSessionKeys={orderingPersistenceState.pinnedKeySet}
                reachableSessionDisplay={(item.serverId ? renderModels.reachableSessionDisplayByKey.get(
                    audienceSessionAddressKey({ serverId: item.serverId, sessionId: item.sessionId }),
                ) : undefined) ?? renderModels.reachableSessionDisplayById.get(item.sessionId)}
                rowViewport={rowViewport}
                selectedSessionId={selectedSessionId}
                selectedSessionServerId={selectedSessionServerId}
                sessionTags={normalizedShellState.sessionTags}
                showPinnedServerBadge={shellFlags.showPinnedServerBadge}
                showServerBadge={shellFlags.showServerBadge}
                forkActionContext={forkActionContext}
                onMoveToFolder={canUseSessionFolders ? moveActionHandlers.onMoveToFolder : undefined}
                sectionMove={canUseSessionFolders ? moveActionHandlers.sectionMove : undefined}
                spaceMembership={moveActionHandlers.spaceMembership}
                onMoveToWorkspaceRoot={canUseSessionFolders ? moveActionHandlers.onMoveToWorkspaceRoot : undefined}
                onMoveUp={canUseSessionFolders && rowDragPolicy.canReorderSiblings ? moveActionHandlers.onMoveUp : undefined}
                onMoveDown={canUseSessionFolders && rowDragPolicy.canReorderSiblings ? moveActionHandlers.onMoveDown : undefined}
                onSetReportsCollapsed={handleSetReportsCollapsed}
            />
        );
    }, [
        handleSetReportsCollapsed,
        allKnownTags,
        attentionStanding.actionEnabled,
        attentionStanding.policy,
        currentUserId,
        densityViewState.compact,
        densityViewState.compactMinimal,
        densityViewState.rowHeight,
        draftScope,
        rowViewport,
        groupProjectByGroupKey,
        projectDisplayByKey,
        sessionListRowContextV1,
        sessionListStatusWords,
        workspaceFaviconsEnabled,
        selectedSessionId,
        selectedSessionServerId,
        isFolderActionsEnabledForServerId,
        forkActionContext,
        hideInactiveSessions,
        normalizedShellState.sessionTags,
        orderingPersistenceState.pinnedKeySet,
        homeObservations,
        renderModels.audience,
        renderModels.reachableSessionDisplayById,
        renderModels.reachableSessionDisplayByKey,
        rowInteractions.draggingSessionKey,
        rowInteractions.activeDragSnapshot,
        rowInteractions.dropOverlayShared,
        rowInteractions.handleDragCancel,
        rowInteractions.handleDragStart,
        rowInteractions.handleTreeDropResult,
        rowInteractions.handleNativeContextMenuOpenChangeSessionKey,
        rowInteractions.handleSetTagsSessionKey,
        rowInteractions.handleTogglePinnedSessionKey,
        rowInteractions.nativeContextMenuSessionKey,
        rowInteractions.registerTreeRowBounds,
        rowInteractions.resolveTreeDropResult,
        rowInteractions.unregisterTreeRowBounds,
        sessionTagsEnabled,
        sessionListActiveColorMode,
        sessionListIdentityDisplay,
        shellFlags.canMoveSessionRowsBetweenFolders,
        shellFlags.canReorderSessions,
        shellFlags.showPinnedServerBadge,
        shellFlags.showServerBadge,
        surfaceOwnership.dataActive,
        getRowMoveActionHandlers,
        rowLabelByTreeRowId,
        unscopedSelectionIsUnique,
    ]);

    const renderWorkflowRunItem = React.useCallback((item: Extract<SessionListIndexItem, { type: 'workflow_run' }>) => (
        <SessionListViewportWorkflowRunItem rowViewport={rowViewport} nodeId={buildSessionListIndexNodeId(item)}
            surfaceDataActive={surfaceOwnership.dataActive} runId={item.runId} serverId={item.serverId}
            density={densityViewState.compact ? densityViewState.compactMinimal ? 'minimal' : 'compact' : 'default'}
            selected={effectivePathname === `/workflows/runs/${encodeURIComponent(item.runId)}`}
            reportsDepth={item.reportsDepth} statusWords={sessionListStatusWords === true}
            activeColorMode={normalizeSessionListActiveColorMode(sessionListActiveColorMode)} />
    ), [densityViewState.compact, densityViewState.compactMinimal, effectivePathname, rowViewport, sessionListActiveColorMode, sessionListStatusWords, surfaceOwnership.dataActive]);

    const virtualizedNodeCacheRef = React.useRef(new Map<string, Readonly<{
        item: SessionListIndexItem;
        node: SessionListVirtualizedNode;
    }>>());
    const previousVirtualizedNodesRef = React.useRef<ReadonlyArray<SessionListVirtualizedNode>>([]);
    const showSessionSections = filterController.corpusStorage === 'active' && filterController.displayFilters.show !== 'runs';
    const virtualizedProjection = React.useMemo(() => {
        const previous = virtualizedNodeCacheRef.current;
        const next = new Map<string, Readonly<{
            item: SessionListIndexItem;
            node: SessionListVirtualizedNode;
        }>>();
        const nodes: SessionListVirtualizedNode[] = [];
        const visibleEntityIds = new Set<string>();
        let supportingSectionsInserted = !showSessionSections;
        renderedListItems.forEach((item, index) => {
            if (item.type !== 'header') visibleEntityIds.add(buildSessionListIndexEntityId(item));
            const attentionBand = item.type === 'header'
                ? item.headerKind === 'attention' || item.headerKind === 'working'
                : item.groupKind === 'attention' || item.groupKind === 'working';
            if (!supportingSectionsInserted && !attentionBand) {
                nodes.push(SESSION_LIST_SUPPORTING_SECTIONS_NODE);
                supportingSectionsInserted = true;
            }
            const id = buildSessionListIndexNodeId(item);
            const adjacency = item.type === 'workflow_run' ? resolveSessionListRowViewModelAdjacency(renderedListItems, index) : null;
            const isGroupTail = adjacency ? adjacency.isLast || adjacency.isSingle : undefined;
            const cached = previous.get(id);
            if (cached && areSessionListIndexItemsEqual(cached.item, item) && cached.node.isGroupTail === isGroupTail) {
                next.set(id, cached);
                nodes.push(cached.node);
            } else {
                const entry = {
                    item,
                    node: {
                        id,
                        kind: item.type,
                        ...(item.type === 'header' ? { headerKind: item.headerKind } : {}),
                        isGroupTail,
                    },
                };
                next.set(id, entry);
                nodes.push(entry.node);
            }
        });
        if (!supportingSectionsInserted) nodes.push(SESSION_LIST_SUPPORTING_SECTIONS_NODE);
        virtualizedNodeCacheRef.current = next;
        const previousNodes = previousVirtualizedNodesRef.current;
        const output = areVirtualizedNodeArraysReferenceEqual(previousNodes, nodes) ? previousNodes : nodes;
        previousVirtualizedNodesRef.current = output;
        return { nodes: output, visibleEntityCount: visibleEntityIds.size };
    }, [renderedListItems, showSessionSections]);
    const virtualizedNodes = virtualizedProjection.nodes;

    const nodeIds = React.useMemo(() => (
        virtualizedNodes.map((node) => node.id)
    ), [virtualizedNodes]);

    const nodeById = React.useMemo(() => {
        const map = new Map<string, SessionListIndexItem>();
        for (const item of renderedListItems) {
            map.set(buildSessionListIndexNodeId(item), item);
        }
        return map;
    }, [renderedListItems]);

    const nodeByIdRef = React.useRef(nodeById);
    nodeByIdRef.current = nodeById;
    const viewabilityConfigRef = React.useRef({ itemVisiblePercentThreshold: 1 });
    const handleViewableItemsChangedRef = React.useRef((info: { viewableItems: ViewToken[] }) => {
        if (!surfaceDataActiveRef.current) return;
        const nextKeys = new Set<string>();
        for (const token of info.viewableItems) {
            if (token.isViewable === false) continue;
            const node = token.item as SessionListVirtualizedNode | undefined;
            const item = node ? nodeByIdRef.current.get(node.id) ?? null : null;
            if (!item || item.type === 'header') continue;
            if (item.type === 'workflow_run') { nextKeys.add(buildSessionListIndexNodeId(item)); continue; }
            nextKeys.add(resolveSessionListRowStoreScopeKey(item));
        }
        const previousKeys = viewableSessionRowKeysRef.current;
        if (stringSetsEqual(previousKeys, nextKeys)) return;
        if (syncPerformanceTelemetry.isEnabled()) {
            syncPerformanceTelemetry.count('ui.sessionsList.viewableRows.changed', {
                changed: 1,
                nextVisibleRows: nextKeys.size,
                previousKnown: previousKeys === null ? 0 : 1,
                previousVisibleRows: previousKeys?.size ?? 0,
            });
        }
        viewableSessionRowKeysRef.current = nextKeys;
        setViewableSessionRowKeys((current) => {
            if (stringSetsEqual(current, nextKeys)) return current;
            return nextKeys;
        });
    });
    const listItemsRef = React.useRef(renderedListItems);
    listItemsRef.current = renderedListItems;
    const renderHeaderItemRef = React.useRef(renderHeaderItem);
    renderHeaderItemRef.current = renderHeaderItem;
    const renderSessionItemRef = React.useRef(renderSessionItem);
    renderSessionItemRef.current = renderSessionItem;
    const renderWorkflowRunItemRef = React.useRef(renderWorkflowRunItem);
    renderWorkflowRunItemRef.current = renderWorkflowRunItem;
    const allKnownTagsSignature = React.useMemo(() => buildStringListSignature(allKnownTags), [allKnownTags]);
    // Row labels are not cell inputs here: a Session row's label is its own id and a header's is its own
    // title, both already in that row's node, so a reorder must not redraw every mounted cell.
    const attentionStandingSignature = React.useMemo(
        () => buildAttentionStandingSignature(attentionStanding.policy),
        [attentionStanding.policy],
    );
    const sessionTagsSignature = React.useMemo(
        () => buildStringArrayRecordSignature(normalizedShellState.sessionTags),
        [normalizedShellState.sessionTags],
    );
    const workspaceLabelsSignature = React.useMemo(
        () => buildStringRecordSignature(normalizedShellState.workspaceLabels),
        [normalizedShellState.workspaceLabels],
    );
    const virtualizedRowExtraData = React.useMemo(() => ({
        allKnownTagsSignature,
        attentionStandingEnabled: attentionStanding.actionEnabled,
        attentionStandingSignature,
        audience: renderModels.audience,
        canDragSessionRows: shellFlags.canDragSessionRows,
        canMoveSessionRowsBetweenFolders: shellFlags.canMoveSessionRowsBetweenFolders,
        canReorderSessions: shellFlags.canReorderSessions,
        compact: Boolean(densityViewState.compact),
        compactMinimal: Boolean(densityViewState.compact && densityViewState.compactMinimal),
        currentUserId,
        draftScope,
        dragSnapshotId: frozenListProjection.snapshotId,
        draggingSessionKey: rowInteractions.draggingSessionKey,
        folderActionsEnabled,
        forkActionContext,
        hasMultipleMachines: renderModels.hasMultipleMachines,
        homeObservations,
        nativeContextMenuSessionKey: rowInteractions.nativeContextMenuSessionKey,
        pinnedSessionKeys: orderingPersistenceState.pinnedKeySet,
        reachableSessionDisplayById: renderModels.reachableSessionDisplayById,
        reachableSessionDisplayByKey: renderModels.reachableSessionDisplayByKey,
        rowHeight: densityViewState.rowHeight,
        selectedSessionId,
        selectedSessionServerId,
        sessionFoldersSignature,
        sessionListActiveColorMode: sessionListActiveColorMode === 'attentionOnly' || sessionListActiveColorMode === 'allActive'
            ? sessionListActiveColorMode
            : 'activityAndAttention',
        sessionListHideInactiveSessions: hideInactiveSessions === true,
        sessionListIdentityDisplay: sessionListIdentityDisplay === 'agentLogo' || sessionListIdentityDisplay === 'none'
            ? sessionListIdentityDisplay
            : 'avatar',
        sessionListSurfaceDataActive: surfaceOwnership.dataActive,
        // Mounted Section headers read these facts, so a member's move redraws the count with its row.
        sectionFactsByGroupKey,
        // Row-context inputs (P5 U5): mounted cells redraw only when extraData changes, so every
        // choice and Project display the row context reads is here, or a toggle shows after reload.
        rowContextEnabled: sessionListRowContextV1 !== false,
        rowContextIdentityDisplay: normalizeSessionListIdentityDisplay(sessionListIdentityDisplay),
        rowContextProjectState: renderModels.projectHeaderViewModelState,
        rowContextStatusWords: sessionListStatusWords === true,
        sessionTagsEnabled: sessionTagsEnabled === true,
        sessionTagsSignature,
        workspaceLabelsSignature,
    }), [
        sectionFactsByGroupKey,
        allKnownTagsSignature,
        attentionStanding.actionEnabled,
        attentionStandingSignature,
        currentUserId,
        densityViewState.compact,
        densityViewState.compactMinimal,
        densityViewState.rowHeight,
        draftScope,
        frozenListProjection.snapshotId,
        folderActionsEnabled,
        forkActionContext,
        hideInactiveSessions,
        homeObservations,
        orderingPersistenceState.pinnedKeySet,
        renderModels.audience,
        renderModels.hasMultipleMachines,
        renderModels.projectHeaderViewModelState,
        renderModels.reachableSessionDisplayById,
        renderModels.reachableSessionDisplayByKey,
        rowInteractions.draggingSessionKey,
        rowInteractions.nativeContextMenuSessionKey,
        sessionListRowContextV1,
        sessionListStatusWords,
        selectedSessionId,
        selectedSessionServerId,
        sessionListActiveColorMode,
        sessionListIdentityDisplay,
        sessionFoldersSignature,
        surfaceOwnership.dataActive,
        sessionTagsEnabled,
        sessionTagsSignature,
        shellFlags.canDragSessionRows,
        shellFlags.canMoveSessionRowsBetweenFolders,
        shellFlags.canReorderSessions,
        workspaceLabelsSignature,
    ]);

    const renderVirtualizedItem = React.useCallback((params: { item: SessionListVirtualizedNode; index: number }) => {
        if (params.item.kind === 'supporting_sections') return null;
        const item = nodeByIdRef.current.get(params.item.id) ?? listItemsRef.current[params.index] ?? null;
        if (!item) return null;
        if (item.type === 'header') return renderHeaderItemRef.current(item, item === listItemsRef.current[0]);
        if (item.type === 'workflow_run') return renderWorkflowRunItemRef.current(item);
        return renderSessionItemRef.current(item);
    }, []);
    const handleTreeViewportLayout = React.useCallback((event: { nativeEvent?: { layout?: { y?: number; height?: number } } }) => {
        rowInteractions.handleTreeListLayout(event);
        rowInteractions.handleTreeViewportMeasure(treeViewportRef.current);
    }, [rowInteractions]);
    const keyboardZoneProps = React.useMemo(() => (
        Platform.OS === 'web'
            ? {
                testID: 'sessions-list-keyboard-zone',
                tabIndex: 0,
                ...attentionInteraction?.zoneProps,
                onFocus: (event: Parameters<SessionListAttentionInteraction['zoneProps']['onFocus']>[0]) => {
                    attentionInteraction?.zoneProps.onFocus(event);
                    sessionListKeyboardFocusedRef.current = true;
                    setSessionListKeyboardFocused(true);
                },
                onBlur: (event: Parameters<SessionListAttentionInteraction['zoneProps']['onBlur']>[0]) => {
                    if (event.currentTarget?.contains?.(event.relatedTarget ?? event.nativeEvent?.relatedTarget)) return;
                    attentionInteraction?.zoneProps.onBlur(event);
                    sessionListKeyboardFocusedRef.current = false;
                    setSessionListKeyboardFocused(false);
                    visibleCursorOccurrenceKeyRef.current = null;
                    sessionListSelectionStore.setFocusedKey(null);
                },
                onKeyDown: handleSessionListKeyDown,
            } as const
            : {
                onTouchStart: attentionInteraction?.zoneProps.onTouchStart,
                onTouchEnd: attentionInteraction?.zoneProps.onTouchEnd,
                onTouchCancel: attentionInteraction?.zoneProps.onTouchCancel,
            }
    ), [attentionInteraction, handleSessionListKeyDown, sessionListSelectionStore]);

    const sectionDraftOpen = sectionDraft.draft !== null;
    const sectionDraftAnchor = React.useMemo(
        () => sectionDraftOpen ? resolveSessionSectionDraftAnchor(renderedListItems, {
            serverId: sectionDraft.draft?.serverId ?? null, sections: organizationListViewState.sections,
        }) : null,
        [organizationListViewState.sections, renderedListItems, sectionDraft.draft?.serverId, sectionDraftOpen],
    );
    const openNewSection = React.useCallback(() => { void handleCreateSection(activeOrganizationServerId); },
        [activeOrganizationServerId, handleCreateSection]);
    const sectionDraftController = React.useMemo((): SessionSectionDraftController => ({
        draft: sectionDraft.draft,
        anchor: sectionDraftAnchor,
        request: requestNewSection,
        openNew: openNewSection,
        submit: sectionDraft.submit,
        cancel: sectionDraft.cancel,
    }), [openNewSection, requestNewSection, sectionDraft.cancel, sectionDraft.draft, sectionDraft.submit, sectionDraftAnchor]);

    return {
        externalStatusDemand,
        sectionDraftController,
        nodes: virtualizedNodes,
        nodeIds,
        visibleEntityCount: virtualizedProjection.visibleEntityCount,
        rowHeight: densityViewState.rowHeight,
        rowDensity: (densityViewState.compact
            ? (densityViewState.compactMinimal ? 'minimal' : 'compact')
            : 'default') as 'default' | 'compact' | 'minimal',
        filteredNoResultsMessage,
        renderVirtualizedItem,
        scrollToOffset: scrollToRetainedOffset,
        scrollToIndex: scrollToRetainedIndex,
        measureNodeViewportOffset: measureVirtualizedNodeViewportOffset,
        virtualizedRowExtraData,
        onViewableItemsChanged: handleViewableItemsChangedRef.current,
        viewabilityConfig: viewabilityConfigRef.current,
        virtualizedListRef,
        treeViewportRef,
        onTreeScroll: rowInteractions.handleTreeScroll,
        onNativeListScrollInteractionStart: rowInteractions.handleNativeListScrollInteractionStart,
        onNativeListScrollInteractionEnd: rowInteractions.handleNativeListScrollInteractionEnd,
        onTreeViewportLayout: handleTreeViewportLayout,
        onTreeContentSizeChange: rowInteractions.handleTreeContentSizeChange,
        onRegisterTreeRowBounds: rowInteractions.registerTreeRowBounds,
        onUnregisterTreeRowBounds: rowInteractions.unregisterTreeRowBounds,
        searchChrome,
        keyboardZoneProps,
        sessionListSelectionStore,
        sessionListSelectionTargetsByKey,
        sessionListBulkActionContext,
        onRequestBulkMoveToFolder: folderActionsEnabled ? handleRequestBulkMoveToFolder : undefined,
        tagsEnabled: sessionTagsEnabled === true,
        dropOverlayShared: rowInteractions.dropOverlayShared,
        entityDragDrop: rowInteractions.entityDragDrop,
        stagedMove: rowInteractions.stagedMove,
    };
}

/**
 * Publishes which visible external Sessions need live status. It is the only reader of those rows'
 * content in the list, so a session write re-renders this leaf (which renders nothing) and not the list.
 */
export const SessionListExternalStatusDemandPublisher = React.memo(function SessionListExternalStatusDemandPublisher(props: Readonly<{
    items: ReadonlyArray<Extract<SessionListIndexItem, { type: 'session' }>>;
    viewportId: string;
    visibleRowKeys: ReadonlySet<string> | null;
}>) {
    const rowRenderableByKey = useSessionListRowRenderablesForItems(props.items);
    React.useEffect(() => {
        const entries = collectExternalSessionStatusDemandViewportEntries({
            activeServerId: getActiveServerSnapshot().serverId,
            renderedListItems: props.items,
            resolveRowRenderable: (rowKey) => rowRenderableByKey.get(rowKey) ?? null,
            visibleRowKeys: props.visibleRowKeys,
        });
        replaceExternalSessionStatusDemandViewport(props.viewportId, entries);
    }, [props.items, props.viewportId, props.visibleRowKeys, rowRenderableByKey]);
    React.useEffect(() => () => {
        replaceExternalSessionStatusDemandViewport(props.viewportId, []);
    }, [props.viewportId]);
    return null;
});

/** A Run row reads its own viewability, so scrolling redraws only the rows that entered or left. */
function SessionListViewportWorkflowRunItem(props: Omit<WorkflowRunItemProps, 'kind' | 'dataActive'> & Readonly<{
    rowViewport: SessionListRowViewport;
    nodeId: string;
    surfaceDataActive: boolean;
}>) {
    const { rowViewport, nodeId, surfaceDataActive, ...itemProps } = props;
    const viewable = useSessionListRowViewportFact(rowViewport, 'viewable', nodeId);
    return <SessionItem kind="workflow_run" {...itemProps} dataActive={surfaceDataActive && viewable} />;
}
