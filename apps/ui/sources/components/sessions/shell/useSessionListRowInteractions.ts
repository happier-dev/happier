import * as React from 'react';
import { Platform } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
    measureWindowBounds,
    TREE_DROP_OVERLAY_KIND_NONE,
    useTreeDropAutoscroll,
    useTreeDropRegistry,
    windowBoundsToContentBounds,
    type TreeContentRow,
    type TreeDropMeasurableRef,
    type TreeDropOverlayKind,
    type TreeDropOverlaySharedValues,
    type TreeViewportMetrics,
} from '@/components/ui/treeDragDrop';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { SessionFoldersV1 } from '@/sync/domains/session/folders';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type {
    SessionListOrderingModeV1,
    SessionListOrderingSectionMode,
} from '@/sync/domains/session/listing/sessionListOrderingRules';
import { setSessionFolderAssignment } from '@/sync/ops/sessionOrganization';

import { applySessionListTreeDropOperation } from './commit/applySessionListTreeDropOperation';
import { commitSessionListDragIntent } from './drag/commitSessionListDragIntent';
import { buildSessionListDragIntent } from './drag/sessionListDragIntent';
import { buildSessionListDragSnapshot } from './drag/sessionListDragSnapshot';
import { resolveSessionListDragPointer } from './drag/resolveSessionListDragPointer';
import type { SessionListDragSnapshot } from './drag/_types';
import { buildSessionListDragSource } from './drop-resolution/buildSessionListDragSource';
import { buildSessionListTreeRows } from './drop-resolution/buildSessionListTreeRows';
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
import type {
    UseSessionInlineDragCancelEvent,
    UseSessionInlineDragDropResultEvent,
    UseSessionInlineDragResolveDropResultEvent,
    UseSessionInlineDragResolvedDrop,
} from './useSessionInlineDrag';
import type {
    RegisterSessionListTreeRowBounds,
    UnregisterSessionListTreeRowBounds,
} from './SessionListHeaderFrame';

const IDLE_RESOLVED_DROP: UseSessionInlineDragResolvedDrop = Object.freeze({
    result: Object.freeze({
        instruction: Object.freeze({ kind: 'idle' }),
        visual: Object.freeze({ kind: 'none' }),
    }),
    geometry: Object.freeze({ kind: 'none' }),
});
const POST_DRAG_FOLDER_FOCUS_PRESS_SUPPRESSION_MS = 750;

function resolveSessionListSourceRowIdFromDragKey(sessionKey: string): string {
    if (sessionKey.startsWith('workspace-root:')) return sessionKey;
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

type SessionListFolderSortModeV1 = 'foldersFirst' | 'mixed';

export type UseSessionListRowInteractionsInput = Readonly<{
    folderActionsEnabled: boolean;
    sessionFoldersV1: SessionFoldersV1;
    listItems: ReadonlyArray<SessionListIndexItem> | null;
    currentGroupOrderMap: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    currentWorkspaceOrderMap: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    sessionListFolderSortModeV1?: SessionListFolderSortModeV1;
    sessionListOrderingModeV1: SessionListOrderingModeV1;
    sessionListSectionModeV1: SessionListOrderingSectionMode;
    setSessionListGroupOrderV1: (value: Record<string, string[]>) => void;
    setSessionWorkspaceOrderV1: (value: Record<string, string[]>) => void;
    setSessionFoldersV1: (value: SessionFoldersV1) => void;
    pinnedKeySet: ReadonlySet<string>;
    sessionTags: Readonly<Record<string, string[]>>;
    setSessionPinForKey: (sessionKey: string, pinned: boolean) => void;
    setSessionTagsForKey: (sessionKey: string, tags: readonly string[]) => void;
    scrollToOffset?: (offsetY: number) => void;
}>;

export function useSessionListRowInteractions(input: UseSessionListRowInteractionsInput) {
    const [draggingSessionKey, setDraggingSessionKey] = React.useState<string | null>(null);
    const [activeDragSnapshot, setActiveDragSnapshot] = React.useState<SessionListDragSnapshot | null>(null);
    const [nativeContextMenuSessionKey, setNativeContextMenuSessionKey] = React.useState<string | null>(null);
    const nativeListScrollInteractionActiveRef = React.useRef(false);
    const suppressFolderFocusPressUntilRef = React.useRef(0);

    const activeDragSnapshotRef = React.useRef<SessionListDragSnapshot | null>(null);
    const dropGeometryRegistry = useTreeDropRegistry();

    const overlayVisible = useSharedValue(0);
    const overlayKind = useSharedValue<TreeDropOverlayKind>(TREE_DROP_OVERLAY_KIND_NONE);
    const overlayTop = useSharedValue(0);
    const overlayHeight = useSharedValue(0);
    const overlayLeft = useSharedValue(0);
    const overlayRight = useSharedValue(0);
    const overlayDepth = useSharedValue(0);
    const dropOverlayShared = React.useMemo<TreeDropOverlaySharedValues>(() => ({
        overlayVisible,
        overlayKind,
        overlayTop,
        overlayHeight,
        overlayLeft,
        overlayRight,
        overlayDepth,
    }), [overlayDepth, overlayHeight, overlayKind, overlayLeft, overlayRight, overlayTop, overlayVisible]);

    const autoscrollActive = useSharedValue(false);
    const autoscrollPointerY = useSharedValue<number | null>(null);
    const autoscrollViewportTopY = useSharedValue(0);
    const autoscrollViewportHeight = useSharedValue(0);
    const autoscrollScrollOffsetY = useSharedValue(0);
    const autoscrollContentHeight = useSharedValue(0);

    const viewportWindowYRef = React.useRef(0);
    const viewportWindowXRef = React.useRef(0);
    const viewportHeightRef = React.useRef(0);
    const scrollOffsetYRef = React.useRef(0);
    const measuredRowRefsRef = React.useRef(new Map<string, TreeDropMeasurableRef>());

    const noopScrollToOffset = React.useCallback(() => {}, []);
    const scrollToOffset = input.scrollToOffset ?? noopScrollToOffset;

    useTreeDropAutoscroll({
        isActive: autoscrollActive,
        pointerY: autoscrollPointerY,
        viewportTopY: autoscrollViewportTopY,
        viewportHeight: autoscrollViewportHeight,
        scrollOffsetY: autoscrollScrollOffsetY,
        contentHeight: autoscrollContentHeight,
        scrollToOffset,
    });

    const listItemsRef = React.useRef(input.listItems ?? []);
    listItemsRef.current = input.listItems ?? [];
    const groupOrderRef = React.useRef(input.currentGroupOrderMap);
    groupOrderRef.current = input.currentGroupOrderMap;
    const workspaceOrderRef = React.useRef(input.currentWorkspaceOrderMap);
    workspaceOrderRef.current = input.currentWorkspaceOrderMap;
    const sessionFoldersV1Ref = React.useRef(input.sessionFoldersV1);
    sessionFoldersV1Ref.current = input.sessionFoldersV1;
    const folderSortModeRef = React.useRef(input.sessionListFolderSortModeV1);
    folderSortModeRef.current = input.sessionListFolderSortModeV1;
    const sessionListOrderingModeV1Ref = React.useRef(input.sessionListOrderingModeV1);
    sessionListOrderingModeV1Ref.current = input.sessionListOrderingModeV1;
    const sessionListSectionModeV1Ref = React.useRef(input.sessionListSectionModeV1);
    sessionListSectionModeV1Ref.current = input.sessionListSectionModeV1;
    const folderActionsEnabledRef = React.useRef(input.folderActionsEnabled);
    folderActionsEnabledRef.current = input.folderActionsEnabled;
    const setSessionFoldersV1Ref = React.useRef(input.setSessionFoldersV1);
    setSessionFoldersV1Ref.current = input.setSessionFoldersV1;
    const setSessionListGroupOrderV1Ref = React.useRef(input.setSessionListGroupOrderV1);
    setSessionListGroupOrderV1Ref.current = input.setSessionListGroupOrderV1;
    const setSessionWorkspaceOrderV1Ref = React.useRef(input.setSessionWorkspaceOrderV1);
    setSessionWorkspaceOrderV1Ref.current = input.setSessionWorkspaceOrderV1;
    const pinnedKeySetRef = React.useRef(input.pinnedKeySet);
    pinnedKeySetRef.current = input.pinnedKeySet;
    const sessionTagsRef = React.useRef(input.sessionTags);
    sessionTagsRef.current = input.sessionTags;
    const setSessionPinForKeyRef = React.useRef(input.setSessionPinForKey);
    setSessionPinForKeyRef.current = input.setSessionPinForKey;
    const setSessionTagsForKeyRef = React.useRef(input.setSessionTagsForKey);
    setSessionTagsForKeyRef.current = input.setSessionTagsForKey;

    const readViewportMetrics = React.useCallback((): TreeViewportMetrics => ({
        viewportWindowY: viewportWindowYRef.current,
        viewportWindowX: viewportWindowXRef.current,
        scrollOffsetY: scrollOffsetYRef.current,
        viewportHeight: viewportHeightRef.current,
    }), []);

    const clearDragState = React.useCallback(() => {
        activeDragSnapshotRef.current = null;
        setActiveDragSnapshot(null);
        setDraggingSessionKey(null);
        autoscrollActive.value = false;
        autoscrollPointerY.value = null;
        overlayVisible.value = 0;
        overlayKind.value = TREE_DROP_OVERLAY_KIND_NONE;
    }, [autoscrollActive, autoscrollPointerY, overlayKind, overlayVisible]);
    const suppressNextFolderFocusPressAfterDrag = React.useCallback(() => {
        suppressFolderFocusPressUntilRef.current = Date.now() + POST_DRAG_FOLDER_FOCUS_PRESS_SUPPRESSION_MS;
    }, []);
    const consumeFolderFocusPressAfterDrag = React.useCallback(() => {
        const deadline = suppressFolderFocusPressUntilRef.current;
        if (deadline <= 0) return false;
        if (Date.now() > deadline) {
            suppressFolderFocusPressUntilRef.current = 0;
            return false;
        }
        suppressFolderFocusPressUntilRef.current = 0;
        return true;
    }, []);

    const registerRowContentGeometry = React.useCallback((rowId: string, ref: TreeDropMeasurableRef | null) => {
        if (!ref) return;
        const snapshot = activeDragSnapshotRef.current;
        if (!snapshot) return;
        const topologyRow = snapshot.topology.rows.find((row) => row.rowId === rowId);
        if (!topologyRow) return;
        void measureWindowBounds(ref).then((windowBounds) => {
            if (!windowBounds) return;
            const contentBounds = windowBoundsToContentBounds(windowBounds, readViewportMetrics());
            if (!contentBounds) return;
            if (activeDragSnapshotRef.current !== snapshot) return;
            const row: TreeContentRow = {
                id: topologyRow.rowId,
                parentId: topologyRow.parentRowId,
                containerId: topologyRow.containerId,
                depth: topologyRow.depth,
                kind: topologyRow.kind,
                bounds: contentBounds,
            };
            dropGeometryRegistry.registerRow(row);
        });
    }, [dropGeometryRegistry, readViewportMetrics]);

    const registerTreeRowBounds = React.useCallback<RegisterSessionListTreeRowBounds>((rowId, ref) => {
        if (ref) {
            measuredRowRefsRef.current.set(rowId, ref);
        } else {
            measuredRowRefsRef.current.delete(rowId);
        }
        registerRowContentGeometry(rowId, ref);
    }, [registerRowContentGeometry]);

    const unregisterTreeRowBounds = React.useCallback<UnregisterSessionListTreeRowBounds>((rowId) => {
        measuredRowRefsRef.current.delete(rowId);
        dropGeometryRegistry.unregisterRow(rowId);
    }, [dropGeometryRegistry]);

    const remeasureAllRegisteredRows = React.useCallback(() => {
        for (const [rowId, ref] of measuredRowRefsRef.current) {
            registerRowContentGeometry(rowId, ref);
        }
    }, [registerRowContentGeometry]);

    const handleTreeScroll = React.useCallback((event: { nativeEvent?: { contentOffset?: { y?: number } } }) => {
        const nextOffset = Number(event.nativeEvent?.contentOffset?.y ?? 0);
        if (!Number.isFinite(nextOffset)) return;
        scrollOffsetYRef.current = nextOffset;
        autoscrollScrollOffsetY.value = nextOffset;
    }, [autoscrollScrollOffsetY]);

    const handleTreeContentSizeChange = React.useCallback((_width: number, height: number) => {
        if (!Number.isFinite(height)) return;
        autoscrollContentHeight.value = Math.max(0, height);
    }, [autoscrollContentHeight]);

    const handleTreeListLayout = React.useCallback((event: { nativeEvent?: { layout?: { height?: number } } }) => {
        const height = Number(event.nativeEvent?.layout?.height ?? 0);
        if (Number.isFinite(height)) {
            viewportHeightRef.current = Math.max(0, height);
            autoscrollViewportHeight.value = Math.max(0, height);
        }
    }, [autoscrollViewportHeight]);

    const handleTreeViewportMeasure = React.useCallback((ref: TreeDropMeasurableRef | null) => {
        void measureWindowBounds(ref).then((bounds) => {
            if (!bounds) return;
            viewportWindowYRef.current = bounds.y;
            viewportWindowXRef.current = bounds.x;
            viewportHeightRef.current = bounds.height;
            autoscrollViewportTopY.value = bounds.y;
            autoscrollViewportHeight.value = bounds.height;
        });
    }, [autoscrollViewportHeight, autoscrollViewportTopY]);

    const persistSessionFolderAssignmentByIds = React.useCallback(async (assignment: Readonly<{
        serverId: string;
        sessionId: string;
        folderId: string | null;
    }>) => {
        if (!folderActionsEnabledRef.current) return;
        const serverProfile = getServerProfileById(assignment.serverId);
        if (!serverProfile) throw new Error('Missing server profile for session folder assignment');
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverProfile.serverUrl, { serverId: serverProfile.id });
        if (!credentials) throw new Error('Missing server credentials for session folder assignment');
        await setSessionFolderAssignment({
            credentials,
            serverId: assignment.serverId,
            serverUrl: serverProfile.serverUrl,
            sessionId: assignment.sessionId,
            folderId: assignment.folderId,
        });
    }, []);

    const pendingDragIntentRef = React.useRef<ReturnType<typeof buildSessionListDragIntent> | null>(null);
    const [, runPendingDragCommit] = useHappyAction(async () => {
        const intent = pendingDragIntentRef.current;
        pendingDragIntentRef.current = null;
        if (!intent) return;
        await commitSessionListDragIntent({
            intent,
            context: {
                latestItems: listItemsRef.current,
                sessionFoldersV1: sessionFoldersV1Ref.current,
                sessionListGroupOrderV1: groupOrderRef.current,
                sessionWorkspaceOrderV1: workspaceOrderRef.current,
                sessionListFolderSortModeV1: folderSortModeRef.current,
                sessionListOrderingModeV1: sessionListOrderingModeV1Ref.current,
                sessionListSectionModeV1: sessionListSectionModeV1Ref.current,
                now: () => Date.now(),
                setSessionFoldersV1: setSessionFoldersV1Ref.current,
                setSessionListGroupOrderV1: setSessionListGroupOrderV1Ref.current,
                setSessionWorkspaceOrderV1: setSessionWorkspaceOrderV1Ref.current,
                setSessionFolderAssignment: persistSessionFolderAssignmentByIds,
            },
        });
    }, { mode: 'drop' });

    const resolveDropResult = React.useCallback((event: UseSessionInlineDragResolveDropResultEvent): UseSessionInlineDragResolvedDrop => {
        const snapshot = activeDragSnapshotRef.current;
        autoscrollPointerY.value = event.pointer?.y ?? null;
        if (!snapshot) return IDLE_RESOLVED_DROP;
        try {
            return resolveSessionListDragPointer({
                snapshot,
                registry: dropGeometryRegistry,
                pointer: event.pointer,
                viewport: readViewportMetrics(),
            });
        } catch {
            return IDLE_RESOLVED_DROP;
        }
    }, [autoscrollPointerY, dropGeometryRegistry, readViewportMetrics]);

    const commitTreeDropResult = React.useCallback((event: UseSessionInlineDragDropResultEvent) => {
        suppressNextFolderFocusPressAfterDrag();
        const snapshot = activeDragSnapshotRef.current;
        try {
            if (!snapshot) return;
            const intent = buildSessionListDragIntent({
                result: event.result,
                sourceRowId: snapshot.source.sourceRowId,
                sourceKind: snapshot.source.kind,
                snapshotSignature: snapshot.signature,
            });
            pendingDragIntentRef.current = intent;
            runPendingDragCommit();
        } finally {
            clearDragState();
        }
    }, [clearDragState, runPendingDragCommit, suppressNextFolderFocusPressAfterDrag]);

    const handleDragStart = React.useCallback((sessionKey: string) => {
        let snapshot: SessionListDragSnapshot;
        try {
            snapshot = buildSessionListDragSnapshot({
                items: listItemsRef.current,
                viewItems: listItemsRef.current,
                sessionDragKey: sessionKey,
                foldersFeatureEnabled: input.folderActionsEnabled,
            });
        } catch {
            clearDragState();
            return;
        }
        activeDragSnapshotRef.current = snapshot;
        setActiveDragSnapshot(snapshot);
        setNativeContextMenuSessionKey(null);
        setDraggingSessionKey(sessionKey);
        remeasureAllRegisteredRows();
        autoscrollActive.value = true;
        autoscrollPointerY.value = null;
    }, [autoscrollActive, autoscrollPointerY, clearDragState, input.folderActionsEnabled, remeasureAllRegisteredRows]);

    const handleDragUpdate = React.useCallback((_event: UseSessionInlineDragDropResultEvent) => {}, []);
    const handleDragCancel = React.useCallback((event?: UseSessionInlineDragCancelEvent) => {
        if (event) {
            suppressNextFolderFocusPressAfterDrag();
        }
        clearDragState();
    }, [clearDragState, suppressNextFolderFocusPressAfterDrag]);

    const handleTogglePinnedSessionKey = React.useCallback((sessionKey: string) => {
        if (pinnedKeySetRef.current.has(sessionKey)) {
            setSessionPinForKeyRef.current(sessionKey, false);
        } else {
            setSessionPinForKeyRef.current(sessionKey, true);
        }
    }, []);

    const handleSetTagsSessionKey = React.useCallback((sessionKey: string, newTags: string[]) => {
        const sessionTags = sessionTagsRef.current;
        const nextTags = setTagsForSession(sessionTags, sessionKey, newTags);
        if (nextTags === sessionTags) return;
        setSessionTagsForKeyRef.current(sessionKey, nextTags[sessionKey] ?? []);
    }, []);

    const handleNativeListScrollInteractionStart = React.useCallback(() => {
        if (Platform.OS !== 'ios') return;
        nativeListScrollInteractionActiveRef.current = true;
        setNativeContextMenuSessionKey(null);
    }, []);

    const handleNativeListScrollInteractionEnd = React.useCallback(() => {
        if (Platform.OS !== 'ios') return;
        nativeListScrollInteractionActiveRef.current = false;
    }, []);

    const handleNativeContextMenuOpenChangeSessionKey = React.useCallback((sessionKey: string, next: boolean) => {
        if (next && nativeListScrollInteractionActiveRef.current) return;
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

    const buildLatestGeometryFreeTree = React.useCallback(() => buildSessionListTreeRows({
        items: listItemsRef.current,
    }), []);

    const resolveMoveSheetTargets = React.useCallback((sourceRowId: string): readonly SessionListMoveSheetTarget[] => {
        if (!input.folderActionsEnabled) return [];
        try {
            const tree = buildLatestGeometryFreeTree();
            const source = buildSessionListDragSource({ tree, sourceRowId });
            return buildSessionListMoveSheetTargets({ tree, source });
        } catch {
            return [];
        }
    }, [buildLatestGeometryFreeTree, input.folderActionsEnabled]);

    const pendingTreeDropRef = React.useRef<Readonly<{
        tree: ReturnType<typeof buildSessionListTreeRows>;
        source: ReturnType<typeof buildSessionListDragSource>;
        result: ReturnType<typeof buildSessionListKeyboardMoveResult> | SessionListMoveSheetTarget['result'];
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
                sessionWorkspaceOrderV1: workspaceOrderRef.current,
                sessionListFolderSortModeV1: folderSortModeRef.current,
                sessionListOrderingModeV1: sessionListOrderingModeV1Ref.current,
                sessionListSectionModeV1: sessionListSectionModeV1Ref.current,
                now: () => Date.now(),
                setSessionFoldersV1: setSessionFoldersV1Ref.current,
                setSessionListGroupOrderV1: setSessionListGroupOrderV1Ref.current,
                setSessionWorkspaceOrderV1: setSessionWorkspaceOrderV1Ref.current,
                setSessionFolderAssignment: persistSessionFolderAssignmentByIds,
            },
        });
    }, { mode: 'drop' });

    const applyMoveSheetTarget = React.useCallback((sourceRowId: string, target: SessionListMoveSheetTarget) => {
        if (target.disabled) return;
        try {
            const tree = buildLatestGeometryFreeTree();
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
    }, [buildLatestGeometryFreeTree, clearDragState, runPendingTreeDrop]);

    const applyKeyboardMove = React.useCallback((
        sourceRowId: string,
        direction: SessionListKeyboardMoveDirection,
    ): ReturnType<typeof buildSessionListKeyboardMoveResult> | null => {
        if (!input.folderActionsEnabled) return null;
        try {
            const tree = buildLatestGeometryFreeTree();
            const source = buildSessionListDragSource({ tree, sourceRowId });
            const result = buildSessionListKeyboardMoveResult({
                tree,
                source,
                direction,
            });
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
    }, [buildLatestGeometryFreeTree, clearDragState, input.folderActionsEnabled, runPendingTreeDrop]);

    return {
        activeDragSnapshot,
        applyKeyboardMove,
        applyMoveSheetTarget,
        consumeFolderFocusPressAfterDrag,
        draggingSessionKey,
        dropOverlayShared,
        handleDragCancel,
        handleDragStart,
        handleDragUpdate,
        handleFolderHeaderTreeDropResult: commitTreeDropResult,
        handleTreeContentSizeChange,
        handleTreeDropResult: commitTreeDropResult,
        handleTreeListLayout,
        handleTreeScroll,
        handleTreeViewportMeasure,
        handleTogglePinnedSessionKey,
        handleSetTagsSessionKey,
        handleNativeListScrollInteractionEnd,
        handleNativeListScrollInteractionStart,
        nativeContextMenuSessionKey,
        registerTreeRowBounds,
        resolveMoveSheetTargets,
        resolveDropResult,
        resolveTreeDropResult: resolveDropResult,
        scheduleSessionFolderAssignment,
        setNativeContextMenuSessionKey,
        unregisterTreeRowBounds,
        handleNativeContextMenuOpenChangeSessionKey,
    };
}
