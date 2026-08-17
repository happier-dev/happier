import * as React from 'react';
import { Platform, type ViewToken } from 'react-native';
import { usePathname } from 'expo-router';
import { EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1 } from '@happier-dev/protocol';
import {
    useSetting,
    useSettingMutable,
    useMachineDisplayById,
    useProfile,
    useLocalSettingMutable,
    useSessionListRowRenderablesForItems,
    useSessionOrganizationProjection,
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
import { useSessionListRenderModels } from './useSessionListRenderModels';
import { useSessionListSearchTextByKey } from './useSessionListSearchTextByKey';
import { useSessionListNavigationActions } from './useSessionListNavigationActions';
import { useSessionListRowInteractions } from './useSessionListRowInteractions';
import { useSessionListRowMoveActionHandlers } from './useSessionListRowMoveActionHandlers';
import { useSessionListWorkspaceHeaderActions } from './useSessionListWorkspaceHeaderActions';
import { useSessionListWorkspaceLabelMigration } from './useSessionListWorkspaceLabelMigration';
import { useFrozenSessionListItemsDuringDrag } from './drag/useFrozenSessionListItemsDuringDrag';
import {
    normalizeSessionListSurfaceOwnership,
    type SessionListSurfaceOwnership,
} from './surface/sessionListSurfaceOwnership';
import { useVisibleSessionListPaneState, type VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import {
    areSessionListIndexItemsEqual,
    buildSessionListIndexNodeId,
    resolveSessionListItemOrganizationEligibility,
    type SessionListIndexItem,
} from '@/sync/domains/sessionList/sessionListIndex';
import { normalizeSessionListShellState } from './normalizeSessionListShellState';
import { resolveSelectedSessionIdForList } from '@/sync/domains/session/listing/resolveSelectedSessionIdForList';
import { useSessionCanvasSelection } from './view/useSessionCanvasSelection';
import { useSessionListA11yAnnouncements } from './accessibility/useSessionListA11yAnnouncements';
import type { SessionListMoveSheetTarget } from './move-sheet/buildSessionListMoveSheetTargets';
import { useSessionListMoveSheet } from './move-sheet/useSessionListMoveSheet';
import {
    buildServerScopedSessionKey,
    moveSessionMruEntryToFront,
    resolveVisibleSessionEdgeNavigation,
    resolveSessionMruNavigation,
    resolveVisibleSessionNavigation,
    type VisibleSessionNavigationEntry,
} from '@/keyboard/sessions';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import {
    useSessionSurfaceVisibilitySnapshot,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { TranslationKey } from '@/text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type { TreeDropMeasurableRef } from '@/components/ui/treeDragDrop';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    replaceExternalSessionStatusDemandViewport,
} from '@/sync/runtime/orchestration/externalSessions/externalSessionStatusDemandCoordinator';
import {
    collectExternalSessionStatusDemandViewportEntries,
} from '@/sync/runtime/orchestration/externalSessions/collectExternalSessionStatusDemandViewportEntries';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    resolveSessionOrganizationMutationScope,
    writeSessionOrganizationFolderAssignment,
    writeSessionOrganizationFolders,
    writeSessionOrganizationGroupOrder,
    writeSessionOrganizationPin,
    writeSessionOrganizationPinForSessionKey,
    writeSessionOrganizationTagLabels,
    writeSessionOrganizationTagLabelsForSessionKey,
    writeSessionOrganizationWorkspaceLabels,
    writeSessionOrganizationWorkspaceOrder,
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
import { buildSessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { resolveWorkspaceRootTreeRowId, treeRowId } from './drop-resolution/treeRowId';
import { isSessionListPrimaryHeaderKind } from './sessionListPrimaryHeader';
import {
    getSessionListHeaderControlsAnchorKey,
    hasActiveSessionListHeaderFilters,
} from './sessionListFilters';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    SESSION_LIST_MEMORY_SEARCH_MIN_QUERY_LENGTH,
    useSessionListMemorySearchAugmentation,
} from './search/useSessionListMemorySearchAugmentation';
import { useSessionListHeaderFilterRetention } from './search/useSessionListHeaderFilterRetention';
import { buildSessionListRetentionKey } from './scroll/sessionListRetentionKey';
import {
    SessionListFilteredNoResultsMessage,
    SESSION_LIST_FILTERED_NO_RESULTS_MESSAGE_KEY,
    type SessionListVirtualizedNode,
} from './sessionListVirtualizedContent';
import {
    buildSessionListRowStorePriorityKeys,
    isSessionListRowStorePriorityItem,
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
    buildSessionListSelectionScopeKey,
    readSessionListSelectionKeysFromVisibleEntries,
} from './selection/sessionListSelectionKeys';
import {
    useSessionListSelectionController,
} from './selection/SessionListSelectionContext';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

const SEARCH_FOCUS_TRANSFER_SETTLE_MS = 50;
const NATIVE_LIST_ALL_RENDERED_ROW_STORE_MAX_ITEMS = 200;
const EMPTY_MEMORY_MATCHED_SESSION_KEYS: ReadonlySet<string> = new Set();
const EMPTY_VIEWABLE_SESSION_ROW_KEYS: ReadonlySet<string> = new Set();
const EMPTY_SESSION_FOLDER_MOVE_TARGETS: readonly SessionFolderMoveTarget[] = [];
const SESSION_LIST_IDLE_MOVE_RESULT = Object.freeze({
    instruction: Object.freeze({ kind: 'idle' as const }),
    visual: Object.freeze({ kind: 'none' as const }),
});

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

function buildSessionListMemoryCandidateKeySet(items: ReadonlyArray<SessionListIndexItem>): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const item of items) {
        if (item.type !== 'session') continue;
        const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
        const sessionId = String(item.sessionId ?? '').trim();
        if (!serverId || !sessionId) continue;
        keys.add(sessionTagKey(serverId, sessionId));
    }
    return keys;
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

function resolveSessionTreeRowId(sessionKey: string | null): string | null {
    if (!sessionKey) return null;
    const separatorIndex = sessionKey.indexOf(':');
    if (separatorIndex <= 0) return null;
    const serverId = sessionKey.slice(0, separatorIndex);
    const sessionId = sessionKey.slice(separatorIndex + 1);
    return serverId && sessionId ? treeRowId.session(serverId, sessionId) : null;
}

function buildStatusDemandSessionItemFromRowKey(
    rowKey: string,
): Extract<SessionListIndexItem, { type: 'session' }> | null {
    const separatorIndex = rowKey.indexOf('\u0000');
    const serverId = separatorIndex >= 0 ? rowKey.slice(0, separatorIndex) : '';
    const sessionId = separatorIndex >= 0 ? rowKey.slice(separatorIndex + 1) : rowKey;
    if (!sessionId) return null;
    return {
        type: 'session',
        sessionId,
        ...(serverId ? { serverId } : null),
    };
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
        hasAdminAccess: actionTarget.hasAdminAccess,
        canStop: actionTarget.canStop,
        canArchive: actionTarget.canArchive,
        canMoveToFolder: organizationEligibility.canUseSessionFolders,
        workspace: params.item.workspace ?? null,
        tags: getTagsForSession(params.sessionTags, selectionKey),
        readState,
    };
}

function buildStringListSignature(values: ReadonlyArray<string> | null | undefined): string {
    if (!values || values.length === 0) return '';
    return values.join('\u0001');
}

function buildStringRecordSignature(value: Readonly<Record<string, string>> | null | undefined): string {
    if (!value) return '';
    const entries = Object.entries(value);
    if (entries.length === 0) return '';
    return entries
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => `${key}\u0001${entryValue}`)
        .join('\u0002');
}

function buildStringArrayRecordSignature(value: Readonly<Record<string, readonly string[]>> | null | undefined): string {
    if (!value) return '';
    const entries = Object.entries(value);
    if (entries.length === 0) return '';
    return entries
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => `${key}\u0001${buildStringListSignature(entryValue)}`)
        .join('\u0002');
}

function buildSessionFolderWorkspaceSignature(workspace: SessionFolderWorkspaceRefV1): string {
    if (workspace.t === 'workspaceScope') {
        return [
            workspace.t,
            workspace.serverId ?? '',
            workspace.machineId ?? '',
            workspace.rootPath,
        ].join('\u0001');
    }
    return [
        workspace.t,
        workspace.serverId ?? '',
        workspace.workspaceRefId,
    ].join('\u0001');
}

function buildSessionFoldersSignature(value: SessionFoldersV1): string {
    if (value.folders.length === 0) return '';
    return value.folders
        .map((folder) => [
            folder.id,
            folder.name,
            folder.parentId ?? '',
            folder.renderWorkspaceKey ?? '',
            buildSessionFolderWorkspaceSignature(folder.workspace),
            folder.sortKey ?? '',
        ].join('\u0001'))
        .join('\u0002');
}

function buildRowLabelSignature(labels: ReadonlyMap<string, string>): string {
    if (labels.size === 0) return '';
    return Array.from(labels.entries())
        .map(([key, label]) => `${key}\u0001${label}`)
        .join('\u0002');
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

function shouldInsertFilteredNoResultsAfterHeader(params: Readonly<{
    item: SessionListIndexItem;
    itemIndex: number;
    items: ReadonlyArray<SessionListIndexItem>;
    filtersActive: boolean;
    headerControlsAnchorKey: string | null;
}>): boolean {
    if (!params.filtersActive) return false;
    if (!params.headerControlsAnchorKey) return false;
    const item = params.item;
    if (item.type !== 'header' || !isSessionListPrimaryHeaderKind(item.headerKind)) return false;
    if (getSessionListHeaderControlsAnchorKey(item) !== params.headerControlsAnchorKey) return false;

    for (let index = params.itemIndex + 1; index < params.items.length; index += 1) {
        const candidate = params.items[index];
        if (candidate.type === 'session') return false;
        if (candidate.type === 'header' && isSessionListPrimaryHeaderKind(candidate.headerKind)) break;
    }
    return true;
}

export type SessionListViewStateOptions = Readonly<{
    pathname?: string;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
}>;

export function useSessionListViewState(
    storageKind: SessionListStorageFilter,
    options: SessionListViewStateOptions = {},
) {
    const surfaceOwnership = normalizeSessionListSurfaceOwnership(options.surfaceOwnership);
    const sessionListPaneState = useVisibleSessionListPaneState(storageKind, {
        pathname: options.pathname,
        sessionListSurfaceDataActive: surfaceOwnership.dataActive,
    });
    return useSessionListViewStateFromPaneState(storageKind, sessionListPaneState, {
        ...options,
        surfaceOwnership,
    });
}

export function useSessionListViewStateFromPaneState(
    storageKind: SessionListStorageFilter,
    sessionListPaneState: VisibleSessionListPaneState,
    options: SessionListViewStateOptions = {},
) {
    const pathname = usePathname();
    const effectivePathname = options.pathname ?? pathname;
    const surfaceOwnership = normalizeSessionListSurfaceOwnership(options.surfaceOwnership);
    const renderPaneState = sessionListPaneState;
    const retentionKey = React.useMemo(
        () => buildSessionListRetentionKey(storageKind),
        [storageKind],
    );
    const {
        searchQuery,
        setSearchQuery,
        selectedHeaderTags,
        setSelectedHeaderTags,
    } = useSessionListHeaderFilterRetention(retentionKey);
    const isTablet = useIsTablet();
    const [sessionListOrderingModeV1] = useSettingMutable('sessionListOrderingModeV1');
    const sessionListSectionModeV1 = useSetting('sessionListSectionModeV1') === 'single'
        ? 'single'
        : 'activity';
    const sessionListFolderSortModeV1 = useSetting('sessionListFolderSortModeV1') === 'mixed' ? 'mixed' : 'foldersFirst';
    const sessionFolderViewModeV1 = useSetting('sessionFolderViewModeV1') === 'tree' ? 'tree' : 'off';
    const sessionTagsEnabled = useSetting('sessionTagsEnabled');
    const [workspaceRefsV1, setWorkspaceRefsV1] = useSettingMutable('workspaceRefsV1');
    const workspacePathDisplayModeV1 = useSetting('workspacePathDisplayModeV1');
    const workspaceFaviconsEnabled = useSetting('workspaceFaviconsEnabled') !== false;
    const workspaceMachineSubtitlesEnabled = useSetting('workspaceMachineSubtitlesEnabled') !== false;
    const [collapsedGroupKeysV1, setCollapsedGroupKeysV1] = useLocalSettingMutable('collapsedGroupKeysV1');
    const [sessionMruOrderV1, setSessionMruOrderV1] = useLocalSettingMutable('sessionMruOrderV1');
    const [sessionListFocusedFolderV1, setSessionListFocusedFolderV1] = useLocalSettingMutable('sessionListFocusedFolderV1');
    const [activeSearchHeaderControlsAnchorKey, setActiveSearchHeaderControlsAnchorKey] = React.useState<string | null>(null);
    const [focusedSearchHeaderControlsAnchorKey, setFocusedSearchHeaderControlsAnchorKey] = React.useState<string | null>(null);
    const searchFocusTransferTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const sessionFoldersFeatureEnabled = useFeatureEnabled('sessions.folders');
    const folderActionsEnabled = sessionFoldersFeatureEnabled;
    const sessionListDensity = useSetting('sessionListDensity');
    const sessionListWorkingIndicatorStyle = useSetting('sessionListNarrowWorkingIndicatorStyle');
    const sessionListWorkingStatusAnimatedTextEnabled = useSetting('sessionListWorkingStatusAnimatedTextEnabled');
    const sessionListIdentityDisplay = useSetting('sessionListIdentityDisplay');
    const sessionListActiveColorMode = useSetting('sessionListActiveColorModeV1');
    const hideInactiveSessions = useSetting('hideInactiveSessions');
    const profile = useProfile();
    const navigateToSession = useNavigateToSession();
    const { openMoveSheet } = useSessionListMoveSheet();
    const sessionListA11y = useSessionListA11yAnnouncements();
    const densityViewState = resolveSessionListDensityViewState(sessionListDensity, {
        isTablet,
        platform: Platform.OS,
    });
    const currentUserId = typeof profile?.id === 'string' ? profile.id : null;
    const selection = useSessionListSelectionState();
    const activeOrganizationServerId = typeof selection.activeServerId === 'string'
        ? selection.activeServerId.trim()
        : '';
    const organizationProjection = useSessionOrganizationProjection(activeOrganizationServerId);
    const organizationListViewState = React.useMemo(() => buildSessionOrganizationListViewState({
        serverId: activeOrganizationServerId,
        projection: organizationProjection,
    }), [activeOrganizationServerId, organizationProjection]);
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
        folderActionsEnabled,
        folderViewMode: sessionFolderViewModeV1,
        hasAnySessionFolderInAccount: sessionFoldersV1.folders.length > 0,
    });
    const allKnownTags = getAllKnownTags(normalizedShellState.sessionTags);
    const getAvailableOrganizationMutationScope = React.useCallback(async (
        serverIdRaw?: string | null,
    ): Promise<SessionOrganizationMutationScope | null> => {
        const serverId = typeof serverIdRaw === 'string' && serverIdRaw.trim()
            ? serverIdRaw.trim()
            : activeOrganizationServerId;
        const result = await resolveSessionOrganizationMutationScope(serverId);
        return result.ok ? result.scope : null;
    }, [activeOrganizationServerId]);
    const runOrganizationMutation = React.useCallback((mutation: () => Promise<void>) => {
        void mutation().catch(() => undefined);
    }, []);
    const setSessionPinForTarget = React.useCallback(async (
        target: SessionBulkActionTarget,
        pinned: boolean,
    ) => {
        const scope = await getAvailableOrganizationMutationScope(target.serverId ?? null);
        if (!scope) {
            throw new Error('Session pin requires an available server profile');
        }
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
        if (!scope) {
            throw new Error('Session tags require an available server profile');
        }
        await writeSessionOrganizationTagLabels({
            scope,
            sessionId: target.sessionId,
            tags,
        });
    }, [getAvailableOrganizationMutationScope]);
    const setSessionPinForSessionKey = React.useCallback((sessionKey: string, pinned: boolean) => {
        runOrganizationMutation(async () => {
            const separatorIndex = sessionKey.indexOf(':');
            const serverId = separatorIndex > 0 ? sessionKey.slice(0, separatorIndex) : activeOrganizationServerId;
            const scope = await getAvailableOrganizationMutationScope(serverId);
            if (!scope) return;
            await writeSessionOrganizationPinForSessionKey({
                scope,
                sessionKey,
                pinned,
            });
        });
    }, [activeOrganizationServerId, getAvailableOrganizationMutationScope, runOrganizationMutation]);
    const setSessionTagsForSessionKey = React.useCallback((sessionKey: string, tags: readonly string[]) => {
        runOrganizationMutation(async () => {
            const separatorIndex = sessionKey.indexOf(':');
            const serverId = separatorIndex > 0 ? sessionKey.slice(0, separatorIndex) : activeOrganizationServerId;
            const scope = await getAvailableOrganizationMutationScope(serverId);
            if (!scope) return;
            await writeSessionOrganizationTagLabelsForSessionKey({
                scope,
                sessionKey,
                tags,
            });
        });
    }, [activeOrganizationServerId, getAvailableOrganizationMutationScope, runOrganizationMutation]);
    const setSessionListGroupOrderV1 = React.useCallback((nextOrder: Record<string, readonly string[] | undefined>) => {
        runOrganizationMutation(async () => {
            const scope = await getAvailableOrganizationMutationScope(activeOrganizationServerId);
            if (!scope) return;
            await writeSessionOrganizationGroupOrder({ scope, next: nextOrder });
        });
    }, [activeOrganizationServerId, getAvailableOrganizationMutationScope, runOrganizationMutation]);
    const setSessionWorkspaceOrderV1 = React.useCallback((nextOrder: Record<string, readonly string[] | undefined>) => {
        runOrganizationMutation(async () => {
            const scope = await getAvailableOrganizationMutationScope(activeOrganizationServerId);
            if (!scope) return;
            await writeSessionOrganizationWorkspaceOrder({ scope, next: nextOrder });
        });
    }, [activeOrganizationServerId, getAvailableOrganizationMutationScope, runOrganizationMutation]);
    const setSessionFoldersV1 = React.useCallback((nextFolders: SessionFoldersV1) => {
        runOrganizationMutation(async () => {
            const scope = await getAvailableOrganizationMutationScope(activeOrganizationServerId);
            if (!scope) return;
            await writeSessionOrganizationFolders({
                scope,
                current: availableSessionFoldersV1,
                next: nextFolders,
            });
        });
    }, [activeOrganizationServerId, availableSessionFoldersV1, getAvailableOrganizationMutationScope, runOrganizationMutation]);
    const setWorkspaceLabelsV1 = React.useCallback((nextLabelsRaw: Record<string, string>) => {
        runOrganizationMutation(async () => {
            const scope = await getAvailableOrganizationMutationScope(activeOrganizationServerId);
            if (!scope) return;
            await writeSessionOrganizationWorkspaceLabels({
                scope,
                current: availableWorkspaceLabelsV1,
                next: nextLabelsRaw,
            });
        });
    }, [activeOrganizationServerId, availableWorkspaceLabelsV1, getAvailableOrganizationMutationScope, runOrganizationMutation]);
    const sessionListMemoryCandidateKeys = React.useMemo(
        () => buildSessionListMemoryCandidateKeySet(renderPaneState.visibleSessionListIndex ?? []),
        [renderPaneState.visibleSessionListIndex],
    );
    const memorySearch = useSessionListMemorySearchAugmentation({
        searchQuery,
        candidateSessionKeys: sessionListMemoryCandidateKeys,
        enabled: surfaceOwnership.dataActive,
    });
    const activeMemoryMatchedSessionKeys = React.useMemo(() => {
        const query = searchQuery.trim();
        if (!query || memorySearch.lastSuccessfulQuery !== query) {
            return EMPTY_MEMORY_MATCHED_SESSION_KEYS;
        }
        return memorySearch.memoryMatchedSessionKeys;
    }, [memorySearch.lastSuccessfulQuery, memorySearch.memoryMatchedSessionKeys, searchQuery]);
    const searchableTextBySessionKey = useSessionListSearchTextByKey(
        renderPaneState.visibleSessionListIndex ?? [],
        searchQuery.trim().length > 0,
    );
    const searchTrailingAccessory = React.useMemo(() => {
        if (
            !memorySearch.isSearchingMemory
            || searchQuery.trim().length < SESSION_LIST_MEMORY_SEARCH_MIN_QUERY_LENGTH
        ) {
            return undefined;
        }
        return (
            <ActivitySpinner
                testID="session-list-memory-search-loading-indicator"
                size={14}
            />
        );
    }, [memorySearch.isSearchingMemory, searchQuery]);
    const headerFilters = React.useMemo(() => ({
        searchQuery,
        selectedTags: selectedHeaderTags,
        searchableTextBySessionKey,
        memoryMatchedSessionKeys: activeMemoryMatchedSessionKeys,
        controlsAnchorKey: activeSearchHeaderControlsAnchorKey,
    }), [activeMemoryMatchedSessionKeys, activeSearchHeaderControlsAnchorKey, searchQuery, searchableTextBySessionKey, selectedHeaderTags]);
    const baseHeaderControls = React.useMemo(() => ({
        allKnownTags: sessionTagsEnabled === true ? allKnownTags : [],
        selectedTags: selectedHeaderTags,
        searchQuery,
        searchTrailingAccessory,
        onSelectedTagsChange: setSelectedHeaderTags,
        onSearchQueryChange: setSearchQuery,
    }), [allKnownTags, searchQuery, searchTrailingAccessory, selectedHeaderTags, sessionTagsEnabled]);
    React.useEffect(() => {
        if (
            focusedSearchHeaderControlsAnchorKey !== null
            || searchQuery.trim().length > 0
            || selectedHeaderTags.length > 0
        ) {
            return;
        }
        setActiveSearchHeaderControlsAnchorKey(null);
    }, [focusedSearchHeaderControlsAnchorKey, searchQuery, selectedHeaderTags.length]);

    const clearSearchFocusTransferTimeout = React.useCallback(() => {
        if (searchFocusTransferTimeoutRef.current === null) return;
        clearTimeout(searchFocusTransferTimeoutRef.current);
        searchFocusTransferTimeoutRef.current = null;
    }, []);

    React.useEffect(() => () => {
        clearSearchFocusTransferTimeout();
    }, [clearSearchFocusTransferTimeout]);

    const handleHeaderSearchFocusChange = React.useCallback((anchorKey: string, focused: boolean) => {
        clearSearchFocusTransferTimeout();
        if (focused) {
            setActiveSearchHeaderControlsAnchorKey(anchorKey);
            setFocusedSearchHeaderControlsAnchorKey(anchorKey);
            return;
        }

        searchFocusTransferTimeoutRef.current = setTimeout(() => {
            searchFocusTransferTimeoutRef.current = null;
            setFocusedSearchHeaderControlsAnchorKey((current) => current === anchorKey ? null : current);
        }, SEARCH_FOCUS_TRANSFER_SETTLE_MS);
    }, [clearSearchFocusTransferTimeout]);

    React.useEffect(() => {
        if (selectedHeaderTags.length === 0) return;
        const known = new Set(allKnownTags);
        const next = selectedHeaderTags.filter((tag) => known.has(tag));
        if (next.length === selectedHeaderTags.length) return;
        setSelectedHeaderTags(next);
    }, [allKnownTags, selectedHeaderTags]);
    const selectedSessionId = useSessionCanvasSelection({
        selectable: shellFlags.selectable,
        pathname: effectivePathname,
    });
    const sessionSurfaceVisibility = useSessionSurfaceVisibilitySnapshot();
    const focusedSessionId = sessionSurfaceVisibility.focusedSessionId;
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
        { selectedSessionId },
    ), [selectedSessionId, renderPaneState.visibleSessionListIndex]);
    const runtimePrioritySessionRowKeysRaw = useSessionListRuntimePriorityRowKeysForItems(
        renderPaneState.visibleSessionListIndex,
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
        selectedSessionId,
        showServerBadge: shellFlags.showServerBadge,
        showPinnedServerBadge: shellFlags.showPinnedServerBadge,
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

    const visibleSessionNavigationEntries = React.useMemo<VisibleSessionNavigationEntry[]>(() => (
        renderModels.listItems
            .flatMap((item, index) => item.type === 'session'
                ? [{
                    index,
                    sessionId: item.sessionId,
                    sessionKey: buildServerScopedSessionKey(item.sessionId, item.serverId),
                    ...(item.serverId ? { serverId: item.serverId } : null),
                }]
                : [])
    ), [renderModels.listItems]);
    const filteredNoResultsMessage: TranslationKey | undefined = hasActiveSessionListHeaderFilters(headerFilters) && visibleSessionNavigationEntries.length === 0
        ? SESSION_LIST_FILTERED_NO_RESULTS_MESSAGE_KEY
        : undefined;
    const selectionScopeSessionNavigationEntries = React.useMemo<VisibleSessionNavigationEntry[]>(() => (
        renderModels.selectionScopeListItems
            .flatMap((item, index) => item.type === 'session'
                ? [{
                    index,
                    sessionId: item.sessionId,
                    sessionKey: buildServerScopedSessionKey(item.sessionId, item.serverId),
                    ...(item.serverId ? { serverId: item.serverId } : null),
                }]
                : [])
    ), [renderModels.selectionScopeListItems]);
    const knownSessionKeys = React.useMemo(() => (
        visibleSessionNavigationEntries.map((entry) => entry.sessionKey)
    ), [visibleSessionNavigationEntries]);

    const activeSessionKey = React.useMemo(() => {
        if (!activeMruSessionId) return null;
        const activeServerEntry = renderModels.listItems.find((item): item is Extract<SessionListIndexItem, { type: 'session' }> => (
            item.type === 'session'
            && item.sessionId === activeMruSessionId
            && item.serverId === selection.activeServerId
        ));
        const fallbackEntry = renderModels.listItems.find((item): item is Extract<SessionListIndexItem, { type: 'session' }> => (
            item.type === 'session'
            && item.sessionId === activeMruSessionId
        ));
        const entry = activeServerEntry ?? fallbackEntry;
        return entry ? buildServerScopedSessionKey(entry.sessionId, entry.serverId) : null;
    }, [activeMruSessionId, renderModels.listItems, selection.activeServerId]);

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
    const sessionListSelectionScopeKey = React.useMemo(() => buildSessionListSelectionScopeKey({
        storageKind,
        activeServerId: selection.activeServerId ?? null,
        focusedFolderId,
        searchQuery,
        selectedTags: selectedHeaderTags,
        hideInactiveSessions,
    }), [
        focusedFolderId,
        hideInactiveSessions,
        searchQuery,
        selectedHeaderTags,
        selection.activeServerId,
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
        const currentOrder = Array.isArray(sessionMruOrderV1) ? sessionMruOrderV1 : [];
        const nextOrder = moveSessionMruEntryToFront({
            order: currentOrder,
            activeSessionKey,
            knownSessionKeys,
        });
        if (stringArraysEqual(currentOrder, nextOrder)) return;
        setSessionMruOrderV1(nextOrder);
    }, [activeSessionKey, knownSessionKeys, sessionMruOrderV1, setSessionMruOrderV1, surfaceOwnership.dataActive]);

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
            knownSessionKeys,
        });
        const target = resolveSessionMruNavigation({
            order,
            activeSessionKey,
            cursorSessionKey: mruCursorSessionKeyRef.current,
            direction,
        });
        if (!target) return;
        mruCursorSessionKeyRef.current = target.sessionKey;
        navigateToSessionTarget(target);
    }, [activeSessionKey, knownSessionKeys, navigateToSessionTarget, sessionMruOrderV1]);
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

    const handleMoveSessionToFolder = React.useCallback(async (
        sessionId: string,
        serverId: string,
        folderId: string | null,
    ) => {
        try {
            const result = await resolveSessionOrganizationMutationScope(serverId);
            if (!result.ok) {
                Modal.alert(t('common.error'), t('sessionsList.failedToMoveSessionToFolder'));
                return;
            }
            await writeSessionOrganizationFolderAssignment({
                scope: result.scope,
                sessionId,
                folderId,
            });
        } catch {
            Modal.alert(t('common.error'), t('sessionsList.failedToMoveSessionToFolder'));
        }
    }, []);

    const virtualizedListRef = React.useRef<{
        scrollToOffset?: (params: { offset: number; animated?: boolean }) => void;
    } | null>(null);
    const treeViewportRef = React.useRef<TreeDropMeasurableRef | null>(null);
    const scrollToTreeOffset = React.useCallback((offsetY: number) => {
        virtualizedListRef.current?.scrollToOffset?.({ offset: offsetY, animated: false });
    }, []);
    const scrollToRetainedOffset = React.useCallback((params: { offset: number; animated?: boolean }) => {
        virtualizedListRef.current?.scrollToOffset?.(params);
    }, []);

    const rowInteractions = useSessionListRowInteractions({
        folderActionsEnabled: Boolean(folderActionsEnabled),
        sessionFoldersV1: availableSessionFoldersV1,
        listItems: renderModels.listItems,
        currentGroupOrderMap: orderingPersistenceState.currentGroupOrderMap,
        currentWorkspaceOrderMap,
        sessionListFolderSortModeV1,
        sessionListOrderingModeV1,
        sessionListSectionModeV1,
        setSessionListGroupOrderV1,
        setSessionWorkspaceOrderV1,
        setSessionFoldersV1,
        pinnedKeySet: orderingPersistenceState.pinnedKeySet,
        sessionTags: normalizedShellState.sessionTags,
        setSessionPinForKey: setSessionPinForSessionKey,
        setSessionTagsForKey: setSessionTagsForSessionKey,
        scrollToOffset: scrollToTreeOffset,
    });
    const frozenListProjection = useFrozenSessionListItemsDuringDrag({
        activeSnapshot: rowInteractions.activeDragSnapshot,
        liveViewItems: renderModels.listItems,
    });
    const renderedListItems = frozenListProjection.viewItems;
    const statusDemandSubscriptionItems = React.useMemo(() => {
        if (viewableSessionRowKeys !== null) {
            const visibleItems: Array<Extract<SessionListIndexItem, { type: 'session' }>> = [];
            for (const rowKey of viewableSessionRowKeys) {
                const item = buildStatusDemandSessionItemFromRowKey(rowKey);
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
    }, [renderedListItems, viewableSessionRowKeys]);
    const statusDemandRowRenderableByKey = useSessionListRowRenderablesForItems(
        statusDemandSubscriptionItems,
    );
    React.useEffect(() => {
        const entries = collectExternalSessionStatusDemandViewportEntries({
            activeServerId: getActiveServerSnapshot().serverId,
            renderedListItems: statusDemandSubscriptionItems,
            resolveRowRenderable: (rowKey) => statusDemandRowRenderableByKey.get(rowKey) ?? null,
            visibleRowKeys: viewableSessionRowKeys,
        });
        replaceExternalSessionStatusDemandViewport(statusDemandViewportId, entries);
    }, [
        statusDemandRowRenderableByKey,
        statusDemandSubscriptionItems,
        statusDemandViewportId,
        viewableSessionRowKeys,
    ]);
    React.useEffect(() => () => {
        replaceExternalSessionStatusDemandViewport(statusDemandViewportId, []);
    }, [statusDemandViewportId]);
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
                foldersFeatureEnabled: folderActionsEnabled,
            });
            if (target) targets.set(target.key, target);
        }
        return targets;
    }, [
        currentUserId,
        folderActionsEnabled,
        normalizedShellState.sessionTags,
        orderingPersistenceState.pinnedKeySet,
        selectedRowRenderableByKey,
        selectedSessionListItems,
    ]);
    const sessionListItemBySelectionKey = React.useMemo(() => {
        const map = new Map<string, Extract<SessionListIndexItem, { type: 'session' }>>();
        for (const item of renderedListItems) {
            if (item.type !== 'session') continue;
            map.set(buildServerScopedSessionKey(item.sessionId, item.serverId), item);
        }
        return map;
    }, [renderedListItems]);

    const rowLabelByTreeRowId = React.useMemo(() => {
        const labels = new Map<string, string>();
        for (const item of renderedListItems) {
            if (item.type === 'session') {
                labels.set(resolveTreeRowIdForSessionItem(item), item.sessionId);
                continue;
            }
            if (item.headerKind === 'folder' && item.folderId) {
                labels.set(treeRowId.folder(item.folderId), item.title);
            } else if (item.headerKind === 'project' && (item.groupKey || item.workspaceKey)) {
                labels.set(resolveWorkspaceRootTreeRowId(item), item.title);
            }
        }
        return labels;
    }, [renderedListItems]);

    const resolveDropDestinationLabel = React.useCallback((target: SessionListMoveSheetTarget) => {
        if (target.kind === 'root') return t('sessionsList.moveToWorkspaceRoot');
        return target.label;
    }, []);

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

    const applyMoveTargetWithAnnouncement = React.useCallback((
        sourceRowId: string,
        sourceLabel: string,
        target: SessionListMoveSheetTarget,
    ) => {
        rowInteractions.applyMoveSheetTarget(sourceRowId, target);
        sessionListA11y.announceDropResult({
            label: sourceLabel,
            destinationLabel: resolveDropDestinationLabel(target),
            result: target.result,
        });
    }, [resolveDropDestinationLabel, rowInteractions, sessionListA11y]);

    const openMoveSheetForTreeRow = React.useCallback(async (sourceRowId: string, sourceLabel: string) => {
        const targets = rowInteractions.resolveMoveSheetTargets(sourceRowId);
        if (targets.length === 0) return;
        const selectedTarget = await openMoveSheet({
            sourceLabel,
            targets,
        });
        if (!selectedTarget) return;
        applyMoveTargetWithAnnouncement(sourceRowId, sourceLabel, selectedTarget);
    }, [applyMoveTargetWithAnnouncement, openMoveSheet, rowInteractions]);

    const moveTreeRowToWorkspaceRoot = React.useCallback((sourceRowId: string, sourceLabel: string) => {
        const rootTarget = rowInteractions.resolveMoveSheetTargets(sourceRowId).find((target) =>
            target.kind === 'root' && !target.disabled
        );
        if (!rootTarget) return;
        applyMoveTargetWithAnnouncement(sourceRowId, sourceLabel, rootTarget);
    }, [applyMoveTargetWithAnnouncement, rowInteractions]);

    const moveTreeRowByKeyboard = React.useCallback((
        sourceRowId: string,
        sourceLabel: string,
        direction: 'up' | 'down',
    ) => {
        const result = rowInteractions.applyKeyboardMove(sourceRowId, direction);
        if (!result) return;
        sessionListA11y.announceDropResult({
            label: sourceLabel,
            destinationLabel: resolveDropResultDestinationLabel(result),
            result,
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
                    const rowId = resolveSessionTreeRowId(activeSessionKey);
                    if (!rowId) return;
                    void openMoveSheetForTreeRow(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'));
                },
                'sessions.row.moveToWorkspaceRoot': () => {
                    const rowId = resolveSessionTreeRowId(activeSessionKey);
                    if (!rowId) return;
                    moveTreeRowToWorkspaceRoot(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'));
                },
                'sessions.row.moveUp': () => {
                    const rowId = resolveSessionTreeRowId(activeSessionKey);
                    if (!rowId) return;
                    moveTreeRowByKeyboard(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'), 'up');
                },
                'sessions.row.moveDown': () => {
                    const rowId = resolveSessionTreeRowId(activeSessionKey);
                    if (!rowId) return;
                    moveTreeRowByKeyboard(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'), 'down');
                },
            }
            : {}
    ), [
        activeSessionKey,
        moveTreeRowByKeyboard,
        moveTreeRowToWorkspaceRoot,
        openMoveSheetForTreeRow,
        rowLabelByTreeRowId,
        surfaceOwnership.interactive,
    ]));

    const {
        handleOpenProject,
        handleCreateSessionFromWorkspaceScope,
        handleOpenArchivedSessions,
    } = useSessionListNavigationActions();
    const {
        handleRenameWorkspace,
        handleResetWorkspaceName,
        handleToggleCollapse,
    } = useSessionListWorkspaceHeaderActions({
        workspaceRefs: normalizedShellState.workspaceRefs,
        setWorkspaceRefs: setWorkspaceRefsV1,
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
        setSessionFoldersV1(created.next);
    }, [availableSessionFoldersV1, setSessionFoldersV1]);

    const handleFocusSessionFolder = React.useCallback((item: Extract<SessionListIndexItem, { type: 'header' }>) => {
        if (!item.folderId || !item.workspace) return;
        if (rowInteractions.consumeFolderFocusPressAfterDrag()) return;
        setSessionListFocusedFolderV1({
            folderId: item.folderId,
            workspace: item.workspace,
            serverId: item.serverId ?? item.workspace.serverId ?? null,
        });
    }, [rowInteractions.consumeFolderFocusPressAfterDrag, setSessionListFocusedFolderV1]);

    const handleCreateSessionFromFolder = React.useCallback((item: Extract<SessionListIndexItem, { type: 'header' }>) => {
        if (!item.workspaceScopeHint) return;
        handleCreateSessionFromWorkspaceScope(item.workspaceScopeHint, {
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
        setSessionFoldersV1(created.next);
    }, [availableSessionFoldersV1, setSessionFoldersV1]);

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
            folderId: item.folderId,
            name,
            now: Date.now(),
        });
        setSessionFoldersV1(renamed.next);
    }, [availableSessionFoldersV1, setSessionFoldersV1]);

    const handleDeleteFolder = React.useCallback(async (item: Extract<SessionListIndexItem, { type: 'header' }>) => {
        if (!item.folderId) return;
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
            folderId: item.folderId,
        });
        if (deleted.deletedFolderIds.length === 0) return;
        setSessionFoldersV1(deleted.next);
        if (
            sessionListFocusedFolderV1
            && deleted.deletedFolderIds.includes(sessionListFocusedFolderV1.folderId)
        ) {
            setSessionListFocusedFolderV1(null);
        }
    }, [availableSessionFoldersV1, sessionListFocusedFolderV1, setSessionFoldersV1, setSessionListFocusedFolderV1]);

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
            foldersFeatureEnabled: folderActionsEnabled,
        });
        if (!organizationEligibility.canUseSessionFolders || !item.workspace) {
            return EMPTY_SESSION_FOLDER_MOVE_TARGETS;
        }
        const rowId = resolveTreeRowIdForSessionItem(item);
        const signature = [
            sessionFoldersSignature,
            buildSessionFolderWorkspaceSignature(item.workspace),
            item.folderId ?? '',
        ].join('\u0001');
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
    }, [availableSessionFoldersV1, folderActionsEnabled, sessionFoldersSignature]);
    const sessionListBulkActionContext = React.useMemo<SessionBulkActionExecutionContext>(() => ({
        setSessionPin: async ({ target, pinned }) => {
            await setSessionPinForTarget(target, pinned);
        },
        setSessionTagAssignments: async ({ target, tags }) => {
            await setSessionTagAssignmentsForTarget(target, tags);
        },
        hideInactiveSessions: hideInactiveSessions === true,
        foldersFeatureDecision: { state: folderActionsEnabled ? 'enabled' : 'disabled' },
        stopErrorMessage: t('sessionInfo.failedToStopSession'),
        archiveErrorMessage: t('sessionInfo.failedToArchiveSession'),
        stopSession: async (target) => await sessionStopWithServerScope(target.sessionId, { serverId: target.serverId ?? null }),
        archiveSession: async (target) => {
            const result = await sessionArchiveWithServerScope(target.sessionId, { serverId: target.serverId ?? null });
            if (result.success) {
                clearSessionVisibleWhenInactive(target.sessionId);
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
                sessionId: params.sessionId,
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
            if (!scope) {
                throw new Error('Session folder assignment requires an available server profile');
            }
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
        const folderMoveTargets = resolveFolderMoveTargetsForItem(firstMovableItem);
        const folderIdByTargetId = new Map<string, string | null>();
        const moveTargets = folderMoveTargets.map((target): SessionListMoveSheetTarget => {
            const id = `bulk-move-folder:${target.folderId ?? 'root'}`;
            folderIdByTargetId.set(id, target.folderId ?? null);
            return {
                id,
                kind: target.folderId == null ? 'root' : 'folder',
                label: target.folderId == null ? t('sessionsList.moveToWorkspaceRoot') : target.title,
                disabled: target.disabled,
                result: SESSION_LIST_IDLE_MOVE_RESULT,
            };
        }).filter((target) => target.disabled !== true);
        if (moveTargets.length === 0) return null;
        const selectedTarget = await openMoveSheet({
            sourceLabel: t('sessionsList.selectionMoveSheetSourceLabel', { count: targets.length }),
            targets: moveTargets,
        });
        if (!selectedTarget || selectedTarget.disabled || !folderIdByTargetId.has(selectedTarget.id)) return null;
        return {
            folderId: folderIdByTargetId.get(selectedTarget.id) ?? null,
            destinationWorkspace,
        };
    }, [folderActionsEnabled, openMoveSheet, resolveFolderMoveTargetsForItem, sessionListItemBySelectionKey]);

    const {
        scopeHintByLegacyWorkspaceKey,
        projectHeaderViewModelByGroupKey,
    } = renderModels.projectHeaderViewModelState;

    const fallbackHeaderControlsAnchorKey = React.useMemo(() => {
        const anchor = renderModels.listItems.find((item): item is Extract<SessionListIndexItem, { type: 'header' }> =>
            item.type === 'header' && isSessionListPrimaryHeaderKind(item.headerKind)
        );
        return anchor ? getSessionListHeaderControlsAnchorKey(anchor) : null;
    }, [renderModels.listItems]);
    const headerControlsAnchorKey = activeSearchHeaderControlsAnchorKey
        ?? (hasActiveSessionListHeaderFilters(headerFilters) ? fallbackHeaderControlsAnchorKey : null);

    useSessionListWorkspaceLabelMigration({
        workspaceLabels: normalizedShellState.workspaceLabels,
        setWorkspaceLabels: setWorkspaceLabelsV1,
        workspaceRefs: normalizedShellState.workspaceRefs,
        setWorkspaceRefs: setWorkspaceRefsV1,
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
                const rowId = treeRowId.folder(folderItem.folderId);
                void openMoveSheetForTreeRow(rowId, rowLabelByTreeRowId.get(rowId) ?? folderItem.title);
            }}
            onMoveFolderToWorkspaceRoot={(folderItem) => {
                if (!folderItem.folderId) return;
                const rowId = treeRowId.folder(folderItem.folderId);
                moveTreeRowToWorkspaceRoot(rowId, rowLabelByTreeRowId.get(rowId) ?? folderItem.title);
            }}
            onMoveFolderUp={(folderItem) => {
                if (!folderItem.folderId) return;
                const rowId = treeRowId.folder(folderItem.folderId);
                moveTreeRowByKeyboard(rowId, rowLabelByTreeRowId.get(rowId) ?? folderItem.title, 'up');
            }}
            onMoveFolderDown={(folderItem) => {
                if (!folderItem.folderId) return;
                const rowId = treeRowId.folder(folderItem.folderId);
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
            headerControls={
                isSessionListPrimaryHeaderKind(item.headerKind)
                && (
                    headerControlsAnchorKey === null
                    || getSessionListHeaderControlsAnchorKey(item) === headerControlsAnchorKey
                )
                    ? {
                        ...baseHeaderControls,
                        searchOpen: focusedSearchHeaderControlsAnchorKey === getSessionListHeaderControlsAnchorKey(item),
                        onSearchFocusChange: (focused: boolean) => {
                            const anchorKey = getSessionListHeaderControlsAnchorKey(item);
                            handleHeaderSearchFocusChange(anchorKey, focused);
                        },
                    }
                    : undefined
            }
        />
    ), [
        baseHeaderControls,
        collapsedKeys,
        focusedSearchHeaderControlsAnchorKey,
        handleHeaderSearchFocusChange,
        headerControlsAnchorKey,
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
            || rowSubscriptionKeys.has(rowScopeKey)
            || isSessionListRowStorePriorityItem(item, { selectedSessionId });
        const moveActionHandlers = getRowMoveActionHandlers({
            sourceRowId: treeRowIdForItem,
            sourceLabel: rowLabelByTreeRowId.get(treeRowIdForItem) ?? item.sessionId,
            item,
        });
        const canUseSessionFolders = resolveSessionListItemOrganizationEligibility(item, {
            foldersFeatureEnabled: folderActionsEnabled,
        }).canUseSessionFolders;
        return (
            <SessionListRowViewModelBoundary
                item={item}
                items={renderedListItems}
                rowHeight={densityViewState.rowHeight}
                dataActive={surfaceOwnership.dataActive}
                dragEnabled={shellFlags.canDragSessionRows}
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
                pinnedSessionKeys={orderingPersistenceState.pinnedKeySet}
                reachableSessionDisplayById={renderModels.reachableSessionDisplayById}
                reachableSessionDisplayByKey={renderModels.reachableSessionDisplayByKey}
                rowAttentionAnimationEnabled={rowAttentionAnimationEnabled}
                selectedSessionId={selectedSessionId}
                sessionTags={normalizedShellState.sessionTags}
                showPinnedServerBadge={shellFlags.showPinnedServerBadge}
                showServerBadge={shellFlags.showServerBadge}
                workingIndicatorMode={sessionListWorkingIndicatorStyle === 'pulse' ? 'pulse' : 'spinner'}
                workingTextMode={sessionListWorkingStatusAnimatedTextEnabled === false ? 'static' : 'animated'}
                folderMoveTargets={resolveFolderMoveTargetsForItem(item)}
                onMoveToSessionFolder={canUseSessionFolders ? moveActionHandlers.onMoveToSessionFolder : undefined}
                onMoveToFolder={canUseSessionFolders ? moveActionHandlers.onMoveToFolder : undefined}
                onMoveToWorkspaceRoot={canUseSessionFolders ? moveActionHandlers.onMoveToWorkspaceRoot : undefined}
                onMoveUp={canUseSessionFolders ? moveActionHandlers.onMoveUp : undefined}
                onMoveDown={canUseSessionFolders ? moveActionHandlers.onMoveDown : undefined}
            />
        );
    }, [
        allKnownTags,
        currentUserId,
        densityViewState.compact,
        densityViewState.compactMinimal,
        densityViewState.rowHeight,
        rowSubscriptionKeys,
        selectedSessionId,
        folderActionsEnabled,
        hideInactiveSessions,
        normalizedShellState.sessionTags,
        orderingPersistenceState.pinnedKeySet,
        renderModels.hasMultipleMachines,
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
        shellFlags.canDragSessionRows,
        shellFlags.showPinnedServerBadge,
        shellFlags.showServerBadge,
        surfaceOwnership.dataActive,
        getRowMoveActionHandlers,
        rowLabelByTreeRowId,
    ]);

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
        const filtersActive = hasActiveSessionListHeaderFilters(headerFilters);
        const nodes: SessionListVirtualizedNode[] = [];
        renderedListItems.forEach((item, index) => {
            const id = buildSessionListIndexNodeId(item);
            const cached = previous.get(id);
            if (cached && areSessionListIndexItemsEqual(cached.item, item)) {
                next.set(id, cached);
                nodes.push(cached.node);
            } else {
                const entry = {
                    item,
                    node: {
                        id,
                    },
                };
                next.set(id, entry);
                nodes.push(entry.node);
            }
            if (shouldInsertFilteredNoResultsAfterHeader({
                item,
                itemIndex: index,
                items: renderedListItems,
                filtersActive,
                headerControlsAnchorKey,
            })) {
                nodes.push({
                    id: `filtered-no-results:${id}`,
                    kind: 'filteredNoResults',
                    rowViewModel: null,
                });
            }
        });
        virtualizedNodeCacheRef.current = next;
        const previousNodes = previousVirtualizedNodesRef.current;
        const output = areVirtualizedNodeArraysReferenceEqual(previousNodes, nodes) ? previousNodes : nodes;
        previousVirtualizedNodesRef.current = output;
        return output;
    }, [headerControlsAnchorKey, headerFilters, renderedListItems]);

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
            if (!item || item.type !== 'session') continue;
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
    const allKnownTagsSignature = React.useMemo(() => buildStringListSignature(allKnownTags), [allKnownTags]);
    const rowLabelsSignature = React.useMemo(() => buildRowLabelSignature(rowLabelByTreeRowId), [rowLabelByTreeRowId]);
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
        canDragSessionRows: shellFlags.canDragSessionRows,
        compact: Boolean(densityViewState.compact),
        compactMinimal: Boolean(densityViewState.compact && densityViewState.compactMinimal),
        currentUserId,
        dragSnapshotId: frozenListProjection.snapshotId,
        draggingSessionKey: rowInteractions.draggingSessionKey,
        folderActionsEnabled,
        nativeContextMenuSessionKey: rowInteractions.nativeContextMenuSessionKey,
        rowHeight: densityViewState.rowHeight,
        rowLabelsSignature,
        sessionFoldersSignature,
        sessionTagsEnabled: sessionTagsEnabled === true,
        sessionTagsSignature,
        workspaceLabelsSignature,
    }), [
        allKnownTagsSignature,
        currentUserId,
        densityViewState.compact,
        densityViewState.compactMinimal,
        densityViewState.rowHeight,
        frozenListProjection.snapshotId,
        folderActionsEnabled,
        rowInteractions.draggingSessionKey,
        rowInteractions.nativeContextMenuSessionKey,
        rowLabelsSignature,
        sessionFoldersSignature,
        sessionTagsEnabled,
        sessionTagsSignature,
        shellFlags.canDragSessionRows,
        workspaceLabelsSignature,
    ]);

    const renderVirtualizedItem = React.useCallback((params: { item: SessionListVirtualizedNode; index: number }) => {
        if (params.item.kind === 'filteredNoResults') {
            return <SessionListFilteredNoResultsMessage />;
        }
        const item = nodeByIdRef.current.get(params.item.id) ?? listItemsRef.current[params.index] ?? null;
        if (!item) return null;
        if (item.type === 'header') return renderHeaderItemRef.current(item, params.index);
        return renderSessionItemRef.current(item, params.index);
    }, []);
    const handleClearFolderFocus = React.useCallback(() => {
        setSessionListFocusedFolderV1(null);
    }, [setSessionListFocusedFolderV1]);
    const handleSelectFolderBreadcrumb = React.useCallback((folderId: string) => {
        const folder = renderPaneState.folderFocus?.breadcrumbs.find((candidate) => candidate.id === folderId) ?? null;
        if (!folder) return;
        setSessionListFocusedFolderV1({
            folderId: folder.id,
            workspace: folder.workspace,
            serverId: folder.workspace.serverId ?? null,
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
        nodes: virtualizedNodes,
        nodeIds,
        rowHeight: densityViewState.rowHeight,
        rowDensity: (densityViewState.compact
            ? (densityViewState.compactMinimal ? 'minimal' : 'compact')
            : 'default') as 'default' | 'compact' | 'minimal',
        filteredNoResultsMessage,
        renderVirtualizedItem,
        scrollToOffset: scrollToRetainedOffset,
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
        onPressArchivedSessions: handleOpenArchivedSessions,
        keyboardZoneProps,
        sessionListSelectionStore,
        sessionListSelectionTargetsByKey,
        sessionListBulkActionContext,
        onRequestBulkMoveToFolder: folderActionsEnabled ? handleRequestBulkMoveToFolder : undefined,
        tagsEnabled: sessionTagsEnabled === true,
        folderFocus: renderPaneState.folderFocus,
        folderFocusRootTitle,
        dropOverlayShared: rowInteractions.dropOverlayShared,
        onClearFolderFocus: handleClearFolderFocus,
        onSelectFolderBreadcrumb: handleSelectFolderBreadcrumb,
    };
}
