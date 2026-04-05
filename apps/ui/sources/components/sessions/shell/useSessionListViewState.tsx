import * as React from 'react';
import { usePathname } from 'expo-router';
import { useSetting, useSettingMutable, useAllMachines, useProfile } from '@/sync/domains/state/storage';
import { useIsTablet } from '@/utils/platform/responsive';
import { useSessionListSelectionState } from '@/hooks/session/useSessionListSelectionState';
import { getAllKnownTags } from './sessionTagUtils';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { resolveSessionListShellFlags } from './resolveSessionListShellFlags';
import { resolveSelectedSessionIdForList } from './resolveSelectedSessionIdForList';
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
import type { SessionListViewItem } from '@/sync/domains/state/storage';

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
    const densityViewState = React.useMemo(() => resolveSessionListDensityViewState(sessionListDensity), [sessionListDensity]);
    const currentUserId = typeof profile?.id === 'string' ? profile.id : null;
    const selection = useSessionListSelectionState();
    const shellFlags = React.useMemo(() => resolveSessionListShellFlags({
        selectedServerCount: selection.selectedServerCount,
        selectionEnabled: selection.enabled,
        selectionPresentation: selection.presentation,
        isTablet,
        sessionListOrderingModeV1,
    }), [
        isTablet,
        selection.enabled,
        selection.presentation,
        selection.selectedServerCount,
        sessionListOrderingModeV1,
    ]);
    const orderingPersistenceState = React.useMemo(() => resolveSessionListOrderingPersistenceState({
        pinnedSessionKeysV1,
        sessionListGroupOrderV1,
    }), [pinnedSessionKeysV1, sessionListGroupOrderV1]);
    const allMachines = useAllMachines();
    const allKnownTags = React.useMemo(() => getAllKnownTags(sessionTagsV1), [sessionTagsV1]);
    const selectedSessionId = React.useMemo(() => resolveSelectedSessionIdForList({
        selectable: shellFlags.selectable,
        pathname,
    }), [pathname, shellFlags.selectable]);

    const renderModels = useSessionListRenderModels({
        paneState: sessionListPaneState,
        collapsedGroupKeys: collapsedGroupKeysV1,
        allMachines,
        workspaceLabels: workspaceLabelsV1,
        workspaceRefs: workspaceRefsV1 ?? [],
        pinnedKeySet: orderingPersistenceState.pinnedKeySet,
        sessionTags: sessionTagsV1 ?? {},
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
        sessionTags: sessionTagsV1 ?? {},
        setSessionTagsV1,
    });

    const {
        handleOpenProject,
        handleOpenArchivedSessions,
    } = useSessionListNavigationActions();
    const {
        handleRenameWorkspace,
        handleResetWorkspaceName,
        handleToggleCollapse,
    } = useSessionListWorkspaceHeaderActions({
        workspaceRefs: workspaceRefsV1,
        setWorkspaceRefs: setWorkspaceRefsV1,
        collapsedGroupKeys: collapsedGroupKeysV1,
        setCollapsedGroupKeys: setCollapsedGroupKeysV1,
    });

    const {
        scopeHintByLegacyWorkspaceKey,
        projectHeaderViewModelByGroupKey,
    } = renderModels.projectHeaderViewModelState;

    useSessionListWorkspaceLabelMigration({
        workspaceLabels: workspaceLabelsV1,
        setWorkspaceLabels: setWorkspaceLabelsV1,
        workspaceRefs: workspaceRefsV1,
        setWorkspaceRefs: setWorkspaceRefsV1,
        scopeHintByLegacyWorkspaceKey,
    });

    const collapsedKeys = collapsedGroupKeysV1 ?? {};
    const renderHeaderItem = React.useCallback((item: Extract<SessionListViewItem, { type: 'header' }>) => (
        <SessionListHeaderItem
            item={item}
            collapsedKeys={collapsedKeys}
            projectHeaderViewModelByGroupKey={projectHeaderViewModelByGroupKey}
            hasMultipleMachines={renderModels.hasMultipleMachines}
            onOpenProject={handleOpenProject}
            onRenameWorkspace={handleRenameWorkspace}
            onResetWorkspaceName={handleResetWorkspaceName}
            onToggleCollapse={handleToggleCollapse}
        />
    ), [
        collapsedKeys,
        handleOpenProject,
        handleRenameWorkspace,
        handleResetWorkspaceName,
        handleToggleCollapse,
        projectHeaderViewModelByGroupKey,
        renderModels.hasMultipleMachines,
    ]);

    const renderSessionItem = React.useCallback((item: Extract<SessionListViewItem, { type: 'session' }>, index: number) => (
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

    const renderVirtualizedItem = React.useCallback((params: { item: SessionListViewItem; index: number }) => {
        if (params.item.type === 'header') return renderHeaderItem(params.item);
        return renderSessionItem(params.item, params.index);
    }, [renderHeaderItem, renderSessionItem]);

    return {
        listItems: renderModels.listItems,
        rowHeight: densityViewState.rowHeight,
        renderVirtualizedItem,
        onPressArchivedSessions: handleOpenArchivedSessions,
    };
}
