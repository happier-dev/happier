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
import { getStorage } from '@/sync/domains/state/storage';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionFoldersV1 } from '@/sync/domains/session/folders';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { resolveSessionListSessionRowDragPolicy } from '@/sync/domains/session/listing/sessionListLayout';
import type {
    SessionListOrderingModeV1,
    SessionListOrderingSectionMode,
} from '@/sync/domains/session/listing/sessionListOrderingRules';
import {
    type SessionOrganizationMutationScope,
    writeSessionOrganizationFolderAssignment,
} from '@/sync/ops/sessionOrganization';

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
    setSessionListGroupOrderV1: (value: Record<string, string[]>, scope: SessionOrganizationMutationScope) => Promise<void>;
    setSessionWorkspaceOrderV1: (value: Record<string, string[]>, scope: SessionOrganizationMutationScope) => Promise<void>;
    setSessionFoldersV1: (value: SessionFoldersV1, scope: SessionOrganizationMutationScope) => Promise<void>;
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
        const current = entityDragRuntime.getSnapshot();
        const scope = current.item?.scope;
        if (scope && current.sourceId === `session-list-source:${scope.serverId}:${scope.accountId}:${rowId}`) {
            entityDragRuntime.cancel('source-row-retired');
        }
        dropGeometryRegistry.unregisterRow(rowId);
    }, [dropGeometryRegistry, entityDragRuntime]);

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

    const buildBaseCommitContext = React.useCallback((scope?: SessionOrganizationMutationScope): SessionListBaseCommitContext => {
        const requireCapturedScope = () => {
            if (!scope) throw new Error('Organization writes require the captured mutation scope');
            return scope;
        };
        return {
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
            setSessionFoldersV1: async next => {
                await setSessionFoldersV1Ref.current(next, requireCapturedScope());
            },
            setSessionListGroupOrderV1: async next => {
                await setSessionListGroupOrderV1Ref.current(next, requireCapturedScope());
            },
            setSessionWorkspaceOrderV1: async next => {
                await setSessionWorkspaceOrderV1Ref.current(next, requireCapturedScope());
            },
            setSessionFolderAssignment: async assignment => {
                await writeSessionOrganizationFolderAssignment({ scope: requireCapturedScope(), sessionId: assignment.sessionId, folderId: assignment.folderId });
            },
            putSessionUnder: putSessionUnderLead,
        };
    }, []);

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
        getSourceBounds: rowId => {
            const row = dropGeometryRegistry.getContentGeometry().rows.find(candidate => candidate.id === rowId);
            if (!row) return null;
            const viewport = readViewportMetrics();
            return { x: row.bounds.x + viewport.viewportWindowX,
                y: row.bounds.y + viewport.viewportWindowY - viewport.scrollOffsetY,
                width: row.bounds.width, height: row.bounds.height };
        },
    });

    const stagedMove = useSessionListStagedMove({
        getItems: () => listItemsRef.current,
        foldersFeatureEnabled: input.folderActionsEnabled,
        beginCarry: entityDragDrop.beginCarry,
        runtime: entityDragRuntime,
    });

    /**
     * Each pointer frame moves the one carry; the owner resolves the place under it and only an
     * admitted place draws its line or outline. The list itself never re-renders for a frame.
     */
    const resolveDropResult = React.useCallback((event: UseSessionInlineDragResolveDropResultEvent): UseSessionInlineDragResolvedDrop => {
        const carry = carryRef.current;
        if (!carry) return IDLE_RESOLVED_DROP;
        return { result: IDLE_RESOLVED_DROP.result, geometry: carry.move(event.pointer) };
    }, []);

    const commitTreeDropResult = React.useCallback(async (_event: UseSessionInlineDragDropResultEvent): Promise<void> => {
        suppressNextFolderFocusPressAfterDrag();
        const carry = carryRef.current;
        const snapshot = activeDragSnapshotRef.current;
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
        carryRef.current?.cancel();
        activeDragSnapshotRef.current = snapshot;
        carryRef.current = entityDragDrop.beginCarry(snapshot, 'pointer');
        if (!carryRef.current) { clearDragState(); return; }
        setActiveDragSnapshot(snapshot);
        setNativeContextMenuSessionKey(null);
        setDraggingSessionKey(sessionKey);
        remeasureAllRegisteredRows();
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

    const prepareTreeRowSource = React.useCallback((sourceRowId: string) => (
        entityDragDrop.prepareSource({ sourceRowId })
    ), [entityDragDrop.prepareSource]);

    const performTreeResult = React.useCallback(async (sourceRowId: string, result: ReturnType<typeof buildSessionListKeyboardMoveResult>) => {
        const source = prepareTreeRowSource(sourceRowId);
        const scope = entityDragDrop.scope;
        const targetId = entityDragDrop.targetId;
        if (!source || !scope || !targetId) { source?.dispose(); return false; }
        try {
            const metadata = latestTreeRef.current.rowMetadataById.get(sourceRowId);
            if (!metadata) return false;
            const intent = buildSessionListDragIntent({ result, sourceRowId,
                sourceKind: metadata.kind === 'session' ? 'leaf' : 'container', snapshotSignature: '', scope });
            const { scope: _scope, sourceSnapshotSignature: _signature, ...destination } = intent;
            const outcome = await entityDragRuntime.perform(source.sourceId, targetId, destination, 'chooser');
            return outcome?.status === 'applied';
        } finally { source.dispose(); }
    }, [entityDragDrop.scope, entityDragDrop.targetId, entityDragRuntime, prepareTreeRowSource]);

    const applyKeyboardMove = React.useCallback((sourceRowId: string, direction: SessionListKeyboardMoveDirection) => {
        try {
            const tree = latestTreeRef.current;
            const source = buildSessionListDragSource({ tree, sourceRowId });
            const result = buildSessionListKeyboardMoveResult({ tree, source, direction });
            return { result, committed: performTreeResult(sourceRowId, result) };
        } catch { return null; }
    }, [performTreeResult]);

    const moveToFolder = React.useCallback((serverId: string, sessionId: string, folderId: string | null) => {
        const sourceRowId = treeRowId.session(serverId, sessionId);
        const source = latestTreeRef.current.rowMetadataById.get(sourceRowId);
        if (!source) return Promise.resolve(false);
        const target = folderId ? treeRowId.folder(serverId, folderId) : source.rootId;
        return performTreeResult(sourceRowId, { instruction: folderId
            ? { kind: 'nest-into', targetId: target, containerId: target, parentId: target, depth: 1 }
            : { kind: 'move-to-root', containerId: target, rootId: target, depth: 0 }, visual: { kind: 'none' } });
    }, [performTreeResult]);

    React.useEffect(() => {
        const update = () => {
            const snapshot = entityDragRuntime.getSnapshot();
            const active = activeDragSnapshotRef.current;
            const ours = active && snapshot.sourceId === carryRef.current?.sourceId;
            if (active && carryRef.current && (!ours || (snapshot.phase !== 'carrying' && snapshot.phase !== 'pending'))) {
                carryRef.current = null;
                clearDragState();
            }
            const scroll = snapshot.phase === 'carrying' && snapshot.targetId === entityDragDrop.targetId && snapshot.admission?.status === 'allowed';
            autoscrollActive.value = scroll;
            autoscrollPointerY.value = scroll ? entityDragRuntime.getPointer()?.y ?? null : null;
        };
        const semantic = entityDragRuntime.subscribe(update);
        const pointer = entityDragRuntime.subscribePointer(update);
        update();
        return () => { semantic(); pointer(); autoscrollActive.value = false; autoscrollPointerY.value = null; };
    }, [autoscrollActive, autoscrollPointerY, clearDragState, entityDragDrop.targetId, entityDragRuntime]);

    return {
        activeDragSnapshot,
        entityDragDrop,
        stagedMove,
        applyKeyboardMove,
        prepareTreeRowSource,
        moveToFolder,
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
        resolveDropResult,
        resolveTreeDropResult: resolveDropResult,
        setNativeContextMenuSessionKey,
        unregisterTreeRowBounds,
        handleNativeContextMenuOpenChangeSessionKey,
    };
}
