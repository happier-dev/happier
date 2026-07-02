import * as React from 'react';
import { Platform, type ViewToken } from 'react-native';
import { usePathname } from 'expo-router';
import { useSetting, useSettingMutable, useMachineDisplayById, useProfile, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useIsTablet } from '@/utils/platform/responsive';
import { useSessionListSelectionState } from '@/hooks/session/useSessionListSelectionState';
import { getAllKnownTags, sessionTagKey } from './sessionTagUtils';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { resolveSessionListShellFlags } from './resolveSessionListShellFlags';
import { resolveSessionListDensityViewState } from './resolveSessionListDensityViewState';
import { resolveSessionListOrderingPersistenceState } from './resolveSessionListOrderingPersistenceState';
import { SessionListHeaderItem } from './sessionListHeaderItem';
import { SessionListSessionItem } from './sessionListSessionItem';
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
import { useFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { Modal } from '@/modal';
import { t } from '@/text';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type { TreeDropMeasurableRef } from '@/components/ui/treeDragDrop';
import {
    moveSessionFolderAssignments,
    setSessionFolderAssignment as setSessionFolderAssignmentOp,
} from '@/sync/ops/sessionFolders';
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
    DEFAULT_SESSION_FOLDERS_V1,
    normalizeSessionFolders,
    renameSessionFolder,
    type SessionFolderMoveTarget,
    type SessionFolderWorkspaceRefV1,
    resolveDurableWorkspaceRefForSessionListHeader,
    type SessionFoldersV1,
} from '@/sync/domains/session/folders';
import { resolveWorkspaceRootTreeRowId, treeRowId } from './drop-resolution/treeRowId';
import type { SessionListRowViewModel } from './sessionListRowViewModels';
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
import type { SessionListVirtualizedNode } from './sessionListVirtualizedContent';
import {
    buildSessionListRowStorePriorityKeys,
    isSessionListRowStorePriorityItem,
    resolveSessionListRowStoreScopeKey,
    resolveSessionListRowStoreSubscriptionKeys,
} from './row/sessionListVisibleRowStoreScopes';
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

const SEARCH_FOCUS_TRANSFER_SETTLE_MS = 50;
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

function resolveSessionTreeRowId(sessionKey: string | null): string | null {
    if (!sessionKey) return null;
    const separatorIndex = sessionKey.indexOf(':');
    if (separatorIndex <= 0) return null;
    const serverId = sessionKey.slice(0, separatorIndex);
    const sessionId = sessionKey.slice(separatorIndex + 1);
    return serverId && sessionId ? treeRowId.session(serverId, sessionId) : null;
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

function buildSessionBulkActionTargetFromRowViewModel(
    rowViewModel: SessionListRowViewModel,
    currentUserId: string | null,
): SessionBulkActionTarget | null {
    if (!rowViewModel.session || !rowViewModel.sessionKey || !rowViewModel.sessionStatus) return null;
    const separatorIndex = rowViewModel.sessionKey.indexOf(':');
    const serverId = separatorIndex > 0 ? rowViewModel.sessionKey.slice(0, separatorIndex) : null;
    const actionTarget = createSessionActionTarget({
        session: rowViewModel.session,
        serverId,
        currentUserId,
        isConnected: rowViewModel.sessionStatus.isConnected,
        isPinned: rowViewModel.pinned,
    });
    const readState = actionTarget.readStateAction.visible
        ? actionTarget.readStateAction.targetState === 'read'
            ? 'unread'
            : 'read'
        : undefined;

    return {
        key: rowViewModel.sessionKey,
        sessionId: rowViewModel.session.id,
        serverId,
        active: actionTarget.isActive,
        archived: actionTarget.isArchived,
        pinned: actionTarget.isPinned,
        hasAdminAccess: actionTarget.hasAdminAccess,
        canStop: actionTarget.canStop,
        canArchive: actionTarget.canArchive,
        tags: rowViewModel.tags,
        readState,
    };
}

function buildStringListSignature(values: ReadonlyArray<string> | null | undefined): string {
    if (!values || values.length === 0) return '';
    return values.join('\u0001');
}

function buildStringSetSignature(values: ReadonlySet<string> | null | undefined): string {
    if (!values) return '*';
    if (values.size === 0) return '';
    return Array.from(values).sort((left, right) => left.localeCompare(right)).join('\u0001');
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
    const [pinnedSessionKeysV1, setPinnedSessionKeysV1] = useSettingMutable('pinnedSessionKeysV1');
    const [sessionListGroupOrderV1, setSessionListGroupOrderV1] = useSettingMutable('sessionListGroupOrderV1');
    const [sessionWorkspaceOrderV1, setSessionWorkspaceOrderV1] = useSettingMutable('sessionWorkspaceOrderV1');
    const [sessionListOrderingModeV1] = useSettingMutable('sessionListOrderingModeV1');
    const sessionListSectionModeV1 = useSetting('sessionListSectionModeV1') === 'single'
        ? 'single'
        : 'activity';
    const sessionListFolderSortModeV1 = useSetting('sessionListFolderSortModeV1') === 'mixed' ? 'mixed' : 'foldersFirst';
    const sessionFolderViewModeV1 = useSetting('sessionFolderViewModeV1') === 'tree' ? 'tree' : 'off';
    const [sessionTagsV1, setSessionTagsV1] = useSettingMutable('sessionTagsV1');
    const sessionTagsEnabled = useSetting('sessionTagsEnabled');
    const [workspaceLabelsV1, setWorkspaceLabelsV1] = useSettingMutable('workspaceLabelsV1');
    const [workspaceRefsV1, setWorkspaceRefsV1] = useSettingMutable('workspaceRefsV1');
    const workspacePathDisplayModeV1 = useSetting('workspacePathDisplayModeV1');
    const workspaceFaviconsEnabled = useSetting('workspaceFaviconsEnabled') !== false;
    const workspaceMachineSubtitlesEnabled = useSetting('workspaceMachineSubtitlesEnabled') !== false;
    const [sessionFoldersV1Raw, setSessionFoldersV1] = useSettingMutable('sessionFoldersV1') as [
        SessionFoldersV1 | null | undefined,
        (value: SessionFoldersV1) => void,
    ];
    const [collapsedGroupKeysV1, setCollapsedGroupKeysV1] = useSettingMutable('collapsedGroupKeysV1');
    const [sessionMruOrderV1, setSessionMruOrderV1] = useLocalSettingMutable('sessionMruOrderV1');
    const [sessionListFocusedFolderV1, setSessionListFocusedFolderV1] = useLocalSettingMutable('sessionListFocusedFolderV1');
    const [activeSearchHeaderControlsAnchorKey, setActiveSearchHeaderControlsAnchorKey] = React.useState<string | null>(null);
    const [focusedSearchHeaderControlsAnchorKey, setFocusedSearchHeaderControlsAnchorKey] = React.useState<string | null>(null);
    const searchFocusTransferTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const sessionFoldersFeatureEnabled = useFeatureEnabled('sessions.folders');
    const folderActionsEnabled = storageKind !== 'direct' && sessionFoldersFeatureEnabled;
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
    const densityViewState = resolveSessionListDensityViewState(sessionListDensity);
    const currentUserId = typeof profile?.id === 'string' ? profile.id : null;
    const selection = useSessionListSelectionState();
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
    const normalizedShellState = normalizeSessionListShellState({
        collapsedGroupKeys: collapsedGroupKeysV1,
        sessionTags: sessionTagsV1,
        workspaceLabels: workspaceLabelsV1,
        workspaceRefs: workspaceRefsV1,
    });
    const sessionFoldersV1 = React.useMemo(
        () => normalizeSessionFolders(sessionFoldersV1Raw ?? DEFAULT_SESSION_FOLDERS_V1),
        [sessionFoldersV1Raw],
    );
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
    const sessionListMemoryCandidateKeys = React.useMemo(
        () => buildSessionListMemoryCandidateKeySet(sessionListPaneState.visibleSessionListIndex ?? []),
        [sessionListPaneState.visibleSessionListIndex],
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
        sessionListPaneState.visibleSessionListIndex ?? [],
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
    const focusedSessionId = useFocusedSessionId();
    const activeMruSessionId = React.useMemo(() => resolveSelectedSessionIdForList({
        selectable: true,
        pathname: effectivePathname,
        focusedSessionId,
    }), [effectivePathname, focusedSessionId]);
    const [viewableSessionRowKeys, setViewableSessionRowKeys] = React.useState<ReadonlySet<string> | null>(null);
    const prioritySessionRowKeys = React.useMemo(() => buildSessionListRowStorePriorityKeys(
        sessionListPaneState.visibleSessionListIndex ?? [],
        { selectedSessionId },
    ), [selectedSessionId, sessionListPaneState.visibleSessionListIndex]);
    const rowSubscriptionKeys = React.useMemo(() => (
        surfaceOwnership.dataActive
            ? resolveSessionListRowStoreSubscriptionKeys(viewableSessionRowKeys, prioritySessionRowKeys)
            : EMPTY_VIEWABLE_SESSION_ROW_KEYS
    ), [prioritySessionRowKeys, surfaceOwnership.dataActive, viewableSessionRowKeys]);

    const renderModels = useSessionListRenderModels({
        paneState: sessionListPaneState,
        collapsedGroupKeys: normalizedShellState.collapsedGroupKeys,
        machineDisplayById,
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
    const focusedFolderId = sessionListPaneState.folderFocus?.folder.id ?? sessionListFocusedFolderV1?.folderId ?? null;
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
        const profile = listServerProfiles().find((candidate) => candidate.id === serverId);
        if (!profile) {
            Modal.alert(t('common.error'), t('sessionsList.failedToMoveSessionToFolder'));
            return;
        }
        const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId });
        if (!credentials) {
            Modal.alert(t('common.error'), t('sessionsList.failedToMoveSessionToFolder'));
            return;
        }
        try {
            await setSessionFolderAssignmentOp({
                credentials,
                serverId,
                serverUrl: profile.serverUrl,
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
        sessionFoldersV1,
        listItems: renderModels.listItems,
        currentGroupOrderMap: orderingPersistenceState.currentGroupOrderMap,
        currentWorkspaceOrderMap,
        sessionListFolderSortModeV1,
        sessionListOrderingModeV1,
        sessionListSectionModeV1,
        setSessionListGroupOrderV1,
        setSessionWorkspaceOrderV1,
        setSessionFoldersV1,
        pinnedKeyList: orderingPersistenceState.pinnedKeyList,
        pinnedKeySet: orderingPersistenceState.pinnedKeySet,
        setPinnedSessionKeysV1,
        sessionTags: normalizedShellState.sessionTags,
        setSessionTagsV1,
        scrollToOffset: scrollToTreeOffset,
    });
    const frozenListProjection = useFrozenSessionListItemsDuringDrag({
        activeSnapshot: rowInteractions.activeDragSnapshot,
        liveViewItems: renderModels.listItems,
    });
    const renderedListItems = frozenListProjection.viewItems;
    const rowViewModelByNodeId = React.useMemo(() => {
        const map = new Map<string, SessionListRowViewModel | null>();
        for (let index = 0; index < renderModels.listItems.length; index += 1) {
            const item = renderModels.listItems[index];
            if (!item || item.type !== 'session') continue;
            map.set(buildSessionListIndexNodeId(item), renderModels.rowViewModels[index] ?? null);
        }
        return map;
    }, [renderModels.listItems, renderModels.rowViewModels]);
    const renderedRowViewModels = React.useMemo(() => (
        renderedListItems.map((item) => item.type === 'session'
            ? rowViewModelByNodeId.get(buildSessionListIndexNodeId(item)) ?? null
            : null)
    ), [renderedListItems, rowViewModelByNodeId]);
    const sessionListSelectionTargetsByKey = React.useMemo(() => {
        const targets = new Map<string, SessionBulkActionTarget>();
        for (const rowViewModel of renderModels.selectionScopeRowViewModels) {
            if (!rowViewModel) continue;
            const target = buildSessionBulkActionTargetFromRowViewModel(rowViewModel, currentUserId);
            if (target) targets.set(target.key, target);
        }
        return targets;
    }, [currentUserId, renderModels.selectionScopeRowViewModels]);
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
            current: sessionFoldersV1,
            workspace,
            renderWorkspaceKey: item.workspaceKey,
            parentId: null,
            name,
            now: Date.now(),
        });
        setSessionFoldersV1(created.next);
    }, [sessionFoldersV1, setSessionFoldersV1]);

    const handleFocusSessionFolder = React.useCallback((item: Extract<SessionListIndexItem, { type: 'header' }>) => {
        if (!item.folderId || !item.workspace) return;
        setSessionListFocusedFolderV1({
            folderId: item.folderId,
            workspace: item.workspace,
            serverId: item.serverId ?? item.workspace.serverId ?? null,
        });
    }, [setSessionListFocusedFolderV1]);

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
            current: sessionFoldersV1,
            workspace: item.workspace,
            renderWorkspaceKey: item.workspaceKey,
            parentId: item.folderId,
            name,
            now: Date.now(),
        });
        setSessionFoldersV1(created.next);
    }, [sessionFoldersV1, setSessionFoldersV1]);

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
            current: sessionFoldersV1,
            folderId: item.folderId,
            name,
            now: Date.now(),
        });
        setSessionFoldersV1(renamed.next);
    }, [sessionFoldersV1, setSessionFoldersV1]);

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
            current: sessionFoldersV1,
            folderId: item.folderId,
        });
        if (deleted.deletedFolderIds.length === 0) return;
        const serverId = String(item.serverId ?? item.workspace?.serverId ?? '').trim();
        const profile = serverId ? listServerProfiles().find((candidate) => candidate.id === serverId) : null;
        if (profile) {
            const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id });
            if (credentials) {
                await moveSessionFolderAssignments({
                    credentials,
                    serverId: profile.id,
                    serverUrl: profile.serverUrl,
                    fromFolderIds: deleted.deletedFolderIds,
                    toFolderId: deleted.replacementFolderId,
                });
            }
        }
        setSessionFoldersV1(deleted.next);
        if (
            sessionListFocusedFolderV1
            && deleted.deletedFolderIds.includes(sessionListFocusedFolderV1.folderId)
        ) {
            setSessionListFocusedFolderV1(null);
        }
    }, [sessionFoldersV1, sessionListFocusedFolderV1, setSessionFoldersV1, setSessionListFocusedFolderV1]);

    const sessionFoldersSignature = React.useMemo(
        () => buildSessionFoldersSignature(sessionFoldersV1),
        [sessionFoldersV1],
    );
    const folderMoveTargetsByRowIdRef = React.useRef(new Map<string, Readonly<{
        signature: string;
        value: readonly SessionFolderMoveTarget[];
    }>>());
    const resolveFolderMoveTargetsForItem = React.useCallback((
        item: Extract<SessionListIndexItem, { type: 'session' }>,
    ): readonly SessionFolderMoveTarget[] => {
        if (storageKind === 'direct' || !item.workspace || !item.serverId) return EMPTY_SESSION_FOLDER_MOVE_TARGETS;
        const rowId = resolveTreeRowIdForSessionItem(item);
        const signature = [
            sessionFoldersSignature,
            buildSessionFolderWorkspaceSignature(item.workspace),
            item.folderId ?? '',
        ].join('\u0001');
        const cached = folderMoveTargetsByRowIdRef.current.get(rowId);
        if (cached?.signature === signature) return cached.value;
        const value = buildSessionFolderMoveTargets({
            folders: sessionFoldersV1,
            workspace: item.workspace,
            currentFolderId: item.folderId ?? null,
            workspaceRootTitle: t('sessionsList.workspaceRoot'),
        });
        folderMoveTargetsByRowIdRef.current.set(rowId, { signature, value });
        return value;
    }, [sessionFoldersSignature, sessionFoldersV1, storageKind]);
    const sessionListBulkActionContext = React.useMemo<SessionBulkActionExecutionContext>(() => ({
        pinnedSessionKeysV1: orderingPersistenceState.pinnedKeyList,
        setPinnedSessionKeysV1,
        sessionTagsV1: normalizedShellState.sessionTags,
        setSessionTagsV1,
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
            const serverId = typeof target.serverId === 'string' ? target.serverId.trim() : '';
            if (!serverId) {
                throw new Error('Session folder assignment requires a server id');
            }
            const profile = listServerProfiles().find((candidate) => candidate.id === serverId);
            if (!profile) {
                throw new Error('Session folder assignment requires an available server profile');
            }
            const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId });
            if (!credentials) {
                throw new Error('Session folder assignment requires server credentials');
            }
            await setSessionFolderAssignmentOp({
                credentials,
                serverId,
                serverUrl: profile.serverUrl,
                sessionId: target.sessionId,
                folderId,
            });
        },
    }), [
        folderActionsEnabled,
        hideInactiveSessions,
        normalizedShellState.sessionTags,
        orderingPersistenceState.pinnedKeyList,
        setPinnedSessionKeysV1,
        setSessionTagsV1,
    ]);
    const handleRequestBulkMoveToFolder = React.useCallback(async (targets: readonly SessionBulkActionTarget[]) => {
        if (!folderActionsEnabled || targets.length === 0) return null;
        const firstMovableItem = targets
            .map((target) => sessionListItemBySelectionKey.get(target.key) ?? null)
            .find((item): item is Extract<SessionListIndexItem, { type: 'session' }> => Boolean(item && item.workspace && item.serverId));
        if (!firstMovableItem) return null;
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
        nodeRowViewModel?: SessionListRowViewModel | null,
    ) => {
        const rowViewModel = nodeRowViewModel ?? rowViewModelByNodeId.get(buildSessionListIndexNodeId(item)) ?? null;
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
        return (
            <SessionListSessionItem
                item={item}
                rowViewModel={rowViewModel}
                rowHeight={densityViewState.rowHeight}
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
                compact={Boolean(densityViewState.compact)}
                compactMinimal={Boolean(densityViewState.compact && densityViewState.compactMinimal)}
                rowAttentionAnimationEnabled={rowAttentionAnimationEnabled}
                folderMoveTargets={resolveFolderMoveTargetsForItem(item)}
                onMoveToSessionFolder={folderActionsEnabled ? moveActionHandlers.onMoveToSessionFolder : undefined}
                onMoveToFolder={folderActionsEnabled ? moveActionHandlers.onMoveToFolder : undefined}
                onMoveToWorkspaceRoot={folderActionsEnabled ? moveActionHandlers.onMoveToWorkspaceRoot : undefined}
                onMoveUp={folderActionsEnabled ? moveActionHandlers.onMoveUp : undefined}
                onMoveDown={folderActionsEnabled ? moveActionHandlers.onMoveDown : undefined}
            />
        );
    }, [
        allKnownTags,
        currentUserId,
        densityViewState.compact,
        densityViewState.compactMinimal,
        densityViewState.rowHeight,
        rowViewModelByNodeId,
        rowSubscriptionKeys,
        selectedSessionId,
        folderActionsEnabled,
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
        shellFlags.canDragSessionRows,
        getRowMoveActionHandlers,
        rowLabelByTreeRowId,
    ]);

    const virtualizedNodeCacheRef = React.useRef(new Map<string, Readonly<{
        item: SessionListIndexItem;
        rowViewModel: SessionListRowViewModel | null;
        node: SessionListVirtualizedNode;
    }>>());
    const previousVirtualizedNodesRef = React.useRef<ReadonlyArray<SessionListVirtualizedNode>>([]);
    const virtualizedNodes = React.useMemo(() => {
        const previous = virtualizedNodeCacheRef.current;
        const next = new Map<string, Readonly<{
            item: SessionListIndexItem;
            rowViewModel: SessionListRowViewModel | null;
            node: SessionListVirtualizedNode;
        }>>();
        const nodes = renderedListItems.map((item, index) => {
            const id = buildSessionListIndexNodeId(item);
            const rowViewModel = renderedRowViewModels[index] ?? null;
            const cached = previous.get(id);
            if (cached && areSessionListIndexItemsEqual(cached.item, item) && cached.rowViewModel === rowViewModel) {
                next.set(id, cached);
                return cached.node;
            }
            const entry = {
                item,
                rowViewModel,
                node: {
                    id,
                    rowViewModel,
                },
            };
            next.set(id, entry);
            return entry.node;
        });
        virtualizedNodeCacheRef.current = next;
        const previousNodes = previousVirtualizedNodesRef.current;
        const output = areVirtualizedNodeArraysReferenceEqual(previousNodes, nodes) ? previousNodes : nodes;
        previousVirtualizedNodesRef.current = output;
        return output;
    }, [renderedListItems, renderedRowViewModels]);

    const nodeIds = React.useMemo(() => (
        virtualizedNodes.map((node) => node.id)
    ), [virtualizedNodes]);

    const nodeById = React.useMemo(() => {
        const map = new Map<string, SessionListIndexItem>();
        for (let index = 0; index < renderedListItems.length; index += 1) {
            map.set(nodeIds[index], renderedListItems[index]);
        }
        return map;
    }, [nodeIds, renderedListItems]);
    const folderFocusRootTitle = React.useMemo(() => {
        const folderFocus = sessionListPaneState.folderFocus;
        if (!folderFocus) return null;
        for (const item of renderedListItems) {
            if (item.type !== 'header' || item.headerKind !== 'project') continue;
            const workspace = resolveDurableWorkspaceRefForSessionListHeader(item);
            if (workspace && compareSessionFolderWorkspaceRefs(workspace, folderFocus.folder.workspace)) {
                return item.title;
            }
        }
        return null;
    }, [renderedListItems, sessionListPaneState.folderFocus]);

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
        setViewableSessionRowKeys((current) => stringSetsEqual(current, nextKeys) ? current : nextKeys);
    });
    const listItemsRef = React.useRef(renderedListItems);
    listItemsRef.current = renderedListItems;
    const renderHeaderItemRef = React.useRef(renderHeaderItem);
    renderHeaderItemRef.current = renderHeaderItem;
    const renderSessionItemRef = React.useRef(renderSessionItem);
    renderSessionItemRef.current = renderSessionItem;
    const allKnownTagsSignature = React.useMemo(() => buildStringListSignature(allKnownTags), [allKnownTags]);
    const rowLabelsSignature = React.useMemo(() => buildRowLabelSignature(rowLabelByTreeRowId), [rowLabelByTreeRowId]);
    const viewableSessionRowKeysSignature = React.useMemo(
        () => buildStringSetSignature(viewableSessionRowKeys),
        [viewableSessionRowKeys],
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
        viewableSessionRowKeysSignature,
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
        viewableSessionRowKeysSignature,
        workspaceLabelsSignature,
    ]);

    const renderVirtualizedItem = React.useCallback((params: { item: SessionListVirtualizedNode; index: number }) => {
        const item = nodeByIdRef.current.get(params.item.id) ?? listItemsRef.current[params.index] ?? null;
        if (!item) return null;
        if (item.type === 'header') return renderHeaderItemRef.current(item, params.index);
        return renderSessionItemRef.current(item, params.index, params.item.rowViewModel);
    }, []);
    const handleClearFolderFocus = React.useCallback(() => {
        setSessionListFocusedFolderV1(null);
    }, [setSessionListFocusedFolderV1]);
    const handleSelectFolderBreadcrumb = React.useCallback((folderId: string) => {
        const folder = sessionListPaneState.folderFocus?.breadcrumbs.find((candidate) => candidate.id === folderId) ?? null;
        if (!folder) return;
        setSessionListFocusedFolderV1({
            folderId: folder.id,
            workspace: folder.workspace,
            serverId: folder.workspace.serverId ?? null,
        });
    }, [sessionListPaneState.folderFocus?.breadcrumbs, setSessionListFocusedFolderV1]);
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
        folderFocus: sessionListPaneState.folderFocus,
        folderFocusRootTitle,
        dropOverlayShared: rowInteractions.dropOverlayShared,
        onClearFolderFocus: handleClearFolderFocus,
        onSelectFolderBreadcrumb: handleSelectFolderBreadcrumb,
    };
}
