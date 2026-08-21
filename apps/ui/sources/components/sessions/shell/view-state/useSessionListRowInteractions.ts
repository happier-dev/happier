import React from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';

import type { SessionFoldersV1 } from '@/sync/domains/session/folders';
import { setSessionFolderAssignment } from '@/sync/ops/sessionOrganization';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import {
    measureWindowBounds,
    useTreeDropAutoscroll,
    useTreeDropRegistry,
    windowBoundsToContentBounds,
    TREE_DROP_OVERLAY_KIND_NONE,
    type TreeContentRow,
    type TreeDropMeasurableRef,
    type TreeDropOverlayKind,
    type TreeDropOverlaySharedValues,
    type TreeViewportMetrics,
} from '@/components/ui/treeDragDrop';

import type {
    UseSessionInlineDragCancelEvent,
    UseSessionInlineDragDropResultEvent,
    UseSessionInlineDragResolveDropResultEvent,
    UseSessionInlineDragResolvedDrop,
} from '../useSessionInlineDrag';
import type {
    RegisterSessionListTreeRowBounds,
    UnregisterSessionListTreeRowBounds,
} from '../SessionListHeaderFrame';
import { buildSessionListDragSnapshot } from '../drag/sessionListDragSnapshot';
import { buildSessionListDragIntent } from '../drag/sessionListDragIntent';
import { commitSessionListDragIntent } from '../drag/commitSessionListDragIntent';
import { resolveSessionListDragPointer } from '../drag/resolveSessionListDragPointer';
import type { SessionListDragSnapshot } from '../drag/_types';
import { applySessionListTreeDropOperation } from '../commit/applySessionListTreeDropOperation';
import { buildSessionListDragSource } from '../drop-resolution/buildSessionListDragSource';
import { buildSessionListTreeRows } from '../drop-resolution/buildSessionListTreeRows';
import type {
    SessionListFolderSortMode,
    SessionListTreeDropResult,
} from '../drop-resolution/sessionListTreeTypes';
import { treeRowId } from '../drop-resolution/treeRowId';
import type { SessionListIndexItem } from '@/sync/domains/session/listing/sessionListIndex';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import {
    normalizeSessionListOrderingModeV1,
    resolveEffectiveSessionListOrderingModeForGroup,
    type SessionListOrderingModeV1,
    type SessionListOrderingSectionMode,
} from '@/sync/domains/session/listing/sessionListOrderingRules';
import {
    buildSessionListMoveSheetTargets,
    type SessionListMoveSheetTarget,
} from '../move-sheet/buildSessionListMoveSheetTargets';
import {
    buildSessionListKeyboardMoveResult,
    type SessionListKeyboardMoveDirection,
} from '../move-sheet/buildSessionListKeyboardMoveResult';
import { resolveSessionOrganizationMutationScope } from '@/sync/domains/session/organization/mutationScope';

const FOLDER_ASSIGNMENT_SCOPE_REQUIREMENT_BY_REASON = {
    'server-id': 'server id',
    'server-profile': 'server profile',
    credentials: 'server credentials',
} as const;

type SessionFolderAssignableSessionItem = Readonly<{
    type: 'session';
    session: { id?: string | null };
    serverId?: string;
}>;

type SessionListSessionIndexItem = Extract<SessionListIndexItem, { type: 'session' }>;

function isSessionListSessionIndexItem(item: SessionListIndexItem): item is SessionListSessionIndexItem {
    return item.type === 'session';
}

const IDLE_TREE_DROP_RESULT: SessionListTreeDropResult = Object.freeze({
    instruction: Object.freeze({ kind: 'idle' }),
    visual: Object.freeze({ kind: 'none' }),
});

const IDLE_RESOLVED_DROP: UseSessionInlineDragResolvedDrop = Object.freeze({
    result: IDLE_TREE_DROP_RESULT,
    geometry: Object.freeze({ kind: 'none' }),
});

const DATE_ORDERING_BLOCKED_TREE_DROP_RESULT: SessionListTreeDropResult = Object.freeze({
    instruction: Object.freeze({ kind: 'blocked', reason: 'same-position' }),
    visual: Object.freeze({ kind: 'none' }),
    sessionListBlockReason: 'date-ordering-mode',
});

const DATE_ORDERING_BLOCKED_RESOLVED_DROP: UseSessionInlineDragResolvedDrop = Object.freeze({
    result: DATE_ORDERING_BLOCKED_TREE_DROP_RESULT,
    geometry: Object.freeze({ kind: 'none' }),
});

/**
 * Maps a `useSessionInlineDrag` drag key to its stable tree row id. Folder and
 * workspace-root keys are already row ids; a `server:session` key expands to a
 * `session:` row id.
 */
function resolveSessionListSourceRowIdFromDragKey(sessionKey: string): string {
    if (sessionKey.startsWith('folder:')) return sessionKey;
    if (sessionKey.startsWith('workspace-root:')) return sessionKey;
    const separatorIndex = sessionKey.indexOf(':');
    if (separatorIndex <= 0) return `session:${sessionKey}`;
    const serverId = sessionKey.slice(0, separatorIndex);
    const sessionId = sessionKey.slice(separatorIndex + 1);
    return treeRowId.session(serverId, sessionId);
}

function normalizeSessionListSectionMode(value: SessionListOrderingSectionMode | undefined): SessionListOrderingSectionMode {
    return value === 'single' ? 'single' : 'activity';
}

function shouldBlockResolvedDropForOrderingMode(params: Readonly<{
    snapshot: SessionListDragSnapshot;
    result: SessionListTreeDropResult;
    sessionListOrderingModeV1: SessionListOrderingModeV1;
    sessionListSectionModeV1: SessionListOrderingSectionMode;
}>): boolean {
    const source = params.snapshot.source.treeSource;
    if (source.metadata.kind !== 'session') return false;
    const instruction = params.result.instruction;
    if (instruction.kind === 'blocked' || instruction.kind === 'idle' || instruction.kind === 'nest-into') {
        return false;
    }
    const container = params.snapshot.topology.containerMetadataById.get(instruction.containerId);
    if (!container) return false;
    if ((source.metadata.folderId ?? null) !== container.folderId) return false;

    const item = source.metadata.item;
    if (!isSessionListSessionIndexItem(item)) return false;
    const sectionMode = normalizeSessionListSectionMode(params.sessionListSectionModeV1);
    const effectiveOrderingMode = resolveEffectiveSessionListOrderingModeForGroup({
        section: sectionMode === 'single' ? 'sessions' : item.section,
        sectionMode,
        groupKind: item.groupKind,
        userOrderingMode: normalizeSessionListOrderingModeV1(params.sessionListOrderingModeV1),
    });
    return effectiveOrderingMode !== 'custom';
}

export type UseSessionListRowInteractionsInput = Readonly<{
    folderActionsEnabled: boolean;
    folderSortMode?: SessionListFolderSortMode;
    sessionListOrderingModeV1: SessionListOrderingModeV1;
    sessionListSectionModeV1: SessionListOrderingSectionMode;
    sessionFoldersV1: SessionFoldersV1;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    sessionWorkspaceOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    sessionListIndexRef: React.MutableRefObject<ReadonlyArray<SessionListIndexItem>>;
    /**
     * Latest visible render items. Frozen at drag start into the snapshot so the
     * visible surface holds steady while the user drags.
     */
    listItemsRef: React.MutableRefObject<ReadonlyArray<SessionListViewItem>>;
    setSessionFoldersV1: (value: SessionFoldersV1) => void;
    setSessionListGroupOrderV1: (value: Record<string, string[]>) => void;
    setSessionWorkspaceOrderV1: (value: Record<string, string[]>) => void;
    scrollToOffset: (offsetY: number) => void;
}>;

/**
 * Owns session-list pointer drag interaction: the live content-coordinate
 * geometry registry, the frozen drag snapshot, pointer resolution, the
 * commit-time intent rebase, autoscroll wiring, and the discrete
 * move-sheet/keyboard moves.
 *
 * Phase 2/3/4 of the session-list drag geometry & performance unification. The
 * hot drag frame does one `scheduleOnRN` hop, one hit-test against Lane A's
 * live registry, and numeric overlay shared-value writes — it never rebuilds
 * the tree per pointer move and never sets list-wide React state. The visible
 * surface is frozen for the duration of a drag; the commit rebases a stable
 * `SessionListDragIntent` onto the latest live state.
 */
export function useSessionListRowInteractions({
    folderActionsEnabled,
    folderSortMode,
    sessionListOrderingModeV1,
    sessionListSectionModeV1,
    sessionFoldersV1,
    sessionListGroupOrderV1,
    sessionWorkspaceOrderV1,
    sessionListIndexRef,
    listItemsRef,
    setSessionFoldersV1,
    setSessionListGroupOrderV1,
    setSessionWorkspaceOrderV1,
    scrollToOffset,
}: UseSessionListRowInteractionsInput) {
    // Minimal React state: only the dragged key + active snapshot flip on drag
    // start/end. No per-pointer-frame state lives here.
    const [draggingSessionKey, setDraggingSessionKey] = React.useState<string | null>(null);
    const [activeDragSnapshot, setActiveDragSnapshot] = React.useState<SessionListDragSnapshot | null>(null);
    const [nativeContextMenuSessionKey, setNativeContextMenuSessionKey] = React.useState<string | null>(null);

    // The active drag snapshot is held in a ref for the hot resolve path so the
    // resolver never depends on React state timing.
    const activeDragSnapshotRef = React.useRef<SessionListDragSnapshot | null>(null);

    // Lane A's live content-coordinate geometry registry. Rows register content
    // bounds on layout; the resolver queries it live every pointer frame.
    const dropGeometryRegistry = useTreeDropRegistry();

    // Numeric overlay geometry shared values for the single list-level overlay.
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

    // Live viewport + scroll metrics, read each resolve to convert the pointer
    // into stable content coordinates. Never frozen into the drag snapshot.
    const viewportWindowYRef = React.useRef(0);
    const viewportWindowXRef = React.useRef(0);
    const viewportHeightRef = React.useRef(0);
    const scrollOffsetYRef = React.useRef(0);

    const autoscrollActive = useSharedValue(false);
    const autoscrollPointerY = useSharedValue<number | null>(null);
    const autoscrollViewportTopY = useSharedValue(0);
    const autoscrollViewportHeight = useSharedValue(0);
    const autoscrollScrollOffsetY = useSharedValue(0);
    const autoscrollContentHeight = useSharedValue(0);

    useTreeDropAutoscroll({
        isActive: autoscrollActive,
        pointerY: autoscrollPointerY,
        viewportTopY: autoscrollViewportTopY,
        viewportHeight: autoscrollViewportHeight,
        scrollOffsetY: autoscrollScrollOffsetY,
        contentHeight: autoscrollContentHeight,
        scrollToOffset,
    });

    const groupOrderRef = React.useRef(sessionListGroupOrderV1);
    groupOrderRef.current = sessionListGroupOrderV1;
    const workspaceOrderRef = React.useRef(sessionWorkspaceOrderV1);
    workspaceOrderRef.current = sessionWorkspaceOrderV1;
    const sessionFoldersV1Ref = React.useRef(sessionFoldersV1);
    sessionFoldersV1Ref.current = sessionFoldersV1;
    const folderSortModeRef = React.useRef(folderSortMode);
    folderSortModeRef.current = folderSortMode;
    const sessionListOrderingModeV1Ref = React.useRef(sessionListOrderingModeV1);
    sessionListOrderingModeV1Ref.current = sessionListOrderingModeV1;
    const sessionListSectionModeV1Ref = React.useRef(sessionListSectionModeV1);
    sessionListSectionModeV1Ref.current = sessionListSectionModeV1;
    const setSessionListGroupOrderV1Ref = React.useRef(setSessionListGroupOrderV1);
    setSessionListGroupOrderV1Ref.current = setSessionListGroupOrderV1;
    const setSessionWorkspaceOrderV1Ref = React.useRef(setSessionWorkspaceOrderV1);
    setSessionWorkspaceOrderV1Ref.current = setSessionWorkspaceOrderV1;
    const setSessionFoldersV1Ref = React.useRef(setSessionFoldersV1);
    setSessionFoldersV1Ref.current = setSessionFoldersV1;
    const folderActionsEnabledRef = React.useRef(folderActionsEnabled);
    folderActionsEnabledRef.current = folderActionsEnabled;

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

    // ----- Row content-geometry registration (into Lane A's registry) --------

    // Rows know only their stable tree row id. The topology (depth/parent/
    // container) lives in the frozen snapshot, so we keep the latest measured
    // ref per row and, while a drag is active, register a content-coordinate
    // `TreeContentRow` enriched with the FROZEN topology. Because the drag
    // surface is frozen, the topology for a given row id is stable for the
    // whole drag, and content bounds are never rebased on scroll.
    const measuredRowRefsRef = React.useRef(new Map<string, TreeDropMeasurableRef>());

    /**
     * Measures `ref` and, if a drag is active, registers the row's content
     * geometry into Lane A's live registry using the frozen topology. When no
     * drag is active nothing is registered — the resolver only runs during a
     * drag, and `remeasureAllRegisteredRows` repopulates the registry from the
     * stored refs at drag start. This keeps the idle layout path free of any
     * tree build.
     */
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
            // Resolve against the snapshot still active when measurement landed.
            if (activeDragSnapshotRef.current !== snapshot) return;
            const row: TreeContentRow = {
                id: topologyRow.rowId,
                parentId: topologyRow.parentRowId,
                containerId: topologyRow.containerId,
                depth: topologyRow.depth,
                kind: topologyRow.kind === 'leaf' ? 'leaf' : 'container',
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

    // Re-measure every registered row's content geometry. Called at drag start
    // so the frozen-surface registry has fresh, scroll-stable bounds.
    const remeasureAllRegisteredRows = React.useCallback(() => {
        for (const [rowId, ref] of measuredRowRefsRef.current) {
            registerRowContentGeometry(rowId, ref);
        }
    }, [registerRowContentGeometry]);

    const handleTreeScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const nextOffsetY = event.nativeEvent.contentOffset?.y;
        if (typeof nextOffsetY !== 'number' || !Number.isFinite(nextOffsetY)) return;
        // Content bounds are NEVER rebased on scroll — content coordinates are
        // stable for the frozen surface. Only the live scroll offset is tracked.
        scrollOffsetYRef.current = nextOffsetY;
        autoscrollScrollOffsetY.value = nextOffsetY;
    }, [autoscrollScrollOffsetY]);

    const handleTreeContentSizeChange = React.useCallback((_width: number, height: number) => {
        if (typeof height !== 'number' || !Number.isFinite(height)) return;
        autoscrollContentHeight.value = Math.max(0, height);
    }, [autoscrollContentHeight]);

    const handleTreeListLayout = React.useCallback((event: Readonly<{
        nativeEvent?: { layout?: { y?: number; height?: number } };
    }>) => {
        const layout = event.nativeEvent?.layout;
        const height = layout?.height;
        if (typeof height === 'number' && Number.isFinite(height)) {
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

    // ----- Folder assignment persistence ------------------------------------

    const persistSessionFolderAssignmentByIds = React.useCallback(async (assignment: Readonly<{
        serverId: string;
        sessionId: string;
        folderId: string | null;
    }>) => {
        if (!folderActionsEnabledRef.current) return;
        const resolved = await resolveSessionOrganizationMutationScope(assignment.serverId);
        if (!resolved.ok) throw new Error(`Missing ${FOLDER_ASSIGNMENT_SCOPE_REQUIREMENT_BY_REASON[resolved.reason]} for session folder assignment`);
        await setSessionFolderAssignment({
            credentials: resolved.scope.credentials,
            serverId: resolved.scope.serverId,
            serverUrl: resolved.scope.serverUrl,
            sessionId: assignment.sessionId,
            folderId: assignment.folderId,
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

    // ----- Pointer drag: resolve against the frozen snapshot ----------------

    const resolveDropResult = React.useCallback((
        event: UseSessionInlineDragResolveDropResultEvent,
    ): UseSessionInlineDragResolvedDrop => {
        const snapshot = activeDragSnapshotRef.current;
        autoscrollPointerY.value = event.pointer?.y ?? null;
        if (!snapshot) return IDLE_RESOLVED_DROP;
        try {
            const resolved = resolveSessionListDragPointer({
                snapshot,
                registry: dropGeometryRegistry,
                pointer: event.pointer,
                viewport: readViewportMetrics(),
            });
            if (shouldBlockResolvedDropForOrderingMode({
                snapshot,
                result: resolved.result,
                sessionListOrderingModeV1: sessionListOrderingModeV1Ref.current,
                sessionListSectionModeV1: sessionListSectionModeV1Ref.current,
            })) {
                return DATE_ORDERING_BLOCKED_RESOLVED_DROP;
            }
            return { result: resolved.result, geometry: resolved.geometry };
        } catch {
            return IDLE_RESOLVED_DROP;
        }
    }, [autoscrollPointerY, dropGeometryRegistry, readViewportMetrics]);

    // ----- Pointer drag: commit the stable intent onto latest live state ----

    const pendingDragIntentRef = React.useRef<ReturnType<typeof buildSessionListDragIntent> | null>(null);
    const [, runPendingDragCommit] = useHappyAction(async () => {
        const intent = pendingDragIntentRef.current;
        pendingDragIntentRef.current = null;
        if (!intent) return;
        await commitSessionListDragIntent({
            intent,
            context: {
                latestItems: sessionListIndexRef.current,
                sessionFoldersV1: sessionFoldersV1Ref.current,
                sessionListGroupOrderV1: groupOrderRef.current,
                sessionWorkspaceOrderV1: workspaceOrderRef.current,
                now: () => Date.now(),
                folderSortMode: folderSortModeRef.current,
                sessionListOrderingModeV1: sessionListOrderingModeV1Ref.current,
                sessionListSectionModeV1: sessionListSectionModeV1Ref.current,
                setSessionFoldersV1: setSessionFoldersV1Ref.current,
                setSessionListGroupOrderV1: setSessionListGroupOrderV1Ref.current,
                setSessionWorkspaceOrderV1: setSessionWorkspaceOrderV1Ref.current,
                setSessionFolderAssignment: persistSessionFolderAssignmentByIds,
            },
        });
    }, { mode: 'drop' });

    const commitDragResult = React.useCallback((event: UseSessionInlineDragDropResultEvent) => {
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
    }, [clearDragState, runPendingDragCommit]);

    // ----- Discrete moves: move sheet + keyboard (geometry-free tree) --------

    const pendingTreeDropRef = React.useRef<Readonly<{
        tree: ReturnType<typeof buildSessionListTreeRows>;
        source: ReturnType<typeof buildSessionListDragSource>;
        result: SessionListTreeDropResult;
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
                now: () => Date.now(),
                folderSortMode: folderSortModeRef.current,
                sessionListOrderingModeV1: sessionListOrderingModeV1Ref.current,
                sessionListSectionModeV1: sessionListSectionModeV1Ref.current,
                setSessionFoldersV1: setSessionFoldersV1Ref.current,
                setSessionListGroupOrderV1: setSessionListGroupOrderV1Ref.current,
                setSessionWorkspaceOrderV1: setSessionWorkspaceOrderV1Ref.current,
                setSessionFolderAssignment: persistSessionFolderAssignmentByIds,
            },
        });
    }, { mode: 'drop' });

    // Move sheet / keyboard moves are discrete actions: they build a fresh
    // geometry-free latest tree from metadata/order state and never touch the
    // frozen pointer-drag snapshot.
    const buildLatestGeometryFreeTree = React.useCallback(() => buildSessionListTreeRows({
        items: sessionListIndexRef.current,
    }), [sessionListIndexRef]);

    const resolveMoveSheetTargets = React.useCallback((sourceRowId: string): readonly SessionListMoveSheetTarget[] => {
        if (!folderActionsEnabled) return [];
        try {
            const tree = buildLatestGeometryFreeTree();
            const source = buildSessionListDragSource({ tree, sourceRowId });
            return buildSessionListMoveSheetTargets({ tree, source });
        } catch {
            return [];
        }
    }, [buildLatestGeometryFreeTree, folderActionsEnabled]);

    const applyMoveSheetTarget = React.useCallback((sourceRowId: string, target: SessionListMoveSheetTarget) => {
        if (target.disabled) return;
        try {
            const tree = buildLatestGeometryFreeTree();
            const source = buildSessionListDragSource({ tree, sourceRowId });
            pendingTreeDropRef.current = { tree, source, result: target.result };
            runPendingTreeDrop();
        } finally {
            clearDragState();
        }
    }, [buildLatestGeometryFreeTree, clearDragState, runPendingTreeDrop]);

    const applyKeyboardMove = React.useCallback((
        sourceRowId: string,
        direction: SessionListKeyboardMoveDirection,
    ): SessionListTreeDropResult | null => {
        if (!folderActionsEnabled) return null;
        try {
            const tree = buildLatestGeometryFreeTree();
            const source = buildSessionListDragSource({ tree, sourceRowId });
            const result = buildSessionListKeyboardMoveResult({ tree, source, direction, folderSortMode });
            pendingTreeDropRef.current = { tree, source, result };
            runPendingTreeDrop();
            return result;
        } catch {
            return null;
        } finally {
            clearDragState();
        }
    }, [buildLatestGeometryFreeTree, clearDragState, folderActionsEnabled, folderSortMode, runPendingTreeDrop]);

    // ----- Drag lifecycle callbacks -----------------------------------------

    const handleTreeDropResult = React.useCallback((event: UseSessionInlineDragDropResultEvent) => {
        commitDragResult(event);
    }, [commitDragResult]);

    const handleFolderHeaderTreeDropResult = React.useCallback((event: UseSessionInlineDragDropResultEvent) => {
        commitDragResult(event);
    }, [commitDragResult]);

    const handleDragCancel = React.useCallback((_event: UseSessionInlineDragCancelEvent) => {
        clearDragState();
    }, [clearDragState]);

    const handleDragStart = React.useCallback((sessionKey: string) => {
        setNativeContextMenuSessionKey(null);
        // Freeze the visible surface: build the snapshot once at drag start from
        // the latest index + visible items. Tree topology only, no pixel
        // geometry — geometry stays live in the registry.
        const snapshot = buildSessionListDragSnapshot({
            items: sessionListIndexRef.current,
            viewItems: listItemsRef.current,
            sessionDragKey: sessionKey,
            folderSortMode: folderSortMode ?? 'mixed',
            foldersFeatureEnabled: folderActionsEnabled,
        });
        activeDragSnapshotRef.current = snapshot;
        setActiveDragSnapshot(snapshot);
        setDraggingSessionKey(sessionKey);
        // Re-measure every mounted row so the registry has fresh, scroll-stable
        // content bounds for the frozen surface.
        remeasureAllRegisteredRows();
        autoscrollActive.value = true;
        autoscrollPointerY.value = null;
    }, [autoscrollActive, autoscrollPointerY, folderActionsEnabled, folderSortMode, listItemsRef, remeasureAllRegisteredRows, sessionListIndexRef]);

    return {
        activeDragSnapshot,
        applyKeyboardMove,
        applyMoveSheetTarget,
        draggingSessionKey,
        dropOverlayShared,
        handleDragStart,
        handleDragCancel,
        handleFolderHeaderTreeDropResult,
        handleTreeContentSizeChange,
        handleTreeDropResult,
        handleTreeListLayout,
        handleTreeScroll,
        handleTreeViewportMeasure,
        nativeContextMenuSessionKey,
        registerTreeRowBounds,
        resolveDropResult,
        resolveMoveSheetTargets,
        scheduleSessionFolderAssignment,
        setNativeContextMenuSessionKey,
        unregisterTreeRowBounds,
    };
}
