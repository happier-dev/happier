import * as React from 'react';
import { useSharedValue } from 'react-native-reanimated';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import {
    compareSessionFolderWorkspaceRefs,
    resolveSessionFolderDragIntent,
    type SessionFolderWorkspaceRefV1,
} from '@/sync/domains/session/folders';
import { setTagsForSession } from './sessionTagUtils';
import type { SessionInlineDragEndContext } from './useSessionInlineDrag';

type SessionFolderDropTarget = Readonly<
    | {
        id?: string;
        type: 'folder';
        folderId: string;
        workspace: SessionFolderWorkspaceRefV1;
        serverId: string | null;
    }
    | {
        id?: string;
        type: 'workspace-root';
        workspace: SessionFolderWorkspaceRefV1;
        serverId: string | null;
    }
>;

function buildSessionKey(item: Extract<SessionListIndexItem, { type: 'session' }>): string {
    return typeof item.serverId === 'string'
        ? `${item.serverId}:${item.sessionId}`
        : item.sessionId;
}

function resolveFolderAssignmentFromDropPosition(params: Readonly<{
    items: ReadonlyArray<SessionListIndexItem>;
    draggedSession: Extract<SessionListIndexItem, { type: 'session' }>;
    dataIndex: number;
    positionDelta: number;
}>): Readonly<{ folderId: string | null }> | null {
    if (!params.draggedSession.workspace) return null;
    const targetIndex = params.positionDelta > 0
        ? params.dataIndex + params.positionDelta + 1
        : params.dataIndex + params.positionDelta;
    const clampedTargetIndex = Math.max(0, Math.min(params.items.length - 1, targetIndex));
    const target = params.items[clampedTargetIndex];
    if (!target) return null;

    if (target.type === 'header') {
        if (!target.workspace || !compareSessionFolderWorkspaceRefs(target.workspace, params.draggedSession.workspace)) {
            return null;
        }
        if (target.headerKind === 'project') {
            return params.draggedSession.folderId ? { folderId: null } : null;
        }
        if (target.headerKind === 'folder' && target.folderId && target.folderId !== params.draggedSession.folderId) {
            return { folderId: target.folderId };
        }
        return null;
    }

    if (!target.workspace || !compareSessionFolderWorkspaceRefs(target.workspace, params.draggedSession.workspace)) {
        return null;
    }
    const targetFolderId = typeof target.folderId === 'string' && target.folderId.trim().length > 0
        ? target.folderId.trim()
        : null;
    const draggedFolderId = typeof params.draggedSession.folderId === 'string' && params.draggedSession.folderId.trim().length > 0
        ? params.draggedSession.folderId.trim()
        : null;
    if (targetFolderId === draggedFolderId) return null;
    return { folderId: targetFolderId };
}

export function useSessionListRowInteractions(input: Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem> | null;
    currentGroupOrderMap: Readonly<Record<string, string[]>>;
    canReorderSessions: boolean;
    setSessionListGroupOrderV1: (value: Record<string, string[]>) => void;
    pinnedKeyList: ReadonlyArray<string>;
    pinnedKeySet: ReadonlySet<string>;
    setPinnedSessionKeysV1: (value: string[]) => void;
    sessionTags: Readonly<Record<string, string[]>>;
    setSessionTagsV1: (value: Record<string, string[]>) => void;
    resolveFolderDropTarget?: (point: Readonly<{ absoluteX: number; absoluteY: number }>) => SessionFolderDropTarget | null;
    assignSessionFolder?: (params: Readonly<{
        serverId: string;
        sessionId: string;
        folderId: string | null;
    }>) => Promise<void> | void;
}>) {
    const listItemsRef = React.useRef(input.listItems);
    listItemsRef.current = input.listItems;

    const groupOrderRef = React.useRef(input.currentGroupOrderMap);
    groupOrderRef.current = input.currentGroupOrderMap;

    const [draggingSessionKey, setDraggingSessionKey] = React.useState<string | null>(null);
    const [nativeContextMenuSessionKey, setNativeContextMenuSessionKey] = React.useState<string | null>(null);
    const [activeFolderDropTargetId, setActiveFolderDropTargetId] = React.useState<string | null>(null);
    const activeFolderDropTargetIdRef = React.useRef<string | null>(null);

    const dropIndicatorIdx = useSharedValue(-1);
    const dropIndicatorEdge = useSharedValue(0);

    const handleDragEnd = React.useCallback(async (
        sessionKey: string,
        groupKey: string,
        positionDelta: number,
        context?: SessionInlineDragEndContext,
    ) => {
        const items = (listItemsRef.current ?? []) as Array<SessionListIndexItem>;
        const draggedSession = items.find((item): item is Extract<SessionListIndexItem, { type: 'session' }> => (
            item.type === 'session' && buildSessionKey(item) === sessionKey
        ));
        if (
            draggedSession
            && draggedSession.workspace
            && typeof draggedSession.serverId === 'string'
            && context
            && positionDelta === 0
            && typeof context.absoluteX === 'number'
            && typeof context.absoluteY === 'number'
            && input.resolveFolderDropTarget
            && input.assignSessionFolder
        ) {
            const target = input.resolveFolderDropTarget({
                absoluteX: context.absoluteX,
                absoluteY: context.absoluteY,
            });
            if (
                target
                && (target.serverId ?? draggedSession.serverId) === draggedSession.serverId
                && compareSessionFolderWorkspaceRefs(target.workspace, draggedSession.workspace)
            ) {
                const intent = resolveSessionFolderDragIntent({
                    draggedSessionId: draggedSession.sessionId,
                    target: target.type === 'folder'
                        ? { type: 'folder', folderId: target.folderId }
                        : { type: 'workspace-root' },
                });
                if (intent.type === 'assign' || intent.type === 'unassign') {
                await input.assignSessionFolder({
                    serverId: draggedSession.serverId,
                    sessionId: draggedSession.sessionId,
                    folderId: intent.type === 'assign' ? intent.folderId : null,
                });
                activeFolderDropTargetIdRef.current = null;
                setActiveFolderDropTargetId(null);
                setDraggingSessionKey(null);
                return;
            }
            }
        }

        if (
            draggedSession
            && typeof draggedSession.serverId === 'string'
            && input.assignSessionFolder
            && context
            && typeof context.dataIndex === 'number'
        ) {
            const assignment = resolveFolderAssignmentFromDropPosition({
                items,
                draggedSession,
                dataIndex: context.dataIndex,
                positionDelta,
            });
            if (assignment) {
                await input.assignSessionFolder({
                    serverId: draggedSession.serverId,
                    sessionId: draggedSession.sessionId,
                    folderId: assignment.folderId,
                });
                activeFolderDropTargetIdRef.current = null;
                setActiveFolderDropTargetId(null);
                setDraggingSessionKey(null);
                return;
            }
        }

        if (!input.canReorderSessions) {
            activeFolderDropTargetIdRef.current = null;
            setActiveFolderDropTargetId(null);
            setDraggingSessionKey(null);
            return;
        }
        if (positionDelta !== 0) {
            const groupSessions = items.filter(
                (item): item is Extract<SessionListIndexItem, { type: 'session' }> =>
                    item.type === 'session' && String(item.groupKey ?? '').trim() === groupKey,
            );
            const currentMap = groupOrderRef.current;
            const existingOrder = currentMap[groupKey];
            const orderedKeys = existingOrder
                ? existingOrder
                : groupSessions.map((sessionItem) => (
                    typeof sessionItem.serverId === 'string'
                        ? `${sessionItem.serverId}:${sessionItem.sessionId}`
                        : sessionItem.sessionId
                ));
            const currentIndex = orderedKeys.indexOf(sessionKey);
            if (currentIndex >= 0) {
                const targetIndex = Math.max(0, Math.min(orderedKeys.length - 1, currentIndex + positionDelta));
                if (targetIndex !== currentIndex) {
                    const nextOrder = [...orderedKeys];
                    nextOrder.splice(currentIndex, 1);
                    nextOrder.splice(targetIndex, 0, sessionKey);
                    input.setSessionListGroupOrderV1({
                        ...currentMap,
                        [groupKey]: nextOrder.slice(0, SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP),
                    });
                }
            }
        }
        activeFolderDropTargetIdRef.current = null;
        setActiveFolderDropTargetId(null);
        setDraggingSessionKey(null);
    }, [input.assignSessionFolder, input.canReorderSessions, input.resolveFolderDropTarget, input.setSessionListGroupOrderV1]);

    const handleDragStart = React.useCallback((sessionKey: string) => {
        setNativeContextMenuSessionKey(null);
        setDraggingSessionKey(sessionKey);
        activeFolderDropTargetIdRef.current = null;
        setActiveFolderDropTargetId(null);
    }, []);

    const handleDragUpdate = React.useCallback((event: Readonly<{
        sessionKey: string;
        groupKey: string;
        positionDelta: number;
        dataIndex: number;
        absoluteX: number;
        absoluteY: number;
    }>) => {
        if (event.positionDelta !== 0) {
            if (activeFolderDropTargetIdRef.current === null) return;
            activeFolderDropTargetIdRef.current = null;
            setActiveFolderDropTargetId(null);
            return;
        }
        const target = input.resolveFolderDropTarget?.({
            absoluteX: event.absoluteX,
            absoluteY: event.absoluteY,
        });
        const nextId = target?.id ?? null;
        if (activeFolderDropTargetIdRef.current === nextId) return;
        activeFolderDropTargetIdRef.current = nextId;
        setActiveFolderDropTargetId(nextId);
    }, [input]);

    const handleDragCancel = React.useCallback(() => {
        activeFolderDropTargetIdRef.current = null;
        setActiveFolderDropTargetId(null);
        setDraggingSessionKey(null);
    }, []);

    const handleTogglePinnedSessionKey = React.useCallback((sessionKey: string) => {
        if (input.pinnedKeySet.has(sessionKey)) {
            input.setPinnedSessionKeysV1(input.pinnedKeyList.filter((key) => key !== sessionKey));
        } else {
            input.setPinnedSessionKeysV1([...input.pinnedKeyList, sessionKey]);
        }
    }, [input.pinnedKeyList, input.pinnedKeySet, input.setPinnedSessionKeysV1]);

    const handleSetTagsSessionKey = React.useCallback((sessionKey: string, newTags: string[]) => {
        const nextTags = setTagsForSession(input.sessionTags, sessionKey, newTags);
        if (nextTags === input.sessionTags) return;
        input.setSessionTagsV1(nextTags);
    }, [input.sessionTags, input.setSessionTagsV1]);

    const handleNativeContextMenuOpenChangeSessionKey = React.useCallback((sessionKey: string, next: boolean) => {
        setNativeContextMenuSessionKey((prev) => {
            if (next) return sessionKey;
            return prev === sessionKey ? null : prev;
        });
    }, []);

    return {
        draggingSessionKey,
        nativeContextMenuSessionKey,
        activeFolderDropTargetId,
        dropIndicatorIdx,
        dropIndicatorEdge,
        handleDragStart,
        handleDragUpdate,
        handleDragEnd,
        handleDragCancel,
        handleTogglePinnedSessionKey,
        handleSetTagsSessionKey,
        handleNativeContextMenuOpenChangeSessionKey,
    };
}
