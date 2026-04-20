import * as React from 'react';
import { usePathname } from 'expo-router';
import { useSetting, useSettingMutable, useAllMachines, useProfile } from '@/sync/domains/state/storage';
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
import { useVisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import { buildSessionListIndexNodeId, type SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { normalizeSessionListShellState } from './normalizeSessionListShellState';
import { useSessionCanvasSelection } from './view/useSessionCanvasSelection';

export function useSessionListViewState(storageKind: SessionListStorageFilter) {
    const sessionListPaneState = useVisibleSessionListPaneState(storageKind);
    const pathname = usePathname();
    const isTablet = useIsTablet();
    const [pinnedSessionKeysV1, setPinnedSessionKeysV1] = useSettingMutable('pinnedSessionKeysV1');
    const [sessionListGroupOrderV1, setSessionListGroupOrderV1] = useSettingMutable('sessionListGroupOrderV1');
    const [sessionListOrderingModeV1] = useSettingMutable('sessionListOrderingModeV1');
    const [sessionTagsV1, setSessionTagsV1] = useSettingMutable('sessionTagsV1');
    const sessionTagsEnabled = useSetting('sessionTagsEnabled');
    const [workspaceLabelsV1, setWorkspaceLabelsV1] = useSettingMutable('workspaceLabelsV1');
    const [workspaceRefsV1, setWorkspaceRefsV1] = useSettingMutable('workspaceRefsV1');
    const [collapsedGroupKeysV1, setCollapsedGroupKeysV1] = useSettingMutable('collapsedGroupKeysV1');
    const sessionListDensity = useSetting('sessionListDensity');
    const profile = useProfile();
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
    const allKnownTags = getAllKnownTags(normalizedShellState.sessionTags);
    const selectedSessionId = useSessionCanvasSelection({
        selectable: shellFlags.selectable,
        pathname,
    });

    const renderModels = useSessionListRenderModels({
        paneState: sessionListPaneState,
        collapsedGroupKeys: normalizedShellState.collapsedGroupKeys,
        allMachines,
        workspaceLabels: normalizedShellState.workspaceLabels,
        workspaceRefs: normalizedShellState.workspaceRefs,
        pinnedKeySet: orderingPersistenceState.pinnedKeySet,
        sessionTags: normalizedShellState.sessionTags,
        selectedSessionId,
        showServerBadge: shellFlags.showServerBadge,
        showPinnedServerBadge: shellFlags.showPinnedServerBadge,
    });

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
    const renderHeaderItem = React.useCallback((item: Extract<SessionListIndexItem, { type: 'header' }>) => (
        <SessionListHeaderItem
            item={item}
            collapsedKeys={collapsedKeys}
            projectHeaderViewModelByGroupKey={projectHeaderViewModelByGroupKey}
            hasMultipleMachines={renderModels.hasMultipleMachines}
            onOpenProject={handleOpenProject}
            onCreateSessionFromWorkspaceScope={handleCreateSessionFromWorkspaceScope}
            onRenameWorkspace={handleRenameWorkspace}
            onResetWorkspaceName={handleResetWorkspaceName}
            onToggleCollapse={handleToggleCollapse}
        />
    ), [
        collapsedKeys,
        handleOpenProject,
        handleCreateSessionFromWorkspaceScope,
        handleRenameWorkspace,
        handleResetWorkspaceName,
        handleToggleCollapse,
        projectHeaderViewModelByGroupKey,
        renderModels.hasMultipleMachines,
    ]);

    const renderSessionItem = React.useCallback((item: Extract<SessionListIndexItem, { type: 'session' }>, index: number) => (
        <SessionListSessionItem
            item={item}
            rowViewModel={renderModels.rowViewModels[index]}
            rowHeight={densityViewState.rowHeight}
            canReorderSessions={shellFlags.canReorderSessions}
            onDragStart={rowInteractions.handleDragStart}
            onDragEnd={rowInteractions.handleDragEnd}
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
        rowInteractions.handleNativeContextMenuOpenChangeSessionKey,
        rowInteractions.handleSetTagsSessionKey,
        rowInteractions.handleTogglePinnedSessionKey,
        sessionTagsEnabled,
        shellFlags.canReorderSessions,
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

    const renderVirtualizedItem = React.useCallback((params: { item: string; index: number }) => {
        const item = nodeById.get(params.item) ?? renderModels.listItems[params.index] ?? null;
        if (!item) return null;
        if (item.type === 'header') return renderHeaderItem(item);
        return renderSessionItem(item, params.index);
    }, [nodeById, renderHeaderItem, renderModels.listItems, renderSessionItem]);

    return {
        nodeIds,
        rowHeight: densityViewState.rowHeight,
        renderVirtualizedItem,
        onPressArchivedSessions: handleOpenArchivedSessions,
    };
}
