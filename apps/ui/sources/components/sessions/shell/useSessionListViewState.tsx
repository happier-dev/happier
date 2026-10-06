import { resolveNewSessionGroupTarget } from './resolveSessionListHeaderActionHandlers';
import {
    normalizeSessionAddress,
    sessionAddressKey as audienceSessionAddressKey,
} from '@/sync/domains/session/sessionAddress';
import * as React from 'react';
import { Platform, type ViewToken } from 'react-native';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1 } from '@happier-dev/protocol';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveWorkflowRunParentSessionId } from '@/sync/domains/session/listing/nestSessionListReports';
import {
    useSetting,
    useSettingMutable,
    useMachineDisplayById,
    useProfile,
    useLocalSetting,
    useLocalSettingMutable,
    useSessionListRowRenderablesForItems,
    useSessionOrganizationProjections,
} from '@/sync/domains/state/storage';
import { useIsTablet } from '@/utils/platform/responsive';
import { useSessionListSelectionState } from '@/hooks/session/useSessionListSelectionState';
import { getAllKnownTags, getTagsForSession, sessionTagKey } from './sessionTagUtils';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { resolveSessionListShellFlags } from './resolveSessionListShellFlags';
import { resolveSessionListDensityViewState } from './resolveSessionListDensityViewState';
import { resolveSessionListOrderingPersistenceState } from './resolveSessionListOrderingPersistenceState';
import { SessionListHeaderItem } from './sessionListHeaderItem';
import { SessionListRowViewModelBoundary } from './SessionListRowViewModelBoundary';
import { SessionItem } from './SessionItem';
import { resolveSessionListRowViewModelAdjacency } from './sessionListRowViewModels';
import { useSessionListRenderModels } from './useSessionListRenderModels';
import { useSessionListSearchTextByKey } from './useSessionListSearchTextByKey';
import { useSessionListNavigationActions } from './useSessionListNavigationActions';
import { useSessionListRowInteractions } from './useSessionListRowInteractions';
import { readSessionListDestinationIntent } from './useSessionListEntityDragDrop';
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
} from '@/sync/domains/session/sessionSurfaceVisibility';
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
    normalizeSessionListSectionModeV1,
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
    requireSessionOrganizationMutationScope,
    writeSessionOrganizationFolderAssignment,
    writeSessionOrganizationPin,
    writeSessionOrganizationTagLabels,
    type SessionOrganizationMutationScope,
} from '@/sync/ops/sessionOrganization';
import {
    sessionArchiveWithServerScope,
    sessionSetManualReadStateWithServerScope,
    sessionStopWithServerScope,
    sessionUnarchiveWithServerScope,
} from '@/sync/ops';
import {
    clearSessionVisibleWhenInactive,
    stopSessionAndMaybeArchive,
} from '../sessionStopArchiveFlow';
import {
    buildSessionFolderMoveTargets,
    compareSessionFolderWorkspaceRefs,
    createSessionFolder,
    deleteSessionFolder,
    renameSessionFolder,
    selectAvailableSessionFolders,
    type SessionFolderMoveTarget,
    type SessionFolderWorkspaceRefV1,
    resolveDurableWorkspaceRefForSessionListHeader,
    type SessionFoldersV1,
} from '@/sync/domains/session/folders';
import { openSessionFolderSelection } from '@/components/sessions/organization/SessionFolderSelection';
import {
    buildSessionOrganizationListViewStateForServers,
    completeSessionOrganizationOrderItemAddresses,
} from '@/sync/domains/session/organization/viewState';
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
import { deleteSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
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
} from './selection/sessionListSelectionKeys';
import {
    useSessionListSelectionController,
} from './selection/SessionListSelectionContext';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { transcriptSearchUnavailableHint } from '@/components/appShell/search/transcriptSearchUnavailableHint';
import { SessionListFilterControl } from './search/SessionListFilterControl';
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
const EMPTY_SESSION_FOLDER_MOVE_TARGETS: readonly SessionFolderMoveTarget[] = [];

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
    return serverId ? treeRowId.session(serverId, sessionId) : `session:${sessionId}`;
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
    const entry = knownSessionEntries.find((candidate) => candidate.sessionKey === sessionKey);
    return entry?.serverId ? treeRowId.session(entry.serverId, entry.sessionId) : null;
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

export function buildSessionFolderMoveTargetSignature(
    foldersSignature: string,
    workspace: SessionFolderWorkspaceRefV1,
    folderId: string | null | undefined,
): string {
    return JSON.stringify([
        foldersSignature,
        buildSessionFolderWorkspaceSignature(workspace),
        folderId ?? '',
    ]);
}

function buildRowLabelSignature(labels: ReadonlyMap<string, string>): string {
    if (labels.size === 0) return '';
    return JSON.stringify(Array.from(labels.entries()));
}

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
    pathname?: string;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
    corpusStorage?: SessionListCorpusStorage;
    viewContext?: SessionListViewContext;
}>;

export function useSessionListViewState(
    storageKind: SessionListStorageFilter,
    options: SessionListViewStateOptions = {},
) {
    const surfaceOwnership = normalizeSessionListSurfaceOwnership(options.surfaceOwnership);
    const filterController = useSessionListViewFilterController(
        options.corpusStorage ?? 'active',
        options.viewContext,
    );
    const effectiveStorageKind = filterController.sourceAvailable ? filterController.filters.source : 'persisted';
    const sessionListPaneState = useVisibleSessionListPaneState(effectiveStorageKind, {
        pathname: options.pathname,
        sessionListSurfaceDataActive: surfaceOwnership.dataActive,
        queryHomes: filterController.pagingHomes,
        emptyQuerySelectionComplete: filterController.emptyQuerySelectionComplete,
        corpusStorage: options.corpusStorage ?? 'active',
    });
    return useSessionListViewStateFromPaneState(effectiveStorageKind, sessionListPaneState, filterController, {
        ...options,
        surfaceOwnership,
    });
}

export function useSessionListViewStateFromPaneState(
    storageKind: SessionListStorageFilter,
    sessionListPaneState: VisibleSessionListPaneState,
    filterController: SessionListViewFilterController,
    options: SessionListViewStateOptions = {},
) {
    const pathname = usePathname();
    const effectivePathname = options.pathname ?? pathname;
    const surfaceOwnership = normalizeSessionListSurfaceOwnership(options.surfaceOwnership);
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
    const [sessionListOrderingModeV1] = useSettingMutable('sessionListOrderingModeV1');
    const sessionListSectionModeV1 = normalizeSessionListSectionModeV1(useSetting('sessionListSectionModeV1'));
    const sessionListActiveGroupingV1 = useSetting('sessionListActiveGroupingV1');
    const sessionListInactiveGroupingV1 = useSetting('sessionListInactiveGroupingV1');
    const sessionListLayoutChoice = useSessionListLayoutChoice();
    const sessionListFolderSortModeV1 = useSetting('sessionListFolderSortModeV1') === 'mixed' ? 'mixed' : 'foldersFirst';
    const sessionFolderViewModeV1 = useSetting('sessionFolderViewModeV1') === 'tree' ? 'tree' : 'off';
    const sessionTagsEnabled = useSetting('sessionTagsEnabled');
    const workspaceRefsV1 = useSetting('workspaceRefsV1');
    const workspacePathDisplayModeV1 = useSetting('workspacePathDisplayModeV1');
    const workspaceFaviconsEnabled = useSetting('workspaceFaviconsEnabled') !== false;
    const workspaceMachineSubtitlesEnabled = useSetting('workspaceMachineSubtitlesEnabled') !== false;
    const [collapsedGroupKeysV1, setCollapsedGroupKeysV1] = useLocalSettingMutable('collapsedGroupKeysV1');
    const sessionMruOrderV1 = useLocalSetting('sessionMruOrderV1');
    const [sessionListFocusedFolderV1, setSessionListFocusedFolderV1] = useLocalSettingMutable('sessionListFocusedFolderV1');
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
        activeGroupingV1: sessionListActiveGroupingV1,
        inactiveGroupingV1: sessionListInactiveGroupingV1,
        folderViewModeV1: sessionFolderViewModeV1,
        foldersFeatureEnabled: folderActionsEnabled,
    });
    const sessionListDensity = useSetting('sessionListDensity');
    const uiFontScale = useLocalSetting('uiFontScale');
    const sessionListWorkingIndicatorStyle = useSetting('sessionListNarrowWorkingIndicatorStyle');
    const sessionListWorkingStatusAnimatedTextEnabled = useSetting('sessionListWorkingStatusAnimatedTextEnabled');
    const sessionListIdentityDisplay = useSetting('sessionListIdentityDisplay');
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
    const profile = useProfile();
    const draftScope = useActiveServerAccountScope();
    const navigateToSession = useNavigateToSession();
    const { openMoveSheet } = useSessionListMoveSheet();
    const sessionListA11y = useSessionListA11yAnnouncements();
    const densityViewState = resolveSessionListDensityViewState(sessionListDensity, {
        isTablet,
        platform: Platform.OS,
        uiFontScale,
    });
    const currentUserId = typeof profile?.id === 'string' ? profile.id : null;
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
    const machineDisplayById = useMachineDisplayById();
    const renderMachineDisplayById = machineDisplayById;
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
        sessionListOrderingModeV1,
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
        const scope = await getAvailableOrganizationMutationScope(target.serverId ?? null);
        await writeSessionOrganizationPin({
            scope,
            sessionId: target.sessionId,
            pinned,
        });
    }, [getAvailableOrganizationMutationScope]);
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
    const homeObservations = useSessionListHomeObservations(
        renderPaneState.query?.active === true ? renderPaneState.query.statesByServerId : undefined,
    );
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
    const { setSessionListGroupOrderV1, setSessionWorkspaceOrderV1, setSessionFoldersV1 } = useSessionListOrganizationWriters({
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
    // The navigation actions are rebuilt each render; the scope menu keeps one stable handler so the
    // memoized filter control does not rebuild with them.
    const openArchivedSessionsRef = React.useRef(handleOpenArchivedSessions);
    openArchivedSessionsRef.current = handleOpenArchivedSessions;
    const handleOpenArchivedFromScopeMenu = React.useCallback(() => {
        openArchivedSessionsRef.current();
    }, []);

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
        paneState: renderPaneState,
        collapsedGroupKeys: normalizedShellState.collapsedGroupKeys,
        machineDisplayById: renderMachineDisplayById,
        workspaceLabels: normalizedShellState.workspaceLabels,
        workspaceRefs: normalizedShellState.workspaceRefs,
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
        workingIndicatorMode: sessionListWorkingIndicatorStyle === 'pulse' ? 'pulse' : 'spinner',
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
        workingTextMode: sessionListWorkingStatusAnimatedTextEnabled === false ? 'static' : 'animated',
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
    // The scope editor states how many work items these choices show: the list's own selection-scope
    // rows (every matching row, including those inside collapsed groups), never a second derivation.
    const filterResultCount = renderModels.selectionScopeListItems.filter((item) => item.type !== 'header').length;
    // The filter editor is the only host of `Hide inactive sessions`, Source, Homes
    // and Tags, so it stays mounted for every corpus. Each section is individually
    // availability-gated inside the editor model, and the control's own
    // `legacy_owner_or_direct` label already names a corpus with no semantic query.
    const filterControl = React.useMemo(() => (
        <SessionListFilterControl
            controller={filterController}
            organizationProjectionsByServerId={organizationProjectionsByServerId}
            onOpenArchived={filterController.corpusStorage === 'active' ? handleOpenArchivedFromScopeMenu : undefined}
            resultCount={filterResultCount}
        />
    ), [
        filterController,
        filterResultCount,
        handleOpenArchivedFromScopeMenu,
        organizationProjectionsByServerId,
    ]);
    const searchChrome = React.useMemo(() => ({
        filterControl,
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
            const scope = await getAvailableOrganizationMutationScope(target.serverId);
            await writeSessionOrganizationPin({
                scope,
                sessionId: target.sessionId,
                pinned,
            });
        });
    }, [getAvailableOrganizationMutationScope, resolveOrganizationTargetForSessionKey, runOrganizationMutation]);
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

    const visibleCursorSessionKeyRef = React.useRef<string | null>(null);
    const mruCursorSessionKeyRef = React.useRef<string | null>(null);
    const sessionListKeyboardFocusedRef = React.useRef(false);
    const [sessionListKeyboardFocused, setSessionListKeyboardFocused] = React.useState(false);
    const visibleSessionSelectionKeys = React.useMemo(
        () => readSessionListSelectionKeysFromVisibleEntries(visibleSessionNavigationEntries),
        [visibleSessionNavigationEntries],
    );
    const selectionScopeSelectionKeys = React.useMemo(
        () => readSessionListSelectionKeysFromVisibleEntries(selectionScopeSessionNavigationEntries),
        [selectionScopeSessionNavigationEntries],
    );
    const focusedFolderId = renderPaneState.folderFocus?.folder.id ?? sessionListFocusedFolderV1?.folderId ?? null;
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
        focusedFolderId,
        includeInactive: filterController.includeInactive,
    }), [
        filterController.filters,
        filterController.homeOptions,
        filterController.includeInactive,
        focusedFolderId,
        storageKind,
    ]);
    const sessionListSelectionStore = useSessionListSelectionController({
        scopeKey: sessionListSelectionScopeKey,
        visibleOrderedKeys: visibleSessionSelectionKeys,
        eligibleKeys: selectionScopeSelectionKeys,
        enabled: surfaceOwnership.interactive,
    });
    const sessionListSelectionSnapshot = React.useSyncExternalStore(
        sessionListSelectionStore.subscribe,
        sessionListSelectionStore.getSnapshot,
        sessionListSelectionStore.getSnapshot,
    );
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
        void navigateToSession(target.sessionId, target.serverId ? { serverId: target.serverId } : undefined);
    }, [navigateToSession]);
    const handleVisibleSessionShortcut = React.useCallback((direction: 'previous' | 'next') => {
        const target = resolveVisibleSessionNavigation({
            visibleEntries: visibleSessionNavigationEntries,
            activeSessionKey,
            cursorSessionKey: visibleCursorSessionKeyRef.current,
            direction,
        });
        if (!target) return;
        visibleCursorSessionKeyRef.current = target.sessionKey;
        navigateToSessionTarget(target);
    }, [activeSessionKey, navigateToSessionTarget, visibleSessionNavigationEntries]);
    const handleMruSessionShortcut = React.useCallback((direction: 'previous' | 'next') => {
        const currentOrder = Array.isArray(sessionMruOrderV1) ? sessionMruOrderV1 : [];
        const order = moveSessionMruEntryToFront({
            order: currentOrder,
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
    }, [activeSessionKey, knownSessionEntries, navigateToSessionTarget, sessionMruOrderV1]);
    const resolveSelectionKeyboardCurrentKey = React.useCallback(() => {
        const snapshot = sessionListSelectionStore.getSnapshot();
        return snapshot.focusedKey
            ?? snapshot.anchorKey
            ?? activeSessionKey
            ?? visibleSessionSelectionKeys[0]
            ?? null;
    }, [activeSessionKey, sessionListSelectionStore, visibleSessionSelectionKeys]);
    const handleSessionSelectionToggleFocused = React.useCallback(() => {
        const currentKey = resolveSelectionKeyboardCurrentKey();
        if (!currentKey) return;
        sessionListSelectionStore.toggle(currentKey);
    }, [resolveSelectionKeyboardCurrentKey, sessionListSelectionStore]);
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
        if (snapshot.selectedKeys.size === 0 || snapshot.anchorKey == null) {
            sessionListSelectionStore.replaceWith(currentKey);
        }
        sessionListSelectionStore.selectRange(targetKey);
    }, [resolveSelectionKeyboardCurrentKey, sessionListSelectionStore, visibleSessionSelectionKeys]);
    const handleSessionListKeyDown = React.useCallback((event: any) => {
        if (!surfaceOwnership.interactive) return;
        if (event?.altKey !== true) return;

        const key = String(event?.key ?? '');
        const target = key === 'ArrowDown'
            ? resolveVisibleSessionNavigation({
                visibleEntries: visibleSessionNavigationEntries,
                activeSessionKey,
                cursorSessionKey: visibleCursorSessionKeyRef.current,
                direction: 'next',
            })
            : key === 'ArrowUp'
                ? resolveVisibleSessionNavigation({
                    visibleEntries: visibleSessionNavigationEntries,
                    activeSessionKey,
                    cursorSessionKey: visibleCursorSessionKeyRef.current,
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
        visibleCursorSessionKeyRef.current = target.sessionKey;
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
        folderActionsEnabled: Boolean(folderActionsEnabled),
        isFolderActionsEnabledForServerId,
        sessionFoldersV1: availableSessionFoldersV1,
        listItems: renderModels.listItems,
        currentGroupOrderMap: orderingPersistenceState.currentGroupOrderMap,
        currentWorkspaceOrderMap,
        sessionListFolderSortModeV1,
        sessionListOrderingModeV1,
        sessionListSectionModeV1,
        manualSessionOrderingEnabled: shellFlags.canReorderSessions,
        setSessionListGroupOrderV1,
        setSessionWorkspaceOrderV1,
        setSessionFoldersV1,
        pinnedKeySet: orderingPersistenceState.pinnedKeySet,
        sessionTags: normalizedShellState.sessionTags,
        setSessionPinForKey: setSessionPinForSessionKey,
        setSessionTagsForKey: setSessionTagsForSessionKey,
        scrollToOffset: scrollToTreeOffset,
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
    const sessionListItemBySelectionKey = React.useMemo(() => {
        const map = new Map<string, Extract<SessionListIndexItem, { type: 'session' }>>();
        for (const item of renderedListItems) {
            if (item.type !== 'session') continue;
            map.set(buildServerScopedSessionKey(item.sessionId, item.serverId), item);
        }
        return map;
    }, [renderedListItems]);
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

        const loadedItems: Array<Extract<SessionListIndexItem, { type: 'session' }>> = [];
        for (const item of renderedListItems) {
            if (item.type !== 'session') continue;
            loadedItems.push(item);
            if (loadedItems.length >= EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1) break;
        }
        return loadedItems;
    }, [renderedListItems, sessionListItemBySelectionKey, viewableSessionRowKeys]);
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
            && sessionListSelectionSnapshot.selectedKeys.has(buildServerScopedSessionKey(item.sessionId, item.serverId))
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
            const rowKey = resolveSessionListRowStoreScopeKey({
                sessionId: item.sessionId,
                serverId: item.serverId ?? null,
            });
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

    const handleMoveSessionToFolder = React.useCallback(async (sessionId: string, serverId: string, folderId: string | null) => {
        await rowInteractions.moveToFolder(serverId, sessionId, folderId);
    }, [rowInteractions.moveToFolder]);

    const openMoveSheetForTreeRow = React.useCallback(async (sourceRowId: string, sourceLabel: string) => {
        let source: ReturnType<typeof rowInteractions.prepareTreeRowSource>;
        try { source = rowInteractions.prepareTreeRowSource(sourceRowId); } catch { return; }
        if (!source) return;
        try {
            await openMoveSheet({ sourceLabel, runtime: rowInteractions.entityDragDrop.runtime, sourceId: source.sourceId });
        } finally { source.dispose(); }
    }, [openMoveSheet, rowInteractions.entityDragDrop.runtime, rowInteractions.prepareTreeRowSource]);

    const moveTreeRowToWorkspaceRoot = React.useCallback((sourceRowId: string, sourceLabel: string) => {
        const scope = rowInteractions.entityDragDrop.scope;
        if (!scope) return;
        const source = rowInteractions.prepareTreeRowSource(sourceRowId);
        if (!source) return;
        const runtime = rowInteractions.entityDragDrop.runtime;
        const destination = runtime.getDestinations(source.sourceId).find(entry => {
            return entry.targetId === rowInteractions.entityDragDrop.targetId
                && readSessionListDestinationIntent(entry.destination, scope)?.instructionKind === 'move-to-root';
        });
        if (!destination || destination.admission.status !== 'allowed') { source.dispose(); return; }
        const intent = readSessionListDestinationIntent(destination.destination, scope);
        void runtime.perform(source.sourceId, destination.targetId, destination.destination, 'chooser').then(outcome => {
            if (outcome?.status === 'applied' && typeof intent?.containerId === 'string') sessionListA11y.announceDropResult({ label: sourceLabel,
                destinationLabel: t('sessionsList.moveToWorkspaceRoot'), result: { instruction: { kind: 'move-to-root',
                    containerId: intent.containerId, rootId: intent.containerId, depth: 0 }, visual: { kind: 'none' } } });
        }).finally(source.dispose);
    }, [rowInteractions.entityDragDrop.runtime, rowInteractions.entityDragDrop.scope, rowInteractions.entityDragDrop.targetId, rowInteractions.prepareTreeRowSource, sessionListA11y]);

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
    }, [resolveDropResultDestinationLabel, rowInteractions, sessionListA11y]);
    const getRowMoveActionHandlers = useSessionListRowMoveActionHandlers({
        openMoveSheetForTreeRow,
        moveTreeRowToWorkspaceRoot,
        moveTreeRowByKeyboard,
        handleMoveSessionToFolder,
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
        workspaceRefs: normalizedShellState.workspaceRefs,
        collapsedGroupKeys: normalizedShellState.collapsedGroupKeys,
        setCollapsedGroupKeys: setCollapsedGroupKeysV1,
    });

    const handleAddFolderToWorkspace = React.useCallback(async (item: Extract<SessionListIndexItem, { type: 'header' }>) => {
        const workspace = resolveDurableWorkspaceRefForSessionListHeader(item);
        if (!workspace) return;
        const name = await Modal.prompt(
            t('sessionsList.addFolder'),
            undefined,
            {
                defaultValue: t('sessionsList.newFolderDefaultName'),
                placeholder: t('sessionsList.folderNamePlaceholder'),
            },
        );
        if (name == null) return;
        const created = createSessionFolder({
            current: availableSessionFoldersV1,
            workspace,
            renderWorkspaceKey: item.workspaceKey,
            parentId: null,
            name,
            now: Date.now(),
        });
        runOrganizationMutation(async () => setSessionFoldersV1(created.next, await getAvailableOrganizationMutationScope(workspace.serverId)));
    }, [availableSessionFoldersV1, getAvailableOrganizationMutationScope, runOrganizationMutation, setSessionFoldersV1]);

    const handleFocusSessionFolder = React.useCallback((item: Extract<SessionListIndexItem, { type: 'header' }>) => {
        if (!item.folderId || !item.workspace) return;
        if (rowInteractions.consumeFolderFocusPressAfterDrag()) return;
        // The persisted focus record is Home-scoped (`SessionListFocusedFolderV1Schema`), so a
        // folder whose Home is not resolved yet has nothing to focus.
        const focusServerId = item.serverId ?? item.workspace.serverId;
        if (!focusServerId) return;
        setSessionListFocusedFolderV1({
            folderId: item.folderId,
            workspace: item.workspace,
            serverId: focusServerId,
        });
    }, [rowInteractions.consumeFolderFocusPressAfterDrag, setSessionListFocusedFolderV1]);

    const handleCreateSessionFromFolder = React.useCallback((item: Extract<SessionListIndexItem, { type: 'header' }>) => {
        const target = resolveNewSessionGroupTarget(item);
        if (!target) return;
        handleCreateSessionFromWorkspaceScope(target, {
            seedSessionId: item.seedSessionId,
        });
    }, [handleCreateSessionFromWorkspaceScope]);

    const handleAddSubfolder = React.useCallback(async (item: Extract<SessionListIndexItem, { type: 'header' }>) => {
        if (!item.folderId || !item.workspace) return;
        const name = await Modal.prompt(
            t('sessionsList.addSubfolderPromptTitle'),
            undefined,
            {
                defaultValue: t('sessionsList.newFolderDefaultName'),
                placeholder: t('sessionsList.folderNamePlaceholder'),
            },
        );
        if (name == null) return;
        const created = createSessionFolder({
            current: availableSessionFoldersV1,
            workspace: item.workspace,
            renderWorkspaceKey: item.workspaceKey,
            parentId: item.folderId,
            name,
            now: Date.now(),
        });
        runOrganizationMutation(async () => setSessionFoldersV1(created.next, await getAvailableOrganizationMutationScope(item.serverId ?? item.workspace?.serverId)));
    }, [availableSessionFoldersV1, getAvailableOrganizationMutationScope, runOrganizationMutation, setSessionFoldersV1]);

    const handleRenameFolder = React.useCallback(async (item: Extract<SessionListIndexItem, { type: 'header' }>) => {
        if (!item.folderId) return;
        const name = await Modal.prompt(
            t('sessionsList.renameFolderPromptTitle'),
            undefined,
            {
                defaultValue: item.title,
                placeholder: t('sessionsList.folderNamePlaceholder'),
            },
        );
        if (name == null) return;
        const renamed = renameSessionFolder({
            current: availableSessionFoldersV1,
            serverId: item.serverId ?? item.workspace?.serverId ?? '',
            folderId: item.folderId,
            name,
            now: Date.now(),
        });
        runOrganizationMutation(async () => setSessionFoldersV1(renamed.next, await getAvailableOrganizationMutationScope(item.serverId ?? item.workspace?.serverId)));
    }, [availableSessionFoldersV1, getAvailableOrganizationMutationScope, runOrganizationMutation, setSessionFoldersV1]);

    const handleDeleteFolder = React.useCallback(async (item: Extract<SessionListIndexItem, { type: 'header' }>) => {
        if (!item.folderId || !(item.serverId ?? item.workspace?.serverId)) return;
        const confirmed = await Modal.confirm(
            t('sessionsList.deleteFolderPromptTitle'),
            t('sessionsList.deleteFolderPromptDescription'),
            {
                confirmText: t('common.delete'),
                cancelText: t('common.cancel'),
                destructive: true,
            },
        );
        if (!confirmed) return;
        const deleted = deleteSessionFolder({
            current: availableSessionFoldersV1,
            serverId: item.serverId ?? item.workspace?.serverId ?? '',
            folderId: item.folderId,
        });
        if (deleted.deletedFolderIds.length === 0) return;
        runOrganizationMutation(async () => setSessionFoldersV1(deleted.next, await getAvailableOrganizationMutationScope(item.serverId ?? item.workspace?.serverId)));
        if (
            sessionListFocusedFolderV1
            && sessionListFocusedFolderV1.serverId === (item.serverId ?? item.workspace?.serverId ?? null)
            && deleted.deletedFolderIds.includes(sessionListFocusedFolderV1.folderId)
        ) {
            setSessionListFocusedFolderV1(null);
        }
    }, [availableSessionFoldersV1, getAvailableOrganizationMutationScope, runOrganizationMutation, sessionListFocusedFolderV1, setSessionFoldersV1, setSessionListFocusedFolderV1]);

    const sessionFoldersSignature = React.useMemo(
        () => buildSessionFoldersSignature(availableSessionFoldersV1),
        [availableSessionFoldersV1],
    );
    const folderMoveTargetsByRowIdRef = React.useRef(new Map<string, Readonly<{
        signature: string;
        value: readonly SessionFolderMoveTarget[];
    }>>());
    const resolveFolderMoveTargetsForItem = React.useCallback((
        item: Extract<SessionListIndexItem, { type: 'session' }>,
    ): readonly SessionFolderMoveTarget[] => {
        const organizationEligibility = resolveSessionListItemOrganizationEligibility(item, {
            foldersFeatureEnabled: isFolderActionsEnabledForServerId(item.serverId),
        });
        if (!organizationEligibility.canUseSessionFolders || !item.workspace) {
            return EMPTY_SESSION_FOLDER_MOVE_TARGETS;
        }
        const rowId = resolveTreeRowIdForSessionItem(item);
        const signature = buildSessionFolderMoveTargetSignature(
            sessionFoldersSignature,
            item.workspace,
            item.folderId,
        );
        const cached = folderMoveTargetsByRowIdRef.current.get(rowId);
        if (cached?.signature === signature) return cached.value;
        const value = buildSessionFolderMoveTargets({
            folders: availableSessionFoldersV1,
            workspace: item.workspace,
            currentFolderId: item.folderId ?? null,
            workspaceRootTitle: t('sessionsList.workspaceRoot'),
        });
        folderMoveTargetsByRowIdRef.current.set(rowId, { signature, value });
        return value;
    }, [availableSessionFoldersV1, isFolderActionsEnabledForServerId, sessionFoldersSignature]);
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
        stopSession: async (target) => await sessionStopWithServerScope(target.sessionId, { serverId: target.serverId ?? null }),
        archiveSession: async (target) => {
            const result = await sessionArchiveWithServerScope(target.sessionId, { serverId: target.serverId ?? null });
            if (result.success) {
                const address = normalizeSessionAddress(target.serverId, target.sessionId);
                if (address) clearSessionVisibleWhenInactive(address);
            }
            return result;
        },
        unarchiveSession: async (target) => await sessionUnarchiveWithServerScope(target.sessionId, { serverId: target.serverId ?? null }),
        setManualReadState: async (target, readState) => await sessionSetManualReadStateWithServerScope(
            target.sessionId,
            readState,
            { serverId: target.serverId ?? null },
        ),
        stopSessionAndMaybeArchive: async (params) => {
            await stopSessionAndMaybeArchive({
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
        setSessionFolderAssignment: async ({ target, folderId }) => {
            const scope = await getAvailableOrganizationMutationScope(target.serverId);
            await writeSessionOrganizationFolderAssignment({
                scope,
                sessionId: target.sessionId,
                folderId,
            });
        },
    }), [
        folderActionsEnabled,
        getAvailableOrganizationMutationScope,
        hideInactiveSessions,
        setSessionPinForTarget,
        setSessionTagAssignmentsForTarget,
    ]);
    const handleRequestBulkMoveToFolder = React.useCallback(async (targets: readonly SessionBulkActionTarget[]) => {
        if (!folderActionsEnabled || targets.length === 0) return null;
        const firstMovableItem = targets
            .filter((target) => target.canMoveToFolder === true)
            .map((target) => sessionListItemBySelectionKey.get(target.key) ?? null)
            .find((item): item is Extract<SessionListIndexItem, { type: 'session' }> => Boolean(item && item.workspace && item.serverId));
        if (!firstMovableItem) return null;
        const destinationWorkspace = firstMovableItem.workspace;
        if (!destinationWorkspace) return null;
        const moveTargets = resolveFolderMoveTargetsForItem(firstMovableItem)
            .filter((target) => target.disabled !== true)
            .map((target) => target.folderId === null
                ? { ...target, title: t('sessionsList.moveToWorkspaceRoot') }
                : target);
        if (moveTargets.length === 0) return null;
        const selectedTarget = await openSessionFolderSelection({
            sourceLabel: t('sessionsList.selectionMoveSheetSourceLabel', { count: targets.length }),
            targets: moveTargets,
        });
        if (!selectedTarget || selectedTarget.disabled) return null;
        return {
            folderId: selectedTarget.folderId,
            destinationWorkspace,
        };
    }, [folderActionsEnabled, resolveFolderMoveTargetsForItem, sessionListItemBySelectionKey]);

    const {
        scopeHintByLegacyWorkspaceKey,
        projectHeaderViewModelByGroupKey,
    } = renderModels.projectHeaderViewModelState;


    useSessionListWorkspaceLabelMigration({
        workspaceLabels: normalizedShellState.workspaceLabels,
        scopeHintByLegacyWorkspaceKey,
    });

    const collapsedKeys = normalizedShellState.collapsedGroupKeys;
    const renderHeaderItem = React.useCallback((item: Extract<SessionListIndexItem, { type: 'header' }>, index: number) => (
        <SessionListHeaderItem
            item={item}
            collapsedKeys={collapsedKeys}
            projectHeaderViewModelByGroupKey={projectHeaderViewModelByGroupKey}
            hasMultipleMachines={renderModels.hasMultipleMachines}
            onOpenProject={handleOpenProject}
            onCreateSessionFromWorkspaceScope={handleCreateSessionFromWorkspaceScope}
            onAddFolderToWorkspace={handleAddFolderToWorkspace}
            onRenameWorkspace={handleRenameWorkspace}
            onResetWorkspaceName={handleResetWorkspaceName}
            onToggleCollapse={handleToggleCollapse}
            onFocusFolder={handleFocusSessionFolder}
            onCreateSessionFromFolder={handleCreateSessionFromFolder}
            onAddSubfolder={handleAddSubfolder}
            onRenameFolder={handleRenameFolder}
            onDeleteFolder={handleDeleteFolder}
            onMoveFolder={(folderItem) => {
                if (!folderItem.folderId) return;
                const serverId = folderItem.serverId ?? folderItem.workspace?.serverId;
                if (!serverId) return;
                const rowId = treeRowId.folder(serverId, folderItem.folderId);
                void openMoveSheetForTreeRow(rowId, rowLabelByTreeRowId.get(rowId) ?? folderItem.title);
            }}
            onMoveFolderToWorkspaceRoot={(folderItem) => {
                if (!folderItem.folderId) return;
                const serverId = folderItem.serverId ?? folderItem.workspace?.serverId;
                if (!serverId) return;
                const rowId = treeRowId.folder(serverId, folderItem.folderId);
                moveTreeRowToWorkspaceRoot(rowId, rowLabelByTreeRowId.get(rowId) ?? folderItem.title);
            }}
            onMoveFolderUp={(folderItem) => {
                if (!folderItem.folderId) return;
                const serverId = folderItem.serverId ?? folderItem.workspace?.serverId;
                if (!serverId) return;
                const rowId = treeRowId.folder(serverId, folderItem.folderId);
                moveTreeRowByKeyboard(rowId, rowLabelByTreeRowId.get(rowId) ?? folderItem.title, 'up');
            }}
            onMoveFolderDown={(folderItem) => {
                if (!folderItem.folderId) return;
                const serverId = folderItem.serverId ?? folderItem.workspace?.serverId;
                if (!serverId) return;
                const rowId = treeRowId.folder(serverId, folderItem.folderId);
                moveTreeRowByKeyboard(rowId, rowLabelByTreeRowId.get(rowId) ?? folderItem.title, 'down');
            }}
            workspaceFaviconsEnabled={workspaceFaviconsEnabled}
            workspaceMachineSubtitlesEnabled={workspaceMachineSubtitlesEnabled}
            dataIndex={index}
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
        handleAddSubfolder,
        handleOpenProject,
        handleCreateSessionFromWorkspaceScope,
        handleCreateSessionFromFolder,
        handleDeleteFolder,
        handleFocusSessionFolder,
        handleAddFolderToWorkspace,
        handleRenameFolder,
        handleRenameWorkspace,
        handleResetWorkspaceName,
        handleToggleCollapse,
        moveTreeRowByKeyboard,
        moveTreeRowToWorkspaceRoot,
        openMoveSheetForTreeRow,
        projectHeaderViewModelByGroupKey,
        homeObservations,
        renderModels.audience,
        renderModels.hasMultipleMachines,
        rowInteractions.dropOverlayShared,
        rowInteractions.handleFolderHeaderTreeDropResult,
        rowInteractions.handleDragCancel,
        rowInteractions.handleDragStart,
        rowInteractions.registerTreeRowBounds,
        rowInteractions.resolveTreeDropResult,
        rowInteractions.unregisterTreeRowBounds,
        rowLabelByTreeRowId,
        workspaceFaviconsEnabled,
        workspaceMachineSubtitlesEnabled,
    ]);

    const renderSessionItem = React.useCallback((
        item: Extract<SessionListIndexItem, { type: 'session' }>,
        index: number,
    ) => {
        const treeRowIdForItem = resolveTreeRowIdForSessionItem(item);
        const rowScopeKey = resolveSessionListRowStoreScopeKey({
            sessionId: item.sessionId,
            serverId: item.serverId ?? null,
        });
        const rowAttentionAnimationEnabled = rowSubscriptionKeys === null
            || rowSubscriptionKeys.has(rowScopeKey);
        const moveActionHandlers = getRowMoveActionHandlers({
            sourceRowId: treeRowIdForItem,
            sourceLabel: rowLabelByTreeRowId.get(treeRowIdForItem) ?? item.sessionId,
            item,
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
            sectionModeV1: sessionListSectionModeV1,
            orderingModeV1: sessionListOrderingModeV1,
        });
        const draftServerId = item.serverId ?? draftScope?.serverId ?? null;
        const draftKey = draftServerId ? sessionTagKey(draftServerId, item.sessionId) : null;
        const draft = draftKey ? renderModels.existingDraftBySessionKey.get(draftKey) ?? null : null;
        const deleteDraft = draftScope
            && (!item.serverId || item.serverId === draftScope.serverId)
            && draft
            ? async (): Promise<void> => {
                await deleteSessionDraft({
                    scope: draftScope,
                    address: { kind: 'session', sessionId: item.sessionId },
                });
            }
            : undefined;
        return (
            <SessionListRowViewModelBoundary
                audienceScope={item.serverId ? renderModels.audience.scopes.get(item.serverId) : undefined}
                homeObservation={item.serverId ? homeObservations[item.serverId] ?? null : null}
                audienceLabel={item.serverId ? renderModels.audience.labelsBySessionKey.get(audienceSessionAddressKey({ serverId: item.serverId, sessionId: item.sessionId })) : null}
                item={item}
                items={renderedListItems}
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
                nativeContextMenuSessionKey={rowInteractions.nativeContextMenuSessionKey}
                dataIndex={index}
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
                hasMultipleMachines={renderModels.hasMultipleMachines}
                hideInactiveSessions={hideInactiveSessions === true}
                identityDisplay={sessionListIdentityDisplay === 'agentLogo' || sessionListIdentityDisplay === 'none'
                    ? sessionListIdentityDisplay
                    : 'avatar'}
                draft={draft}
                pinnedSessionKeys={orderingPersistenceState.pinnedKeySet}
                reachableSessionDisplayById={renderModels.reachableSessionDisplayById}
                reachableSessionDisplayByKey={renderModels.reachableSessionDisplayByKey}
                rowAttentionAnimationEnabled={rowAttentionAnimationEnabled}
                selectedSessionId={selectedSessionId}
                selectedSessionServerId={selectedSessionServerId}
                sessionTags={normalizedShellState.sessionTags}
                showPinnedServerBadge={shellFlags.showPinnedServerBadge}
                showServerBadge={shellFlags.showServerBadge}
                workingIndicatorMode={sessionListWorkingIndicatorStyle === 'pulse' ? 'pulse' : 'spinner'}
                workingTextMode={sessionListWorkingStatusAnimatedTextEnabled === false ? 'static' : 'animated'}
                folderMoveTargets={resolveFolderMoveTargetsForItem(item)}
                forkActionContext={forkActionContext}
                onMoveToSessionFolder={canUseSessionFolders ? moveActionHandlers.onMoveToSessionFolder : undefined}
                onMoveToFolder={canUseSessionFolders ? moveActionHandlers.onMoveToFolder : undefined}
                onMoveToWorkspaceRoot={canUseSessionFolders ? moveActionHandlers.onMoveToWorkspaceRoot : undefined}
                onMoveUp={canUseSessionFolders && rowDragPolicy.canReorderSiblings ? moveActionHandlers.onMoveUp : undefined}
                onMoveDown={canUseSessionFolders && rowDragPolicy.canReorderSiblings ? moveActionHandlers.onMoveDown : undefined}
                onDeleteDraft={deleteDraft}
            />
        );
    }, [
        allKnownTags,
        attentionStanding.actionEnabled,
        attentionStanding.policy,
        currentUserId,
        densityViewState.compact,
        densityViewState.compactMinimal,
        densityViewState.rowHeight,
        draftScope,
        rowSubscriptionKeys,
        selectedSessionId,
        selectedSessionServerId,
        isFolderActionsEnabledForServerId,
        forkActionContext,
        hideInactiveSessions,
        normalizedShellState.sessionTags,
        orderingPersistenceState.pinnedKeySet,
        homeObservations,
        renderModels.audience,
        renderModels.hasMultipleMachines,
        renderModels.existingDraftBySessionKey,
        renderModels.reachableSessionDisplayById,
        renderModels.reachableSessionDisplayByKey,
        renderedListItems,
        rowInteractions.draggingSessionKey,
        rowInteractions.dropOverlayShared,
        rowInteractions.handleDragCancel,
        rowInteractions.handleDragStart,
        rowInteractions.handleTreeDropResult,
        rowInteractions.handleNativeContextMenuOpenChangeSessionKey,
        rowInteractions.handleSetTagsSessionKey,
        rowInteractions.handleTogglePinnedSessionKey,
        rowInteractions.registerTreeRowBounds,
        rowInteractions.resolveTreeDropResult,
        rowInteractions.unregisterTreeRowBounds,
        resolveFolderMoveTargetsForItem,
        sessionTagsEnabled,
        sessionListActiveColorMode,
        sessionListIdentityDisplay,
        sessionListWorkingIndicatorStyle,
        sessionListWorkingStatusAnimatedTextEnabled,
        sessionListOrderingModeV1,
        sessionListSectionModeV1,
        shellFlags.canMoveSessionRowsBetweenFolders,
        shellFlags.canReorderSessions,
        shellFlags.showPinnedServerBadge,
        shellFlags.showServerBadge,
        surfaceOwnership.dataActive,
        getRowMoveActionHandlers,
        rowLabelByTreeRowId,
    ]);

    const renderWorkflowRunItem = React.useCallback((item: Extract<SessionListIndexItem, { type: 'workflow_run' }>, index: number) => (
        <SessionItem kind="workflow_run" runId={item.runId} serverId={item.serverId}
            dataActive={surfaceOwnership.dataActive && (viewableSessionRowKeys === null || viewableSessionRowKeys.has(buildSessionListIndexNodeId(item)))}
            density={densityViewState.compact ? densityViewState.compactMinimal ? 'minimal' : 'compact' : 'default'}
            selected={effectivePathname === `/workflows/runs/${encodeURIComponent(item.runId)}`}
            {...resolveSessionListRowViewModelAdjacency(renderedListItems, index)}
            folderDepth={item.folderDepth} reportsDepth={item.reportsDepth} />
    ), [densityViewState.compact, densityViewState.compactMinimal, effectivePathname, renderedListItems, surfaceOwnership.dataActive, viewableSessionRowKeys]);

    const virtualizedNodeCacheRef = React.useRef(new Map<string, Readonly<{
        item: SessionListIndexItem;
        node: SessionListVirtualizedNode;
    }>>());
    const previousVirtualizedNodesRef = React.useRef<ReadonlyArray<SessionListVirtualizedNode>>([]);
    const virtualizedNodes = React.useMemo(() => {
        const previous = virtualizedNodeCacheRef.current;
        const next = new Map<string, Readonly<{
            item: SessionListIndexItem;
            node: SessionListVirtualizedNode;
        }>>();
        const nodes: SessionListVirtualizedNode[] = [];
        renderedListItems.forEach((item, index) => {
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
        virtualizedNodeCacheRef.current = next;
        const previousNodes = previousVirtualizedNodesRef.current;
        const output = areVirtualizedNodeArraysReferenceEqual(previousNodes, nodes) ? previousNodes : nodes;
        previousVirtualizedNodesRef.current = output;
        return output;
    }, [renderedListItems]);

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
    const folderFocusRootTitle = React.useMemo(() => {
        const folderFocus = renderPaneState.folderFocus;
        if (!folderFocus) return null;
        for (const item of renderedListItems) {
            if (item.type !== 'header' || item.headerKind !== 'project') continue;
            const workspace = resolveDurableWorkspaceRefForSessionListHeader(item);
            if (workspace && compareSessionFolderWorkspaceRefs(workspace, folderFocus.folder.workspace)) {
                return item.title;
            }
        }
        return null;
    }, [renderedListItems, renderPaneState.folderFocus]);

    const nodeByIdRef = React.useRef(nodeById);
    nodeByIdRef.current = nodeById;
    const viewabilityConfigRef = React.useRef({ itemVisiblePercentThreshold: 1 });
    const handleViewableItemsChangedRef = React.useRef((info: { viewableItems: ViewToken[] }) => {
        const nextKeys = new Set<string>();
        for (const token of info.viewableItems) {
            if (token.isViewable === false) continue;
            const node = token.item as SessionListVirtualizedNode | undefined;
            const item = node ? nodeByIdRef.current.get(node.id) ?? null : null;
            if (!item || item.type === 'header') continue;
            if (item.type === 'workflow_run') { nextKeys.add(buildSessionListIndexNodeId(item)); continue; }
            nextKeys.add(resolveSessionListRowStoreScopeKey({
                sessionId: item.sessionId,
                serverId: item.serverId ?? null,
            }));
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
    const rowLabelsSignature = React.useMemo(() => buildRowLabelSignature(rowLabelByTreeRowId), [rowLabelByTreeRowId]);
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
        existingDraftBySessionKey: renderModels.existingDraftBySessionKey,
        folderActionsEnabled,
        forkActionContext,
        hasMultipleMachines: renderModels.hasMultipleMachines,
        homeObservations,
        nativeContextMenuSessionKey: rowInteractions.nativeContextMenuSessionKey,
        pinnedSessionKeys: orderingPersistenceState.pinnedKeySet,
        reachableSessionDisplayById: renderModels.reachableSessionDisplayById,
        reachableSessionDisplayByKey: renderModels.reachableSessionDisplayByKey,
        rowHeight: densityViewState.rowHeight,
        rowLabelsSignature,
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
        viewableSessionRowKeys,
        sessionListWorkingIndicatorMode: sessionListWorkingIndicatorStyle === 'pulse' ? 'pulse' : 'spinner',
        sessionListWorkingTextMode: sessionListWorkingStatusAnimatedTextEnabled === false ? 'static' : 'animated',
        sessionTagsEnabled: sessionTagsEnabled === true,
        sessionTagsSignature,
        workspaceLabelsSignature,
    }), [
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
        renderModels.existingDraftBySessionKey,
        renderModels.hasMultipleMachines,
        renderModels.reachableSessionDisplayById,
        renderModels.reachableSessionDisplayByKey,
        rowInteractions.draggingSessionKey,
        rowInteractions.nativeContextMenuSessionKey,
        rowLabelsSignature,
        selectedSessionId,
        selectedSessionServerId,
        sessionListActiveColorMode,
        sessionListIdentityDisplay,
        sessionListWorkingIndicatorStyle,
        sessionListWorkingStatusAnimatedTextEnabled,
        sessionFoldersSignature,
        surfaceOwnership.dataActive,
        viewableSessionRowKeys,
        sessionTagsEnabled,
        sessionTagsSignature,
        shellFlags.canDragSessionRows,
        shellFlags.canMoveSessionRowsBetweenFolders,
        shellFlags.canReorderSessions,
        workspaceLabelsSignature,
    ]);

    const renderVirtualizedItem = React.useCallback((params: { item: SessionListVirtualizedNode; index: number }) => {
        const item = nodeByIdRef.current.get(params.item.id) ?? listItemsRef.current[params.index] ?? null;
        if (!item) return null;
        if (item.type === 'header') return renderHeaderItemRef.current(item, params.index);
        if (item.type === 'workflow_run') return renderWorkflowRunItemRef.current(item, params.index);
        return renderSessionItemRef.current(item, params.index);
    }, []);
    const handleClearFolderFocus = React.useCallback(() => {
        setSessionListFocusedFolderV1(null);
    }, [setSessionListFocusedFolderV1]);
    const handleSelectFolderBreadcrumb = React.useCallback((folderId: string) => {
        const folder = renderPaneState.folderFocus?.breadcrumbs.find((candidate) => candidate.id === folderId) ?? null;
        if (!folder) return;
        const focusServerId = folder.workspace.serverId;
        if (!focusServerId) return;
        setSessionListFocusedFolderV1({
            folderId: folder.id,
            workspace: folder.workspace,
            serverId: focusServerId,
        });
    }, [renderPaneState.folderFocus?.breadcrumbs, setSessionListFocusedFolderV1]);
    const handleTreeViewportLayout = React.useCallback((event: { nativeEvent?: { layout?: { y?: number; height?: number } } }) => {
        rowInteractions.handleTreeListLayout(event);
        rowInteractions.handleTreeViewportMeasure(treeViewportRef.current);
    }, [rowInteractions]);
    const keyboardZoneProps = React.useMemo(() => (
        Platform.OS === 'web'
            ? {
                testID: 'sessions-list-keyboard-zone',
                tabIndex: 0,
                onFocus: () => {
                    sessionListKeyboardFocusedRef.current = true;
                    setSessionListKeyboardFocused(true);
                },
                onBlur: () => {
                    sessionListKeyboardFocusedRef.current = false;
                    setSessionListKeyboardFocused(false);
                    visibleCursorSessionKeyRef.current = null;
                    sessionListSelectionStore.setFocusedKey(null);
                },
                onKeyDown: handleSessionListKeyDown,
            } as const
            : {}
    ), [handleSessionListKeyDown, sessionListSelectionStore]);

    return {
        externalStatusDemand,
        nodes: virtualizedNodes,
        nodeIds,
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
        searchChrome,
        keyboardZoneProps,
        sessionListSelectionStore,
        sessionListSelectionTargetsByKey,
        sessionListBulkActionContext,
        onRequestBulkMoveToFolder: folderActionsEnabled ? handleRequestBulkMoveToFolder : undefined,
        tagsEnabled: sessionTagsEnabled === true,
        folderFocus: renderPaneState.folderFocus,
        folderFocusRootTitle,
        dropOverlayShared: rowInteractions.dropOverlayShared,
        entityDragDrop: rowInteractions.entityDragDrop,
        stagedMove: rowInteractions.stagedMove,
        onClearFolderFocus: handleClearFolderFocus,
        onSelectFolderBreadcrumb: handleSelectFolderBreadcrumb,
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
