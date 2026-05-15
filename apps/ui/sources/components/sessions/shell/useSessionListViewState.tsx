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
import { useVisibleSessionListPaneState, type VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import { buildSessionListIndexNodeId, type SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { normalizeSessionListShellState } from './normalizeSessionListShellState';
import { resolveSelectedSessionIdForList } from '@/sync/domains/session/listing/resolveSelectedSessionIdForList';
import { useSessionCanvasSelection } from './view/useSessionCanvasSelection';
import { useSessionListA11yAnnouncements } from './accessibility/useSessionListA11yAnnouncements';
import type { SessionListMoveSheetTarget } from './move-sheet/buildSessionListMoveSheetTargets';
import { useSessionListMoveSheet } from './move-sheet/useSessionListMoveSheet';
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
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
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
    normalizeSessionFolders,
    renameSessionFolder,
    type SessionFolderMoveTarget,
    type SessionFolderWorkspaceRefV1,
    resolveDurableWorkspaceRefForSessionListHeader,
    type SessionFoldersV1,
} from '@/sync/domains/session/folders';
import { treeRowId } from './drop-resolution/treeRowId';

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

function resolveSessionTreeRowId(sessionKey: string | null): string | null {
    if (!sessionKey) return null;
    const separatorIndex = sessionKey.indexOf(':');
    if (separatorIndex <= 0) return null;
    const serverId = sessionKey.slice(0, separatorIndex);
    const sessionId = sessionKey.slice(separatorIndex + 1);
    return serverId && sessionId ? treeRowId.session(serverId, sessionId) : null;
}

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
    const sessionFoldersFeatureEnabled = useFeatureEnabled('sessions.folders');
    const folderActionsEnabled = storageKind !== 'direct' && sessionFoldersFeatureEnabled;
    const sessionListDensity = useSetting('sessionListDensity');
    const profile = useProfile();
    const navigateToSession = useNavigateToSession();
    const { openMoveSheet } = useSessionListMoveSheet();
    const sessionListA11y = useSessionListA11yAnnouncements();
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

    const rowInteractions = useSessionListRowInteractions({
        folderActionsEnabled: Boolean(folderActionsEnabled),
        sessionFoldersV1,
        listItems: renderModels.listItems,
        currentGroupOrderMap: orderingPersistenceState.currentGroupOrderMap,
        setSessionListGroupOrderV1,
        setSessionFoldersV1,
        pinnedKeyList: orderingPersistenceState.pinnedKeyList,
        pinnedKeySet: orderingPersistenceState.pinnedKeySet,
        setPinnedSessionKeysV1,
        sessionTags: normalizedShellState.sessionTags,
        setSessionTagsV1,
    });

    const rowLabelByTreeRowId = React.useMemo(() => {
        const labels = new Map<string, string>();
        for (const item of renderModels.listItems) {
            if (item.type === 'session') {
                labels.set(resolveTreeRowIdForSessionItem(item), item.sessionId);
                continue;
            }
            if (item.headerKind === 'folder' && item.folderId) {
                labels.set(treeRowId.folder(item.folderId), item.title);
            } else if (item.headerKind === 'project' && (item.groupKey || item.workspaceKey)) {
                labels.set(treeRowId.workspaceRoot(item.groupKey ?? item.workspaceKey ?? item.title), item.title);
            }
        }
        return labels;
    }, [renderModels.listItems]);

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

    useKeyboardShortcutHandlers(React.useMemo(() => ({
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
    }), [
        activeSessionKey,
        moveTreeRowByKeyboard,
        moveTreeRowToWorkspaceRoot,
        openMoveSheetForTreeRow,
        rowLabelByTreeRowId,
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
            dropVisual={rowInteractions.dropVisual}
            activeDropVisual={rowInteractions.activeDropVisual}
            onRegisterTreeRowBounds={rowInteractions.registerTreeRowBounds}
            onUnregisterTreeRowBounds={rowInteractions.unregisterTreeRowBounds}
            onFolderDragStart={rowInteractions.handleDragStart}
            onFolderDragUpdate={rowInteractions.handleDragUpdate}
            resolveDropResult={rowInteractions.resolveTreeDropResult}
            onFolderDropResult={rowInteractions.handleFolderHeaderTreeDropResult}
            activeFolderDropTargetId={rowInteractions.activeDropTargetId}
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
        renderModels.hasMultipleMachines,
        rowInteractions.activeDropTargetId,
        rowInteractions.activeDropVisual,
        rowInteractions.dropVisual,
        rowInteractions.handleFolderHeaderTreeDropResult,
        rowInteractions.handleDragStart,
        rowInteractions.handleDragUpdate,
        rowInteractions.registerTreeRowBounds,
        rowInteractions.resolveTreeDropResult,
        rowInteractions.unregisterTreeRowBounds,
        rowLabelByTreeRowId,
        workspaceFaviconsEnabled,
        workspaceMachineSubtitlesEnabled,
    ]);

    const renderSessionItem = React.useCallback((item: Extract<SessionListIndexItem, { type: 'session' }>, index: number) => (
        <SessionListSessionItem
            item={item}
            rowViewModel={renderModels.rowViewModels[index]}
            rowHeight={densityViewState.rowHeight}
            canReorderSessions={shellFlags.canReorderSessions}
            treeRowId={resolveTreeRowIdForSessionItem(item)}
            onDragStart={rowInteractions.handleDragStart}
            resolveDropResult={rowInteractions.resolveTreeDropResult}
            onDropResult={rowInteractions.handleTreeDropResult}
            onDragUpdate={rowInteractions.handleDragUpdate}
            onTogglePinnedSessionKey={rowInteractions.handleTogglePinnedSessionKey}
            onSetTagsSessionKey={rowInteractions.handleSetTagsSessionKey}
            onNativeContextMenuOpenChangeSessionKey={rowInteractions.handleNativeContextMenuOpenChangeSessionKey}
            draggingSessionKey={rowInteractions.draggingSessionKey}
            nativeContextMenuSessionKey={rowInteractions.nativeContextMenuSessionKey}
            dataIndex={index}
            dropVisual={rowInteractions.dropVisual}
            activeDropVisual={rowInteractions.activeDropVisual}
            onRegisterTreeRowBounds={rowInteractions.registerTreeRowBounds}
            onUnregisterTreeRowBounds={rowInteractions.unregisterTreeRowBounds}
            currentUserId={currentUserId}
            allKnownTags={allKnownTags}
            tagsEnabled={sessionTagsEnabled === true}
            compact={Boolean(densityViewState.compact)}
            compactMinimal={Boolean(densityViewState.compact && densityViewState.compactMinimal)}
            folderMoveTargets={resolveFolderMoveTargetsForItem(item)}
            onMoveToSessionFolder={folderActionsEnabled ? handleMoveSessionToFolder : null}
            onMoveToFolder={folderActionsEnabled
                ? () => {
                    const rowId = resolveTreeRowIdForSessionItem(item);
                    void openMoveSheetForTreeRow(rowId, rowLabelByTreeRowId.get(rowId) ?? item.sessionId);
                }
                : undefined}
            onMoveToWorkspaceRoot={folderActionsEnabled
                ? () => {
                    const rowId = resolveTreeRowIdForSessionItem(item);
                    moveTreeRowToWorkspaceRoot(rowId, rowLabelByTreeRowId.get(rowId) ?? item.sessionId);
                }
                : undefined}
            onMoveUp={folderActionsEnabled
                ? () => {
                    const rowId = resolveTreeRowIdForSessionItem(item);
                    moveTreeRowByKeyboard(rowId, rowLabelByTreeRowId.get(rowId) ?? item.sessionId, 'up');
                }
                : undefined}
            onMoveDown={folderActionsEnabled
                ? () => {
                    const rowId = resolveTreeRowIdForSessionItem(item);
                    moveTreeRowByKeyboard(rowId, rowLabelByTreeRowId.get(rowId) ?? item.sessionId, 'down');
                }
                : undefined}
        />
    ), [
        allKnownTags,
        currentUserId,
        densityViewState.compact,
        densityViewState.compactMinimal,
        densityViewState.rowHeight,
        renderModels.rowViewModels,
        folderActionsEnabled,
        rowInteractions.activeDropVisual,
        rowInteractions.draggingSessionKey,
        rowInteractions.dropVisual,
        rowInteractions.handleDragStart,
        rowInteractions.handleDragUpdate,
        rowInteractions.handleTreeDropResult,
        rowInteractions.handleNativeContextMenuOpenChangeSessionKey,
        rowInteractions.handleSetTagsSessionKey,
        rowInteractions.handleTogglePinnedSessionKey,
        rowInteractions.registerTreeRowBounds,
        rowInteractions.resolveTreeDropResult,
        rowInteractions.unregisterTreeRowBounds,
        resolveFolderMoveTargetsForItem,
        sessionTagsEnabled,
        shellFlags.canReorderSessions,
        handleMoveSessionToFolder,
        moveTreeRowByKeyboard,
        moveTreeRowToWorkspaceRoot,
        openMoveSheetForTreeRow,
        rowLabelByTreeRowId,
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
    // FlashList keeps rendered cells when data/renderItem stay stable. Use the
    // row renderer identity as the marker for state that changes row props.
    const virtualizedRowExtraData = renderSessionItem;

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
        virtualizedRowExtraData,
        onPressArchivedSessions: handleOpenArchivedSessions,
        folderFocus: sessionListPaneState.folderFocus,
        folderFocusRootTitle,
        onClearFolderFocus: handleClearFolderFocus,
        onSelectFolderBreadcrumb: handleSelectFolderBreadcrumb,
    };
}
