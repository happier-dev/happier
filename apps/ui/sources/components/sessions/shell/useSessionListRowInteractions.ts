import * as React from 'react';
import { useSharedValue } from 'react-native-reanimated';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
    measureWindowBounds,
    type TreeDropResult,
    type TreeInstructionVisual,
    type WindowBounds,
} from '@/components/ui/treeDragDrop';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { SessionFoldersV1 } from '@/sync/domains/session/folders';
import { setSessionFolderAssignment } from '@/sync/ops/sessionFolders';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { applySessionListTreeDropOperation } from './commit/applySessionListTreeDropOperation';
import { buildSessionListDragSource } from './drop-resolution/buildSessionListDragSource';
import { buildSessionListTreeRows } from './drop-resolution/buildSessionListTreeRows';
import { resolveSessionListInstruction } from './drop-resolution/resolveSessionListInstruction';
import { treeRowId } from './drop-resolution/treeRowId';
import {
    buildSessionListKeyboardMoveResult,
    type SessionListKeyboardMoveDirection,
} from './move-sheet/buildSessionListKeyboardMoveResult';
import {
    buildSessionListMoveSheetTargets,
    type SessionListMoveSheetTarget,
} from './move-sheet/buildSessionListMoveSheetTargets';
import { setTagsForSession } from './sessionTagUtils';
import {
    SESSION_INLINE_DRAG_VISUAL_KIND_NONE,
    type SessionInlineDragVisualKind,
    type SessionInlineDragVisualSharedValues,
    type UseSessionInlineDragDropResultEvent,
    type UseSessionInlineDragResolveDropResultEvent,
} from './useSessionInlineDrag';
import type {
    RegisterSessionListTreeRowBounds,
    UnregisterSessionListTreeRowBounds,
} from './SessionListHeaderFrame';

const IDLE_TREE_DROP_RESULT: TreeDropResult = Object.freeze({
    instruction: Object.freeze({ kind: 'idle' }),
    visual: Object.freeze({ kind: 'none' }),
});

function resolveSessionListSourceRowIdFromDragKey(sessionKey: string): string {
    if (sessionKey.startsWith('folder:')) return sessionKey;
    const separatorIndex = sessionKey.indexOf(':');
    if (separatorIndex <= 0) return `session:${sessionKey}`;
    const serverId = sessionKey.slice(0, separatorIndex);
    const sessionId = sessionKey.slice(separatorIndex + 1);
    return treeRowId.session(serverId, sessionId);
}

type SessionFolderAssignableSessionItem = Readonly<{
    type: 'session';
    session: { id?: string | null };
    serverId?: string;
}>;

export type UseSessionListRowInteractionsInput = Readonly<{
    folderActionsEnabled: boolean;
    sessionFoldersV1: SessionFoldersV1;
    listItems: ReadonlyArray<SessionListIndexItem> | null;
    currentGroupOrderMap: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    setSessionListGroupOrderV1: (value: Record<string, string[]>) => void;
    setSessionFoldersV1: (value: SessionFoldersV1) => void;
    pinnedKeyList: ReadonlyArray<string>;
    pinnedKeySet: ReadonlySet<string>;
    setPinnedSessionKeysV1: (value: string[]) => void;
    sessionTags: Readonly<Record<string, string[]>>;
    setSessionTagsV1: (value: Record<string, string[]>) => void;
}>;

export function useSessionListRowInteractions(input: UseSessionListRowInteractionsInput) {
    const [draggingSessionKey, setDraggingSessionKey] = React.useState<string | null>(null);
    const [nativeContextMenuSessionKey, setNativeContextMenuSessionKey] = React.useState<string | null>(null);
    const [activeDropTargetId, setActiveDropTargetId] = React.useState<string | null>(null);
    const [activeDropVisual, setActiveDropVisual] = React.useState<TreeInstructionVisual>(IDLE_TREE_DROP_RESULT.visual);
    const activeDropTargetIdRef = React.useRef<string | null>(null);
    const treeRowBoundsRef = React.useRef(new Map<string, WindowBounds>());

    const rawDropVisualKind = useSharedValue<SessionInlineDragVisualKind>(SESSION_INLINE_DRAG_VISUAL_KIND_NONE);
    const rawDropVisualTargetId = useSharedValue<string | null>(null);
    const rawDropVisualEdge = useSharedValue<'top' | 'bottom' | null>(null);
    const rawDropVisualDepth = useSharedValue(0);
    const dropVisual = React.useMemo<SessionInlineDragVisualSharedValues>(() => ({
        visualKind: rawDropVisualKind,
        visualTargetId: rawDropVisualTargetId,
        visualEdge: rawDropVisualEdge,
        visualDepth: rawDropVisualDepth,
    }), [rawDropVisualDepth, rawDropVisualEdge, rawDropVisualKind, rawDropVisualTargetId]);

    const listItemsRef = React.useRef(input.listItems);
    listItemsRef.current = input.listItems;
    const groupOrderRef = React.useRef(input.currentGroupOrderMap);
    groupOrderRef.current = input.currentGroupOrderMap;
    const sessionFoldersV1Ref = React.useRef(input.sessionFoldersV1);
    sessionFoldersV1Ref.current = input.sessionFoldersV1;
    const setSessionFoldersV1Ref = React.useRef(input.setSessionFoldersV1);
    setSessionFoldersV1Ref.current = input.setSessionFoldersV1;
    const setSessionListGroupOrderV1Ref = React.useRef(input.setSessionListGroupOrderV1);
    setSessionListGroupOrderV1Ref.current = input.setSessionListGroupOrderV1;

    const clearDragState = React.useCallback(() => {
        activeDropTargetIdRef.current = null;
        setActiveDropTargetId(null);
        setDraggingSessionKey(null);
        setActiveDropVisual(IDLE_TREE_DROP_RESULT.visual);
    }, []);

    const registerTreeRowBounds = React.useCallback<RegisterSessionListTreeRowBounds>((rowId, ref) => {
        void measureWindowBounds(ref).then((bounds) => {
            if (!bounds) return;
            treeRowBoundsRef.current.set(rowId, bounds);
        });
    }, []);

    const unregisterTreeRowBounds = React.useCallback<UnregisterSessionListTreeRowBounds>((rowId) => {
        treeRowBoundsRef.current.delete(rowId);
    }, []);

    const buildCurrentSessionListTree = React.useCallback(() => buildSessionListTreeRows({
        items: listItemsRef.current ?? [],
        rowBoundsById: treeRowBoundsRef.current,
    }), []);

    const persistSessionFolderAssignmentByIds = React.useCallback(async (assignment: Readonly<{
        serverId: string;
        sessionId: string;
        folderId: string | null;
    }>) => {
        if (!input.folderActionsEnabled) return;
        const serverProfile = getServerProfileById(assignment.serverId);
        if (!serverProfile) throw new Error('Missing server profile for session folder assignment');
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverProfile.serverUrl, { serverId: serverProfile.id });
        if (!credentials) throw new Error('Missing server credentials for session folder assignment');
        await setSessionFolderAssignment({
            credentials,
            serverId: serverProfile.id,
            serverUrl: serverProfile.serverUrl,
            sessionId: assignment.sessionId,
            folderId: assignment.folderId,
        });
    }, [input.folderActionsEnabled]);

    const pendingTreeDropRef = React.useRef<Readonly<{
        tree: ReturnType<typeof buildSessionListTreeRows>;
        source: ReturnType<typeof buildSessionListDragSource>;
        result: TreeDropResult;
    }> | null>(null);
    const [, runPendingTreeDrop] = useHappyAction(async () => {
        const pending = pendingTreeDropRef.current;
        pendingTreeDropRef.current = null;
        if (!pending) return;
        await applySessionListTreeDropOperation({
            tree: pending.tree,
            source: pending.source,
            result: pending.result,
            context: {
                sessionFoldersV1: sessionFoldersV1Ref.current,
                sessionListGroupOrderV1: groupOrderRef.current,
                now: () => Date.now(),
                setSessionFoldersV1: setSessionFoldersV1Ref.current,
                setSessionListGroupOrderV1: setSessionListGroupOrderV1Ref.current,
                setSessionFolderAssignment: persistSessionFolderAssignmentByIds,
            },
        });
    }, { mode: 'drop' });

    const resolveTreeDropResult = React.useCallback((event: UseSessionInlineDragResolveDropResultEvent): TreeDropResult => {
        try {
            const tree = buildCurrentSessionListTree();
            const source = buildSessionListDragSource({
                tree,
                sourceRowId: resolveSessionListSourceRowIdFromDragKey(event.sessionKey),
            });
            return resolveSessionListInstruction({
                tree,
                source,
                pointer: event.pointer,
                foldersFeatureEnabled: input.folderActionsEnabled,
            });
        } catch {
            return IDLE_TREE_DROP_RESULT;
        }
    }, [buildCurrentSessionListTree, input.folderActionsEnabled]);

    const commitTreeDropResult = React.useCallback((event: UseSessionInlineDragDropResultEvent) => {
        try {
            const tree = buildCurrentSessionListTree();
            const source = buildSessionListDragSource({
                tree,
                sourceRowId: resolveSessionListSourceRowIdFromDragKey(event.sessionKey),
            });
            pendingTreeDropRef.current = {
                tree,
                source,
                result: event.result,
            };
            runPendingTreeDrop();
        } finally {
            clearDragState();
        }
    }, [buildCurrentSessionListTree, clearDragState, runPendingTreeDrop]);

    const handleDragStart = React.useCallback((sessionKey: string) => {
        setNativeContextMenuSessionKey(null);
        setDraggingSessionKey(sessionKey);
        activeDropTargetIdRef.current = null;
        setActiveDropTargetId(null);
        setActiveDropVisual(IDLE_TREE_DROP_RESULT.visual);
    }, []);

    const handleDragUpdate = React.useCallback((event: UseSessionInlineDragDropResultEvent) => {
        setActiveDropVisual(event.result.visual);
        const nextId = event.result.visual.kind === 'outline' ? event.result.visual.targetId : null;
        if (activeDropTargetIdRef.current === nextId) return;
        activeDropTargetIdRef.current = nextId;
        setActiveDropTargetId(nextId);
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

    const persistSessionFolderAssignment = React.useCallback(async (
        item: SessionFolderAssignableSessionItem,
        folderId: string | null,
    ) => {
        const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
        const sessionId = typeof item.session?.id === 'string' ? item.session.id.trim() : '';
        if (!serverId || !sessionId) return;
        await persistSessionFolderAssignmentByIds({ serverId, sessionId, folderId });
    }, [persistSessionFolderAssignmentByIds]);

    const pendingFolderAssignmentRef = React.useRef<Readonly<{
        item: SessionFolderAssignableSessionItem;
        folderId: string | null;
    }> | null>(null);
    const [, runPendingFolderAssignment] = useHappyAction(async () => {
        const pending = pendingFolderAssignmentRef.current;
        pendingFolderAssignmentRef.current = null;
        if (!pending) return;
        await persistSessionFolderAssignment(pending.item, pending.folderId);
    }, { mode: 'drop' });

    const scheduleSessionFolderAssignment = React.useCallback((
        item: SessionFolderAssignableSessionItem,
        folderId: string | null,
    ) => {
        pendingFolderAssignmentRef.current = { item, folderId };
        runPendingFolderAssignment();
    }, [runPendingFolderAssignment]);

    const resolveMoveSheetTargets = React.useCallback((sourceRowId: string): readonly SessionListMoveSheetTarget[] => {
        if (!input.folderActionsEnabled) return [];
        try {
            const tree = buildCurrentSessionListTree();
            const source = buildSessionListDragSource({ tree, sourceRowId });
            return buildSessionListMoveSheetTargets({ tree, source });
        } catch {
            return [];
        }
    }, [buildCurrentSessionListTree, input.folderActionsEnabled]);

    const applyMoveSheetTarget = React.useCallback((sourceRowId: string, target: SessionListMoveSheetTarget) => {
        if (target.disabled) return;
        try {
            const tree = buildCurrentSessionListTree();
            const source = buildSessionListDragSource({ tree, sourceRowId });
            pendingTreeDropRef.current = {
                tree,
                source,
                result: target.result,
            };
            runPendingTreeDrop();
        } finally {
            clearDragState();
        }
    }, [buildCurrentSessionListTree, clearDragState, runPendingTreeDrop]);

    const applyKeyboardMove = React.useCallback((
        sourceRowId: string,
        direction: SessionListKeyboardMoveDirection,
    ): TreeDropResult | null => {
        if (!input.folderActionsEnabled) return null;
        try {
            const tree = buildCurrentSessionListTree();
            const source = buildSessionListDragSource({ tree, sourceRowId });
            const result = buildSessionListKeyboardMoveResult({ tree, source, direction });
            pendingTreeDropRef.current = {
                tree,
                source,
                result,
            };
            runPendingTreeDrop();
            return result;
        } catch {
            return null;
        } finally {
            clearDragState();
        }
    }, [buildCurrentSessionListTree, clearDragState, input.folderActionsEnabled, runPendingTreeDrop]);

    return {
        activeDropTargetId,
        activeDropVisual,
        applyKeyboardMove,
        applyMoveSheetTarget,
        draggingSessionKey,
        dropVisual,
        handleDragStart,
        handleDragUpdate,
        handleFolderHeaderTreeDropResult: commitTreeDropResult,
        handleTreeDropResult: commitTreeDropResult,
        handleTogglePinnedSessionKey,
        handleSetTagsSessionKey,
        nativeContextMenuSessionKey,
        registerTreeRowBounds,
        resolveMoveSheetTargets,
        resolveTreeDropResult,
        scheduleSessionFolderAssignment,
        setNativeContextMenuSessionKey,
        unregisterTreeRowBounds,
        handleNativeContextMenuOpenChangeSessionKey,
    };
}
