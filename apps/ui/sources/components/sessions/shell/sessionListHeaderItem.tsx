import * as React from 'react';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { t } from '@/text';
import type { TreeDropOverlaySharedValues } from '@/components/ui/treeDragDrop';

import type { SessionListProjectHeaderViewModel } from './sessionListProjectHeaderViewModels';
import { CollapsibleSectionHeader, FolderGroupHeader, ProjectGroupHeader, SessionListHeaderControls } from './sessionListChrome';
import type { RegisterSessionFolderDropTarget } from './useSessionListViewState';
import {
    SessionListHeaderFrame,
    type RegisterSessionListTreeRowBounds,
    type UnregisterSessionListTreeRowBounds,
} from './SessionListHeaderFrame';
import { resolveSessionListHeaderViewState } from './resolveSessionListHeaderViewState';
import { isSessionListPrimaryHeaderKind } from './sessionListPrimaryHeader';
import {
    resolveSessionListHeaderActionHandlers,
    type CreateSessionFromWorkspaceScopeHandler,
} from './resolveSessionListHeaderActionHandlers';
import {
    useSessionInlineDrag,
    type UseSessionInlineDragCancelEvent,
    type UseSessionInlineDragDropResultEvent,
    type UseSessionInlineDragResolvedDrop,
    type UseSessionInlineDragResolveDropResultEvent,
} from './useSessionInlineDrag';
import { resolveWorkspaceRootTreeRowId, treeRowId } from './drop-resolution/treeRowId';

type SessionListHeaderItemProps = Readonly<{
    item: Extract<SessionListIndexItem, { type: 'header' }>;
    collapsedKeys: Readonly<Record<string, boolean>>;
    projectHeaderViewModelByGroupKey: ReadonlyMap<string, SessionListProjectHeaderViewModel>;
    hasMultipleMachines: boolean;
    onOpenProject: (workspaceRefId: string) => void;
    onCreateSessionFromWorkspaceScope: CreateSessionFromWorkspaceScopeHandler;
    onAddFolderToWorkspace: (item: Extract<SessionListIndexItem, { type: 'header' }>) => void;
    onRenameWorkspace: (params: Readonly<{
        legacyWorkspaceKey: string;
        scopeHint: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
        currentLabel: string;
    }>) => void;
    onResetWorkspaceName: (params: Readonly<{
        legacyWorkspaceKey: string;
        scopeHint: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
    }>) => void;
    onToggleCollapse: (collapseKey: string) => void;
    onFocusFolder?: (item: Extract<SessionListIndexItem, { type: 'header' }>) => void;
    onCreateSessionFromFolder?: (item: Extract<SessionListIndexItem, { type: 'header' }>) => void;
    onAddSubfolder?: (item: Extract<SessionListIndexItem, { type: 'header' }>) => void | Promise<void>;
    onRenameFolder?: (item: Extract<SessionListIndexItem, { type: 'header' }>) => void | Promise<void>;
    onDeleteFolder?: (item: Extract<SessionListIndexItem, { type: 'header' }>) => void | Promise<void>;
    onMoveFolder?: (item: Extract<SessionListIndexItem, { type: 'header' }>) => void;
    onMoveFolderToWorkspaceRoot?: (item: Extract<SessionListIndexItem, { type: 'header' }>) => void;
    onMoveFolderUp?: (item: Extract<SessionListIndexItem, { type: 'header' }>) => void;
    onMoveFolderDown?: (item: Extract<SessionListIndexItem, { type: 'header' }>) => void;
    onRegisterSessionFolderDropTarget?: RegisterSessionFolderDropTarget;
    workspaceFaviconsEnabled?: boolean;
    workspaceMachineSubtitlesEnabled?: boolean;
    dataIndex?: number;
    overlayShared?: TreeDropOverlaySharedValues;
    onRegisterTreeRowBounds?: RegisterSessionListTreeRowBounds;
    onUnregisterTreeRowBounds?: UnregisterSessionListTreeRowBounds;
    onFolderDragStart?: (sessionKey: string) => void;
    resolveDropResult?: (event: UseSessionInlineDragResolveDropResultEvent) => UseSessionInlineDragResolvedDrop;
    onFolderDragUpdate?: (event: UseSessionInlineDragDropResultEvent) => void;
    onFolderDragCancel?: (event: UseSessionInlineDragCancelEvent) => void;
    onFolderDropResult?: (event: UseSessionInlineDragDropResultEvent) => void;
    headerControls?: Omit<React.ComponentProps<typeof SessionListHeaderControls>, 'onMenuOpenChange'>;
}>;

export const SessionListHeaderItem = React.memo((props: SessionListHeaderItemProps) => {
    if (props.item.headerKind === 'folder') {
        const collapseKey = props.item.groupKey ?? `folder:${props.item.folderId ?? props.item.title}`;
        const rowId = props.item.folderId ? treeRowId.folder(props.item.folderId) : null;
        const folderHeader = (
            <FolderGroupHeader
                title={props.item.title}
                depth={props.item.folderDepth ?? 0}
                collapsed={props.collapsedKeys[collapseKey] === true}
                onPress={() => props.onFocusFolder?.(props.item)}
                onToggleCollapse={() => props.onToggleCollapse(collapseKey)}
                onNewSession={() => props.onCreateSessionFromFolder?.(props.item)}
                onAddSubfolder={() => props.onAddSubfolder?.(props.item)}
                onRename={() => props.onRenameFolder?.(props.item)}
                onDelete={() => props.onDeleteFolder?.(props.item)}
                onMove={() => props.onMoveFolder?.(props.item)}
                onMoveToWorkspaceRoot={() => props.onMoveFolderToWorkspaceRoot?.(props.item)}
                onMoveUp={() => props.onMoveFolderUp?.(props.item)}
                onMoveDown={() => props.onMoveFolderDown?.(props.item)}
                item={props.item}
                onRegisterDropTarget={props.onRegisterSessionFolderDropTarget}
            />
        );
        const framedFolderHeader = rowId && props.onRegisterTreeRowBounds && props.onUnregisterTreeRowBounds ? (
            <SessionListHeaderFrame
                treeRowId={rowId}
                onRegisterTreeRowBounds={props.onRegisterTreeRowBounds}
                onUnregisterTreeRowBounds={props.onUnregisterTreeRowBounds}
            >
                {folderHeader}
            </SessionListHeaderFrame>
        ) : folderHeader;
        if (!props.item.folderId || !props.overlayShared || !props.resolveDropResult || !props.onFolderDropResult) {
            return framedFolderHeader;
        }
        return (
            <DraggableFolderHeaderFrame
                sessionKey={`folder:${props.item.folderId}`}
                groupKey={props.item.groupKey ?? `folder:${props.item.folderId}`}
                dataIndex={props.dataIndex ?? 0}
                overlayShared={props.overlayShared}
                onDragStart={props.onFolderDragStart}
                onDragUpdate={props.onFolderDragUpdate}
                onDragCancel={props.onFolderDragCancel}
                resolveDropResult={props.resolveDropResult}
                onDropResult={props.onFolderDropResult}
            >
                {framedFolderHeader}
            </DraggableFolderHeaderFrame>
        );
    }

    const headerViewState = resolveSessionListHeaderViewState({
        item: props.item,
        collapsedKeys: props.collapsedKeys,
        projectHeaderViewModelByGroupKey: props.projectHeaderViewModelByGroupKey,
        translateServerHeader: (server) => t('sessionsList.serverHeader', { server }),
    });
    const headerActionHandlers = resolveSessionListHeaderActionHandlers({
        headerViewState,
        onOpenProject: props.onOpenProject,
        onCreateSessionFromWorkspaceScope: props.onCreateSessionFromWorkspaceScope,
        onRenameWorkspace: props.onRenameWorkspace,
        onResetWorkspaceName: props.onResetWorkspaceName,
        onToggleCollapse: props.onToggleCollapse,
    });

    if (!headerViewState || !headerActionHandlers) {
        return null;
    }

    if (headerViewState.kind === 'project') {
        const rowId = resolveWorkspaceRootTreeRowId(props.item, headerViewState.displayTitle);
        const projectHeader = (
            <ProjectGroupHeader
                item={props.item}
                hasMultipleMachines={props.hasMultipleMachines}
                displayTitle={headerViewState.displayTitle}
                hasCustomLabel={headerViewState.hasCustomLabel}
                canOpenProject={Boolean(headerViewState.workspaceRefId)}
                workspaceFaviconsEnabled={props.workspaceFaviconsEnabled === true}
                workspaceMachineSubtitlesEnabled={props.workspaceMachineSubtitlesEnabled !== false}
                onOpenProject={headerActionHandlers.onOpenProject}
                onCreateSession={headerActionHandlers.onCreateSession}
                onAddFolder={() => props.onAddFolderToWorkspace(props.item)}
                onRename={headerActionHandlers.onRename}
                onReset={headerActionHandlers.onReset}
                collapsed={headerViewState.collapsed}
                onToggleCollapse={headerActionHandlers.onToggleCollapse}
                onRegisterDropTarget={props.onRegisterSessionFolderDropTarget}
            />
        );
        const framedProjectHeader = props.onRegisterTreeRowBounds && props.onUnregisterTreeRowBounds ? (
            <SessionListHeaderFrame
                treeRowId={rowId}
                onRegisterTreeRowBounds={props.onRegisterTreeRowBounds}
                onUnregisterTreeRowBounds={props.onUnregisterTreeRowBounds}
            >
                {projectHeader}
            </SessionListHeaderFrame>
        ) : projectHeader;
        if (!props.item.workspaceScopeHint || !props.overlayShared || !props.resolveDropResult || !props.onFolderDropResult) {
            return framedProjectHeader;
        }
        return (
            <DraggableFolderHeaderFrame
                sessionKey={rowId}
                groupKey={props.item.groupKey ?? props.item.workspaceKey ?? headerViewState.displayTitle}
                dataIndex={props.dataIndex ?? 0}
                overlayShared={props.overlayShared}
                onDragStart={props.onFolderDragStart}
                onDragUpdate={props.onFolderDragUpdate}
                onDragCancel={props.onFolderDragCancel}
                resolveDropResult={props.resolveDropResult}
                onDropResult={props.onFolderDropResult}
            >
                {framedProjectHeader}
            </DraggableFolderHeaderFrame>
        );
    }

    return (
        <CollapsibleSectionHeader
            title={headerViewState.title}
            collapsed={headerViewState.collapsed}
            onPress={headerActionHandlers.onToggleCollapse}
            showOrderingMenu={isSessionListPrimaryHeaderKind(props.item.headerKind)}
            headerControls={props.headerControls}
        />
    );
});

const DraggableFolderHeaderFrame = React.memo(function DraggableFolderHeaderFrame(props: Readonly<{
    sessionKey: string;
    groupKey: string;
    dataIndex: number;
    overlayShared: TreeDropOverlaySharedValues;
    onDragStart?: (sessionKey: string) => void;
    onDragUpdate?: (event: UseSessionInlineDragDropResultEvent) => void;
    onDragCancel?: (event: UseSessionInlineDragCancelEvent) => void;
    resolveDropResult: (event: UseSessionInlineDragResolveDropResultEvent) => UseSessionInlineDragResolvedDrop;
    onDropResult: (event: UseSessionInlineDragDropResultEvent) => void;
    children: React.ReactNode;
}>) {
    const enabled = Boolean(props.onDropResult);
    const { gesture, animatedStyle } = useSessionInlineDrag({
        enabled,
        sessionKey: props.sessionKey,
        groupKey: props.groupKey,
        dataIndex: props.dataIndex,
        overlayShared: props.overlayShared,
        onDragStart: props.onDragStart ?? (() => {}),
        onDragUpdate: props.onDragUpdate,
        onDragCancel: props.onDragCancel,
        resolveDropResult: props.resolveDropResult,
        onDropResult: props.onDropResult,
    });
    const content = (
        <Animated.View style={animatedStyle}>
            {props.children}
        </Animated.View>
    );
    return gesture ? (
        <GestureDetector gesture={gesture}>
            {content}
        </GestureDetector>
    ) : content;
});
