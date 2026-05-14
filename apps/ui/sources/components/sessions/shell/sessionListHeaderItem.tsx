import * as React from 'react';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { t } from '@/text';

import type { SessionListProjectHeaderViewModel } from './sessionListProjectHeaderViewModels';
import { CollapsibleSectionHeader, FolderGroupHeader, ProjectGroupHeader } from './sessionListChrome';
import type { RegisterSessionFolderDropTarget } from './useSessionListViewState';
import { resolveSessionListHeaderViewState } from './resolveSessionListHeaderViewState';
import {
    resolveSessionListHeaderActionHandlers,
    type CreateSessionFromWorkspaceScopeHandler,
} from './resolveSessionListHeaderActionHandlers';
import { useSessionInlineDrag, type SessionInlineDragEndContext } from './useSessionInlineDrag';

const FOLDER_HEADER_DRAG_ROW_HEIGHT = 28;

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
    onRegisterSessionFolderDropTarget?: RegisterSessionFolderDropTarget;
    workspaceFaviconsEnabled?: boolean;
    workspaceMachineSubtitlesEnabled?: boolean;
    dataIndex?: number;
    totalItemCount?: number;
    dropIndicatorIdx?: SharedValue<number>;
    dropIndicatorEdge?: SharedValue<number>;
    onFolderDragStart?: (sessionKey: string) => void;
    onFolderDragUpdate?: (event: Readonly<{ sessionKey: string; absoluteX: number; absoluteY: number }>) => void;
    onFolderDragEnd?: (
        sessionKey: string,
        groupKey: string,
        positionDelta: number,
        context?: SessionInlineDragEndContext,
    ) => void;
    activeFolderDropTargetId?: string | null;
}>;

export const SessionListHeaderItem = React.memo((props: SessionListHeaderItemProps) => {
    if (props.item.headerKind === 'folder') {
        const collapseKey = props.item.groupKey ?? `folder:${props.item.folderId ?? props.item.title}`;
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
                item={props.item}
                onRegisterDropTarget={props.onRegisterSessionFolderDropTarget}
                activeDropTargetId={props.activeFolderDropTargetId}
            />
        );
        if (!props.item.folderId || !props.dropIndicatorIdx || !props.dropIndicatorEdge) {
            return folderHeader;
        }
        return (
            <DraggableFolderHeaderFrame
                sessionKey={`folder:${props.item.folderId}`}
                groupKey={props.item.groupKey ?? `folder:${props.item.folderId}`}
                dataIndex={props.dataIndex ?? 0}
                totalItemCount={props.totalItemCount ?? 0}
                dropIndicatorIdx={props.dropIndicatorIdx}
                dropIndicatorEdge={props.dropIndicatorEdge}
                onDragStart={props.onFolderDragStart}
                onDragUpdate={props.onFolderDragUpdate}
                onDragEnd={props.onFolderDragEnd}
            >
                {folderHeader}
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
        return (
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
                activeDropTargetId={props.activeFolderDropTargetId}
            />
        );
    }

    return (
        <CollapsibleSectionHeader
            title={headerViewState.title}
            collapsed={headerViewState.collapsed}
            onPress={headerActionHandlers.onToggleCollapse}
            showOrderingMenu={props.item.headerKind === 'active' || props.item.headerKind === 'inactive'}
        />
    );
});

const DraggableFolderHeaderFrame = React.memo(function DraggableFolderHeaderFrame(props: Readonly<{
    sessionKey: string;
    groupKey: string;
    dataIndex: number;
    totalItemCount: number;
    dropIndicatorIdx: SharedValue<number>;
    dropIndicatorEdge: SharedValue<number>;
    onDragStart?: (sessionKey: string) => void;
    onDragUpdate?: (event: Readonly<{
        sessionKey: string;
        groupKey: string;
        positionDelta: number;
        dataIndex: number;
        absoluteX: number;
        absoluteY: number;
    }>) => void;
    onDragEnd?: (
        sessionKey: string,
        groupKey: string,
        positionDelta: number,
        context?: SessionInlineDragEndContext,
    ) => void;
    children: React.ReactNode;
}>) {
    const enabled = Boolean(props.onDragEnd);
    const { gesture, animatedStyle } = useSessionInlineDrag({
        enabled,
        sessionKey: props.sessionKey,
        groupKey: props.groupKey,
        rowHeight: FOLDER_HEADER_DRAG_ROW_HEIGHT,
        dataIndex: props.dataIndex,
        totalItemCount: props.totalItemCount,
        dropIndicatorIdx: props.dropIndicatorIdx,
        dropIndicatorEdge: props.dropIndicatorEdge,
        onDragStart: props.onDragStart ?? (() => {}),
        onDragUpdate: props.onDragUpdate,
        onDragEnd: props.onDragEnd ?? (() => {}),
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
