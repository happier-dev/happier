import * as React from 'react';
import { Platform } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';

import {
    measureWindowBounds,
    TREE_DROP_OVERLAY_KIND_NONE,
    useEntityDragDropRuntime,
    useTreeDropAutoscroll,
    useTreeDropRegistry,
    windowBoundsToContentBounds,
    type TreeContentRow,
    type TreeDropMeasurableRef,
    type TreeDropOverlayKind,
    type TreeDropOverlaySharedValues,
    type TreeViewportMetrics,
    type WindowBounds,
    type WindowPointer,
} from '@/components/ui/treeDragDrop';
import { putSessionUnderLead } from '@/components/sessions/work/putSessionUnderLead';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { getStorage } from '@/sync/domains/state/storage';
import type { SessionFoldersV1 } from '@/sync/domains/session/folders';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { resolveSessionListSessionRowDragPolicy } from '@/sync/domains/session/listing/sessionListLayout';
import type {
    SessionListOrderingModeV1,
    SessionListOrderingSectionMode,
} from '@/sync/domains/session/listing/sessionListOrderingRules';
import {
    requireSessionOrganizationMutationScope,
    writeSessionOrganizationFolderAssignment,
} from '@/sync/ops/sessionOrganization';

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
import { useSessionListStagedMove } from './keyboardMove/useSessionListStagedMove';
import { useSessionListEntityDragDrop, type SessionListBaseCommitContext, type SessionListCarry } from './useSessionListEntityDragDrop';
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

/**
 * Pointer geometry for the `reportsTo` tree (R-03): the middle of another Session on the same Home
 * means "put under". Whether that Session takes reports is the domain resolver's verdict, so a
 * refused lead still resolves here and the release preview says why instead of nothing lighting up.
 */
function canPutSessionUnder(sessionId: string, leadSessionId: string): boolean {
    if (sessionId === leadSessionId) return false;
    const sessions = getStorage().getState().sessions;
    const lead = sessions[leadSessionId];
    return Boolean(lead) && (lead?.serverId ?? null) === (sessions[sessionId]?.serverId ?? null);
}

const IDLE_RESOLVED_DROP: UseSessionInlineDragResolvedDrop = Object.freeze({
    result: Object.freeze({
        instruction: Object.freeze({ kind: 'idle' }),
        visual: Object.freeze({ kind: 'none' }),
    }),
    geometry: Object.freeze({ kind: 'none' }),
});
const POST_DRAG_FOLDER_FOCUS_PRESS_SUPPRESSION_MS = 750;
const EMPTY_LIST_ITEMS: readonly SessionListIndexItem[] = Object.freeze([]);

type SessionFolderAssignableSessionItem = Readonly<{
    type: 'session';
    session: { id?: string | null };
    serverId?: string;
}>;

type SessionListFolderSortModeV1 = 'foldersFirst' | 'mixed';

type PendingSessionOrganizationCommit = Readonly<{
    commit: () => Promise<Readonly<{ ok: boolean }>>;
    resolve: (succeeded: boolean) => void;
}>;

export type UseSessionListRowInteractionsInput = Readonly<{
    folderActionsEnabled: boolean;
    isFolderActionsEnabledForServerId: (serverId: string | null | undefined) => boolean;
    sessionFoldersV1: SessionFoldersV1;
    listItems: ReadonlyArray<SessionListIndexItem> | null;
    currentGroupOrderMap: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    currentWorkspaceOrderMap: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    sessionListFolderSortModeV1?: SessionListFolderSortModeV1;
    sessionListOrderingModeV1: SessionListOrderingModeV1;
    sessionListSectionModeV1: SessionListOrderingSectionMode;
    manualSessionOrderingEnabled: boolean;
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
    // Mounted geometry changes (virtualized rows arriving, scroll, resize) re-select the place under a carry.
    const entityDragRuntime = useEntityDragDropRuntime();
    const dropGeometryRegistry = useTreeDropRegistry(entityDragRuntime.refresh);

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
    const viewportBoundsRef = React.useRef<WindowBounds | null>(null);
    const scrollOffsetYRef = React.useRef(0);
    const carryRef = React.useRef<SessionListCarry | null>(null);
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

    const latestItems = input.listItems ?? EMPTY_LIST_ITEMS;
    // The immutable list index owns topology. Reuse its projection across all chooser
    // admissions, while every release reads the current render's index and live maps.
    const latestTree = React.useMemo(() => buildSessionListTreeRows({ items: latestItems }), [latestItems]);
    const latestTreeRef = React.useRef(latestTree);
    latestTreeRef.current = latestTree;
    const listItemsRef = React.useRef(latestItems);
    listItemsRef.current = latestItems;
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
    const manualSessionOrderingEnabledRef = React.useRef(input.manualSessionOrderingEnabled);
    manualSessionOrderingEnabledRef.current = input.manualSessionOrderingEnabled;
    const isFolderActionsEnabledForServerIdRef = React.useRef(input.isFolderActionsEnabledForServerId);
    isFolderActionsEnabledForServerIdRef.current = input.isFolderActionsEnabledForServerId;
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

    const commitSessionFoldersV1 = React.useCallback((next: SessionFoldersV1) => {
        sessionFoldersV1Ref.current = next;
        setSessionFoldersV1Ref.current(next);
    }, []);
    const commitSessionListGroupOrderV1 = React.useCallback((next: Record<string, string[]>) => {
        groupOrderRef.current = next;
        setSessionListGroupOrderV1Ref.current(next);
    }, []);
    const commitSessionWorkspaceOrderV1 = React.useCallback((next: Record<string, string[]>) => {
        workspaceOrderRef.current = next;
        setSessionWorkspaceOrderV1Ref.current(next);
    }, []);

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

    const measureTreeRowViewportOffset = React.useCallback(async (
        rowId: string,
        viewportRef: TreeDropMeasurableRef | null,
    ): Promise<number | null> => {
        const rowRef = measuredRowRefsRef.current.get(rowId) ?? null;
        if (!rowRef || !viewportRef) return null;
        const [rowBounds, viewportBounds] = await Promise.all([
            measureWindowBounds(rowRef),
            measureWindowBounds(viewportRef),
        ]);
        if (!rowBounds || !viewportBounds) return null;
        return rowBounds.y - viewportBounds.y;
    }, []);

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
        // Scrolling under a still pointer changes the place beneath it.
        if (carryRef.current) entityDragRuntime.refresh();
    }, [autoscrollScrollOffsetY, entityDragRuntime]);

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
            viewportBoundsRef.current = bounds;
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
        if (!isFolderActionsEnabledForServerIdRef.current(assignment.serverId)) return;
        const scope = await requireSessionOrganizationMutationScope(assignment.serverId);
        await writeSessionOrganizationFolderAssignment({
            scope,
            sessionId: assignment.sessionId,
            folderId: assignment.folderId,
        });
    }, []);

    const pendingOrganizationCommitsRef = React.useRef<PendingSessionOrganizationCommit[]>([]);
    const runPendingOrganizationCommitsRef = React.useRef<() => void>(() => {});
    const [, runPendingOrganizationCommits] = useHappyAction(async () => {
        const pending = pendingOrganizationCommitsRef.current.shift();
        if (!pending) return;
        try {
            const result = await pending.commit();
            pending.resolve(result.ok);
        } catch (error) {
            pending.resolve(false);
            if (pendingOrganizationCommitsRef.current.length > 0) {
                runPendingOrganizationCommitsRef.current();
            }
            throw error;
        }
        if (pendingOrganizationCommitsRef.current.length > 0) {
            runPendingOrganizationCommitsRef.current();
        }
    }, { mode: 'rerun_latest' });
    runPendingOrganizationCommitsRef.current = runPendingOrganizationCommits;
    const enqueueOrganizationCommit = React.useCallback((commit: () => Promise<Readonly<{ ok: boolean }>>): Promise<boolean> => (
        new Promise<boolean>((resolve) => {
            pendingOrganizationCommitsRef.current.push({ commit, resolve });
            runPendingOrganizationCommits();
        })
    ), [runPendingOrganizationCommits]);

    const buildBaseCommitContext = React.useCallback((): SessionListBaseCommitContext => ({
        latestItems: listItemsRef.current,
        latestTree: latestTreeRef.current,
        sessionFoldersV1: sessionFoldersV1Ref.current,
        sessionListGroupOrderV1: groupOrderRef.current,
        sessionWorkspaceOrderV1: workspaceOrderRef.current,
        sessionListFolderSortModeV1: folderSortModeRef.current,
        sessionListOrderingModeV1: sessionListOrderingModeV1Ref.current,
        sessionListSectionModeV1: sessionListSectionModeV1Ref.current,
        manualSessionOrderingEnabled: manualSessionOrderingEnabledRef.current,
        isFolderOrganizationEnabled: (serverId) => isFolderActionsEnabledForServerIdRef.current(serverId),
        now: () => Date.now(),
        setSessionFoldersV1: commitSessionFoldersV1,
        setSessionListGroupOrderV1: commitSessionListGroupOrderV1,
        setSessionWorkspaceOrderV1: commitSessionWorkspaceOrderV1,
        setSessionFolderAssignment: persistSessionFolderAssignmentByIds,
        putSessionUnder: putSessionUnderLead,
    }), [
        commitSessionFoldersV1,
        commitSessionListGroupOrderV1,
        commitSessionWorkspaceOrderV1,
        persistSessionFolderAssignmentByIds,
    ]);

    const commitOrganizationIntent = React.useCallback((intent: ReturnType<typeof buildSessionListDragIntent>) => (
        commitSessionListDragIntent({ intent, context: buildBaseCommitContext() })
    ), [buildBaseCommitContext]);

    const resolvePointerGeometry = React.useCallback((pointer: WindowPointer | null): UseSessionInlineDragResolvedDrop => {
        const snapshot = activeDragSnapshotRef.current;
        if (!snapshot) return IDLE_RESOLVED_DROP;
        try {
            const sourceItem = snapshot.source.treeSource.metadata.item;
            const canReorderSessionSiblings = sourceItem.type === 'session'
                && resolveSessionListSessionRowDragPolicy({
                    manualSessionOrderingEnabled: manualSessionOrderingEnabledRef.current,
                    folderContainmentEnabled: false,
                    item: sourceItem,
                    sectionModeV1: sessionListSectionModeV1Ref.current,
                    orderingModeV1: sessionListOrderingModeV1Ref.current,
                }).canReorderSiblings;
            return resolveSessionListDragPointer({
                snapshot,
                registry: dropGeometryRegistry,
                pointer,
                viewport: readViewportMetrics(),
                canReorderSessionSiblings,
                canPutSessionUnder,
            });
        } catch {
            return IDLE_RESOLVED_DROP;
        }
    }, [dropGeometryRegistry, readViewportMetrics]);

    const entityDragDrop = useSessionListEntityDragDrop({
        resolvePointerGeometry,
        getCommitContext: buildBaseCommitContext,
        getListBounds: () => viewportBoundsRef.current,
    });

    const stagedMove = useSessionListStagedMove({
        getItems: () => listItemsRef.current,
        foldersFeatureEnabled: input.folderActionsEnabled,
        beginCarry: entityDragDrop.beginCarry,
    });

    /**
     * Each pointer frame moves the one carry; the owner resolves the place under it and only an
     * admitted place draws its line or outline. The list itself never re-renders for a frame.
     */
    const resolveDropResult = React.useCallback((event: UseSessionInlineDragResolveDropResultEvent): UseSessionInlineDragResolvedDrop => {
        autoscrollPointerY.value = event.pointer?.y ?? null;
        const carry = carryRef.current;
        if (!carry) return IDLE_RESOLVED_DROP;
        return { result: IDLE_RESOLVED_DROP.result, geometry: carry.move(event.pointer) };
    }, [autoscrollPointerY]);

    const commitTreeDropResult = React.useCallback(async (_event: UseSessionInlineDragDropResultEvent): Promise<void> => {
        suppressNextFolderFocusPressAfterDrag();
        const carry = carryRef.current;
        const snapshot = activeDragSnapshotRef.current;
        carryRef.current = null;
        try {
            await carry?.end(true, null);
        } finally {
            if (activeDragSnapshotRef.current === snapshot) clearDragState();
        }
    }, [clearDragState, suppressNextFolderFocusPressAfterDrag]);

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
        carryRef.current?.cancel();
        carryRef.current = entityDragDrop.beginCarry(snapshot, 'pointer');
        setActiveDragSnapshot(snapshot);
        setNativeContextMenuSessionKey(null);
        setDraggingSessionKey(sessionKey);
        remeasureAllRegisteredRows();
        autoscrollActive.value = true;
        autoscrollPointerY.value = null;
    }, [autoscrollActive, autoscrollPointerY, clearDragState, entityDragDrop, input.folderActionsEnabled, remeasureAllRegisteredRows]);

    const handleDragUpdate = React.useCallback((_event: UseSessionInlineDragDropResultEvent) => {}, []);
    const handleDragCancel = React.useCallback((event?: UseSessionInlineDragCancelEvent) => {
        if (event) {
            suppressNextFolderFocusPressAfterDrag();
        }
        carryRef.current?.cancel();
        carryRef.current = null;
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

    const scheduleSessionFolderAssignment = React.useCallback((
        item: SessionFolderAssignableSessionItem,
        folderId: string | null,
    ): Promise<boolean> => {
        const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
        const sessionId = typeof item.session?.id === 'string' ? item.session.id.trim() : '';
        if (!serverId || !sessionId || !isFolderActionsEnabledForServerIdRef.current(serverId)) {
            return Promise.resolve(false);
        }
        return enqueueOrganizationCommit(async () => {
            if (!isFolderActionsEnabledForServerIdRef.current(serverId)) return { ok: false };
            await persistSessionFolderAssignmentByIds({ serverId, sessionId, folderId });
            return { ok: true };
        });
    }, [enqueueOrganizationCommit, persistSessionFolderAssignmentByIds]);

    const buildLatestGeometryFreeTree = React.useCallback(() => latestTreeRef.current, []);

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

    const enqueueTreeDropOperation = React.useCallback((pending: Readonly<{
        sourceRowId: string;
        sourceKind: ReturnType<typeof buildSessionListDragSource>['kind'];
        result: ReturnType<typeof buildSessionListKeyboardMoveResult> | SessionListMoveSheetTarget['result'];
    }>): Promise<boolean> => enqueueOrganizationCommit(() => commitOrganizationIntent(buildSessionListDragIntent({
        result: pending.result,
        sourceRowId: pending.sourceRowId,
        sourceKind: pending.sourceKind,
        snapshotSignature: `queued:${pending.sourceRowId}`,
    }))), [commitOrganizationIntent, enqueueOrganizationCommit]);

    const applyMoveSheetTarget = React.useCallback((sourceRowId: string, target: SessionListMoveSheetTarget): Promise<boolean> | null => {
        if (target.disabled) return null;
        try {
            const tree = buildLatestGeometryFreeTree();
            const source = buildSessionListDragSource({ tree, sourceRowId });
            return enqueueTreeDropOperation({
                sourceRowId,
                sourceKind: source.kind,
                result: target.result,
            });
        } finally {
            clearDragState();
        }
    }, [buildLatestGeometryFreeTree, clearDragState, enqueueTreeDropOperation]);

    const applyKeyboardMove = React.useCallback((
        sourceRowId: string,
        direction: SessionListKeyboardMoveDirection,
    ): Readonly<{
        result: ReturnType<typeof buildSessionListKeyboardMoveResult>;
        committed: Promise<boolean>;
    }> | null => {
        if (!input.folderActionsEnabled) return null;
        try {
            const tree = buildLatestGeometryFreeTree();
            const source = buildSessionListDragSource({ tree, sourceRowId });
            const result = buildSessionListKeyboardMoveResult({
                tree,
                source,
                direction,
            });
            const committed = enqueueTreeDropOperation({
                sourceRowId,
                sourceKind: source.kind,
                result,
            });
            return { result, committed };
        } catch {
            return null;
        } finally {
            clearDragState();
        }
    }, [buildLatestGeometryFreeTree, clearDragState, enqueueTreeDropOperation, input.folderActionsEnabled]);

    return {
        activeDragSnapshot,
        entityDragDrop,
        stagedMove,
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
        measureTreeRowViewportOffset,
        resolveMoveSheetTargets,
        resolveDropResult,
        resolveTreeDropResult: resolveDropResult,
        scheduleSessionFolderAssignment,
        setNativeContextMenuSessionKey,
        unregisterTreeRowBounds,
        handleNativeContextMenuOpenChangeSessionKey,
    };
}
