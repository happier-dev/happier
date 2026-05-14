import * as React from 'react';
import { usePathname } from 'expo-router';
import { useSetting, useSettingMutable, useAllMachines, useProfile, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useIsTablet } from '@/utils/platform/responsive';
import { useSessionListSelectionState } from '@/hooks/session/useSessionListSelectionState';
import { getAllKnownTags } from './sessionTagUtils';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { resolveSessionListShellFlags } from './resolveSessionListShellFlags';
import { resolveSessionListDensityViewState } from './resolveSessionListDensityViewState';
import { resolveSessionListOrderingPersistenceState } from './resolveSessionListOrderingPersistenceState';
import { SessionListHeaderItem } from './sessionListHeaderItem';
import { SessionListSessionItem } from './sessionListSessionItem';
import { useSessionListRenderModels } from './useSessionListRenderModels';
import { useSessionListNavigationActions } from './useSessionListNavigationActions';
import { useSessionListRowInteractions } from './useSessionListRowInteractions';
import { useSessionListWorkspaceHeaderActions } from './useSessionListWorkspaceHeaderActions';
import { useSessionListWorkspaceLabelMigration } from './useSessionListWorkspaceLabelMigration';
import { resolveSessionListFolderDropPlacement } from './sessionListFolderDropPosition';
import { useVisibleSessionListPaneState, type VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import { buildSessionListIndexNodeId, type SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { normalizeSessionListShellState } from './normalizeSessionListShellState';
import { resolveSelectedSessionIdForList } from './resolveSelectedSessionIdForList';
import { useSessionCanvasSelection } from './view/useSessionCanvasSelection';
import {
    buildServerScopedSessionKey,
    moveSessionMruEntryToFront,
    resolveSessionMruNavigation,
    resolveVisibleSessionNavigation,
    type VisibleSessionNavigationEntry,
} from '@/keyboard/sessions';
import { useFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { Modal } from '@/modal';
import { t } from '@/text';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import {
    moveSessionFolderAssignments,
    setSessionFolderAssignment as setSessionFolderAssignmentOp,
} from '@/sync/ops/sessionFolders';
import {
    buildSessionFolderMoveTargets,
    compareSessionFolderWorkspaceRefs,
    createSessionFolder,
    deleteSessionFolder,
    DEFAULT_SESSION_FOLDERS_V1,
    moveSessionFolder,
    normalizeSessionFolders,
    renameSessionFolder,
    type SessionFolderMoveTarget,
    type SessionFolderWorkspaceRefV1,
    resolveDurableWorkspaceRefForSessionListHeader,
    type SessionFoldersV1,
} from '@/sync/domains/session/folders';

type SessionFolderDropTargetBounds = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

type SessionFolderRegisteredDropTarget = Readonly<
    | {
        id: string;
        type: 'folder';
        folderId: string;
        workspace: SessionFolderWorkspaceRefV1;
        serverId: string | null;
        bounds: SessionFolderDropTargetBounds;
    }
    | {
        id: string;
        type: 'workspace-root';
        workspace: SessionFolderWorkspaceRefV1;
        serverId: string | null;
        bounds: SessionFolderDropTargetBounds;
    }
>;

export type RegisterSessionFolderDropTarget = (
    target: SessionFolderRegisteredDropTarget,
) => () => void;

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

export function useSessionListViewState(storageKind: SessionListStorageFilter) {
    const sessionListPaneState = useVisibleSessionListPaneState(storageKind);
    return useSessionListViewStateFromPaneState(storageKind, sessionListPaneState);
}

export function useSessionListViewStateFromPaneState(
    storageKind: SessionListStorageFilter,
    sessionListPaneState: VisibleSessionListPaneState,
) {
    const pathname = usePathname();
    const isTablet = useIsTablet();
    const [pinnedSessionKeysV1, setPinnedSessionKeysV1] = useSettingMutable('pinnedSessionKeysV1');
    const [sessionListGroupOrderV1, setSessionListGroupOrderV1] = useSettingMutable('sessionListGroupOrderV1');
    const [sessionListOrderingModeV1] = useSettingMutable('sessionListOrderingModeV1');
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
    const sessionListDensity = useSetting('sessionListDensity');
    const profile = useProfile();
    const navigateToSession = useNavigateToSession();
    const densityViewState = resolveSessionListDensityViewState(sessionListDensity);
    const currentUserId = typeof profile?.id === 'string' ? profile.id : null;
    const selection = useSessionListSelectionState();
    const shellFlags = resolveSessionListShellFlags({
        selectedServerCount: selection.selectedServerCount,
        selectionEnabled: selection.enabled,
        selectionPresentation: selection.presentation,
        isTablet,
        sessionListOrderingModeV1,
    });
    const orderingPersistenceState = resolveSessionListOrderingPersistenceState({
        pinnedSessionKeysV1,
        sessionListGroupOrderV1,
    });
    const allMachines = useAllMachines();
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
    const folderDropTargetsRef = React.useRef(new Map<string, SessionFolderRegisteredDropTarget>());
    const registerSessionFolderDropTarget = React.useCallback<RegisterSessionFolderDropTarget>((target) => {
        folderDropTargetsRef.current.set(target.id, target);
        return () => {
            const current = folderDropTargetsRef.current.get(target.id);
            if (current === target) {
                folderDropTargetsRef.current.delete(target.id);
            }
        };
    }, []);
    const resolveFolderDropTarget = React.useCallback((point: Readonly<{ absoluteX: number; absoluteY: number }>) => {
        const targets = Array.from(folderDropTargetsRef.current.values()).filter((target) => (
            point.absoluteX >= target.bounds.x
            && point.absoluteX <= target.bounds.x + target.bounds.width
            && point.absoluteY >= target.bounds.y + Math.min(8, target.bounds.height * 0.25)
            && point.absoluteY <= target.bounds.y + target.bounds.height - Math.min(8, target.bounds.height * 0.25)
        ));
        return targets.sort((left, right) => (
            (left.bounds.width * left.bounds.height) - (right.bounds.width * right.bounds.height)
        ))[0] ?? null;
    }, []);
    const allKnownTags = getAllKnownTags(normalizedShellState.sessionTags);
    const selectedSessionId = useSessionCanvasSelection({
        selectable: shellFlags.selectable,
        pathname,
    });
    const focusedSessionId = useFocusedSessionId();
    const activeMruSessionId = React.useMemo(() => resolveSelectedSessionIdForList({
        selectable: true,
        pathname,
        focusedSessionId,
    }), [focusedSessionId, pathname]);

    const renderModels = useSessionListRenderModels({
        paneState: sessionListPaneState,
        collapsedGroupKeys: normalizedShellState.collapsedGroupKeys,
        allMachines,
        workspaceLabels: normalizedShellState.workspaceLabels,
        workspaceRefs: normalizedShellState.workspaceRefs,
        workspacePathDisplayModeV1,
        pinnedKeySet: orderingPersistenceState.pinnedKeySet,
        sessionTags: normalizedShellState.sessionTags,
        selectedSessionId,
        showServerBadge: shellFlags.showServerBadge,
        showPinnedServerBadge: shellFlags.showPinnedServerBadge,
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
    React.useEffect(() => {
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
    }, [activeSessionKey, knownSessionKeys, sessionMruOrderV1, setSessionMruOrderV1]);

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
    useKeyboardShortcutHandlers(React.useMemo(() => ({
        'session.visible.previous': () => handleVisibleSessionShortcut('previous'),
        'session.visible.next': () => handleVisibleSessionShortcut('next'),
        'session.mru.previous': () => handleMruSessionShortcut('next'),
        'session.mru.next': () => handleMruSessionShortcut('previous'),
    }), [handleMruSessionShortcut, handleVisibleSessionShortcut]));

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

    const handleMoveFolderHeaderByDrop = React.useCallback((
        sessionKey: string,
        _groupKey: string,
        _positionDelta: number,
        context?: { absoluteX: number | null; absoluteY: number | null },
    ) => {
        const folderId = sessionKey.startsWith('folder:') ? sessionKey.slice('folder:'.length) : '';
        if (!folderId) return;
        const sourceFolder = sessionFoldersV1.folders.find((folder) => folder.id === folderId);
        if (!sourceFolder) return;
        const target = context?.absoluteX == null || context.absoluteY == null
            ? null
            : resolveFolderDropTarget({
                absoluteX: context.absoluteX,
                absoluteY: context.absoluteY,
            });
        const placement = target && compareSessionFolderWorkspaceRefs(target.workspace, sourceFolder.workspace)
            ? {
                parentId: target.type === 'folder' ? target.folderId : null,
            }
            : resolveSessionListFolderDropPlacement({
                items: listItemsRef.current,
                folderId,
                positionDelta: _positionDelta,
            });
        if (!placement) return;
        const moved = moveSessionFolder({
            current: sessionFoldersV1,
            folderId,
            parentId: placement.parentId,
            beforeFolderId: placement.beforeFolderId,
            afterFolderId: placement.afterFolderId,
            now: Date.now(),
        });
        if (moved.folder) {
            setSessionFoldersV1(moved.next);
        }
    }, [resolveFolderDropTarget, sessionFoldersV1, setSessionFoldersV1]);

    const rowInteractions = useSessionListRowInteractions({
        listItems: renderModels.listItems,
        currentGroupOrderMap: orderingPersistenceState.currentGroupOrderMap,
        canReorderSessions: shellFlags.canReorderSessions,
        setSessionListGroupOrderV1,
        pinnedKeyList: orderingPersistenceState.pinnedKeyList,
        pinnedKeySet: orderingPersistenceState.pinnedKeySet,
        setPinnedSessionKeysV1,
        sessionTags: normalizedShellState.sessionTags,
        setSessionTagsV1,
        resolveFolderDropTarget,
        assignSessionFolder: async ({ serverId, sessionId, folderId }) => {
            await handleMoveSessionToFolder(sessionId, serverId, folderId);
        },
    });

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

    const resolveFolderMoveTargetsForItem = React.useCallback((
        item: Extract<SessionListIndexItem, { type: 'session' }>,
    ): readonly SessionFolderMoveTarget[] => {
        if (storageKind === 'direct' || !item.workspace || !item.serverId) return [];
        return buildSessionFolderMoveTargets({
            folders: sessionFoldersV1,
            workspace: item.workspace,
            currentFolderId: item.folderId ?? null,
            workspaceRootTitle: t('sessionsList.workspaceRoot'),
        });
    }, [sessionFoldersV1, storageKind]);

    const {
        scopeHintByLegacyWorkspaceKey,
        projectHeaderViewModelByGroupKey,
    } = renderModels.projectHeaderViewModelState;

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
            onRegisterSessionFolderDropTarget={registerSessionFolderDropTarget}
            workspaceFaviconsEnabled={workspaceFaviconsEnabled}
            workspaceMachineSubtitlesEnabled={workspaceMachineSubtitlesEnabled}
            dataIndex={index}
            totalItemCount={renderModels.listItems.length}
            dropIndicatorIdx={rowInteractions.dropIndicatorIdx}
            dropIndicatorEdge={rowInteractions.dropIndicatorEdge}
            onFolderDragStart={rowInteractions.handleDragStart}
            onFolderDragUpdate={rowInteractions.handleDragUpdate}
            onFolderDragEnd={(sessionKey, groupKey, positionDelta, context) => {
                handleMoveFolderHeaderByDrop(sessionKey, groupKey, positionDelta, context);
                rowInteractions.handleDragCancel();
            }}
            activeFolderDropTargetId={rowInteractions.activeFolderDropTargetId}
        />
    ), [
        collapsedKeys,
        handleAddSubfolder,
        handleMoveFolderHeaderByDrop,
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
        projectHeaderViewModelByGroupKey,
        registerSessionFolderDropTarget,
        renderModels.listItems.length,
        renderModels.hasMultipleMachines,
        rowInteractions.activeFolderDropTargetId,
        rowInteractions.dropIndicatorEdge,
        rowInteractions.dropIndicatorIdx,
        rowInteractions.handleDragCancel,
        rowInteractions.handleDragStart,
        rowInteractions.handleDragUpdate,
        workspaceFaviconsEnabled,
        workspaceMachineSubtitlesEnabled,
    ]);

    const renderSessionItem = React.useCallback((item: Extract<SessionListIndexItem, { type: 'session' }>, index: number) => (
        <SessionListSessionItem
            item={item}
            rowViewModel={renderModels.rowViewModels[index]}
            rowHeight={densityViewState.rowHeight}
            canReorderSessions={shellFlags.canReorderSessions}
            onDragStart={rowInteractions.handleDragStart}
            onDragEnd={rowInteractions.handleDragEnd}
            onDragUpdate={rowInteractions.handleDragUpdate}
            onTogglePinnedSessionKey={rowInteractions.handleTogglePinnedSessionKey}
            onSetTagsSessionKey={rowInteractions.handleSetTagsSessionKey}
            onNativeContextMenuOpenChangeSessionKey={rowInteractions.handleNativeContextMenuOpenChangeSessionKey}
            draggingSessionKey={rowInteractions.draggingSessionKey}
            nativeContextMenuSessionKey={rowInteractions.nativeContextMenuSessionKey}
            dataIndex={index}
            totalItemCount={renderModels.listItems.length}
            dropIndicatorIdx={rowInteractions.dropIndicatorIdx}
            dropIndicatorEdge={rowInteractions.dropIndicatorEdge}
            currentUserId={currentUserId}
            allKnownTags={allKnownTags}
            tagsEnabled={sessionTagsEnabled === true}
            compact={Boolean(densityViewState.compact)}
            compactMinimal={Boolean(densityViewState.compact && densityViewState.compactMinimal)}
            folderMoveTargets={resolveFolderMoveTargetsForItem(item)}
            onMoveToSessionFolder={handleMoveSessionToFolder}
        />
    ), [
        allKnownTags,
        currentUserId,
        densityViewState.compact,
        densityViewState.compactMinimal,
        densityViewState.rowHeight,
        renderModels.listItems.length,
        renderModels.rowViewModels,
        rowInteractions.draggingSessionKey,
        rowInteractions.dropIndicatorEdge,
        rowInteractions.dropIndicatorIdx,
        rowInteractions.handleDragEnd,
        rowInteractions.handleDragStart,
        rowInteractions.handleDragUpdate,
        rowInteractions.handleNativeContextMenuOpenChangeSessionKey,
        rowInteractions.handleSetTagsSessionKey,
        rowInteractions.handleTogglePinnedSessionKey,
        resolveFolderMoveTargetsForItem,
        sessionTagsEnabled,
        shellFlags.canReorderSessions,
        handleMoveSessionToFolder,
    ]);

    const nodeIds = React.useMemo(() => (
        renderModels.listItems.map((item) => buildSessionListIndexNodeId(item))
    ), [renderModels.listItems]);

    const nodeById = React.useMemo(() => {
        const map = new Map<string, SessionListIndexItem>();
        for (let index = 0; index < renderModels.listItems.length; index += 1) {
            map.set(nodeIds[index], renderModels.listItems[index]);
        }
        return map;
    }, [nodeIds, renderModels.listItems]);
    const folderFocusRootTitle = React.useMemo(() => {
        const folderFocus = sessionListPaneState.folderFocus;
        if (!folderFocus) return null;
        for (const item of renderModels.listItems) {
            if (item.type !== 'header' || item.headerKind !== 'project') continue;
            const workspace = resolveDurableWorkspaceRefForSessionListHeader(item);
            if (workspace && compareSessionFolderWorkspaceRefs(workspace, folderFocus.folder.workspace)) {
                return item.title;
            }
        }
        return null;
    }, [renderModels.listItems, sessionListPaneState.folderFocus]);

    const nodeByIdRef = React.useRef(nodeById);
    nodeByIdRef.current = nodeById;
    const listItemsRef = React.useRef(renderModels.listItems);
    listItemsRef.current = renderModels.listItems;
    const renderHeaderItemRef = React.useRef(renderHeaderItem);
    renderHeaderItemRef.current = renderHeaderItem;
    const renderSessionItemRef = React.useRef(renderSessionItem);
    renderSessionItemRef.current = renderSessionItem;

    const renderVirtualizedItem = React.useCallback((params: { item: string; index: number }) => {
        const item = nodeByIdRef.current.get(params.item) ?? listItemsRef.current[params.index] ?? null;
        if (!item) return null;
        if (item.type === 'header') return renderHeaderItemRef.current(item, params.index);
        return renderSessionItemRef.current(item, params.index);
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

    return {
        nodeIds,
        rowHeight: densityViewState.rowHeight,
        renderVirtualizedItem,
        onPressArchivedSessions: handleOpenArchivedSessions,
        folderFocus: sessionListPaneState.folderFocus,
        folderFocusRootTitle,
        onClearFolderFocus: handleClearFolderFocus,
        onSelectFolderBreadcrumb: handleSelectFolderBreadcrumb,
    };
}
