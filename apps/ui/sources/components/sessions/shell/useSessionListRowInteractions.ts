import * as React from 'react';
import { useSessionListAttentionActivity } from './useSessionListAttentionInteraction';
import { Platform } from 'react-native';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { captureSessionListPlacementFlight } from './sessionListLayoutFlight';
import { useSharedValue } from 'react-native-reanimated';

import {
    measureWindowBounds,
    measureTreeContentBounds,
    TREE_DROP_OVERLAY_KIND_NONE,
    useEntityDragDropRuntime,
    useEntityDropDomBinding,
    useTreeDropAutoscroll,
    useTreeDropRegistry,
    resolveTreeDropVisualGeometry,
    type TreeContentRow,
    type TreeDropMeasurableRef,
    type TreeDropOverlayKind,
    type TreeDropOverlaySharedValues,
    type TreeViewportMetrics,
    type WindowBounds,
    type WindowPointer,
} from '@/components/ui/treeDragDrop';
import { putSessionUnderLead } from '@/components/sessions/work/putSessionUnderLead';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionSection } from '@/sync/domains/session/organization/sections';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { resolveSessionListSessionRowDragPolicy } from '@/sync/domains/session/listing/sessionListLayout';
import {
    type SessionOrganizationMutationScope,
} from '@/sync/ops/sessionOrganization';

import { buildSessionListDragIntent } from './drag/sessionListDragIntent';
import { buildSessionListDragSnapshot } from './drag/sessionListDragSnapshot';
import { resolveSessionListDragPointer } from './drag/resolveSessionListDragPointer';
import { resolveImplicitDropZoneBounds } from './drag/resolveImplicitDropZoneBounds';
import { writeSessionListDropOverlayGeometry } from './useSessionInlineDrag';
import type { SessionListDragSnapshot } from './drag/_types';
import { buildSessionListDragSource } from './drop-resolution/buildSessionListDragSource';
import { buildSessionListTreeRows } from './drop-resolution/buildSessionListTreeRows';
import { treeRowId } from './drop-resolution/treeRowId';
import { SESSION_LIST_SUPPORTING_SECTIONS_NODE } from './sessionListVirtualizedNodes';
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
 * Pointer geometry for the `manager` tree (R-03): the middle of another Session on the same Home
 * means "put under". Whether that Session takes reports is the domain resolver's verdict, so a
 * refused lead still resolves here and the release preview says why instead of nothing lighting up.
 */
const IDLE_RESOLVED_DROP: UseSessionInlineDragResolvedDrop = Object.freeze({
    result: Object.freeze({
        instruction: Object.freeze({ kind: 'idle' }),
        visual: Object.freeze({ kind: 'none' }),
    }),
    geometry: Object.freeze({ kind: 'none' }),
});
const EMPTY_LIST_ITEMS: readonly SessionListIndexItem[] = Object.freeze([]);

type SessionFolderAssignableSessionItem = Readonly<{
    type: 'session';
    session: { id?: string | null };
    serverId?: string;
}>;

export type UseSessionListRowInteractionsInput = Readonly<{
    presentationScopeKey?: string;
    folderActionsEnabled: boolean;
    isFolderActionsEnabledForServerId: (serverId: string | null | undefined) => boolean;
    sessionSections: readonly SessionSection[];
    spaceMembershipTargets?: SessionListBaseCommitContext['spaceMembershipTargets'];
    spaceMembershipSourceSpaceId?: SessionListBaseCommitContext['spaceMembershipSourceSpaceId'];
    listItems: ReadonlyArray<SessionListIndexItem> | null;
    currentGroupOrderMap: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    currentWorkspaceOrderMap: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    sessionListLayoutV1: 'projects' | 'recent_activity';
    manualSessionOrderingEnabled: boolean;
    setSessionListGroupOrderV1: (value: Record<string, string[]>, scope: SessionOrganizationMutationScope) => Promise<void>;
    setSessionWorkspaceOrderV1: (value: Record<string, string[]>, scope: SessionOrganizationMutationScope) => Promise<void>;
    pinnedKeySet: ReadonlySet<string>;
    sessionTags: Readonly<Record<string, string[]>>;
    setSessionPinForKey: (sessionKey: string, pinned: boolean) => void;
    setSessionTagsForKey: (sessionKey: string, tags: readonly string[]) => void;
    scrollToOffset?: (offsetY: number) => void;
    scrollToIndex?: (index: number) => void;
}>;

export function useSessionListRowInteractions(input: UseSessionListRowInteractionsInput) {
    const setAttentionGestureHeld = useSessionListAttentionActivity();
    const reducedMotion = useReducedMotionPreference();
    const [draggingSessionKey, setDraggingSessionKey] = React.useState<string | null>(null);
    const [activeDragSnapshot, setActiveDragSnapshot] = React.useState<SessionListDragSnapshot | null>(null);
    const [nativeContextMenuSessionKey, setNativeContextMenuSessionKey] = React.useState<string | null>(null);
    const nativeListScrollInteractionActiveRef = React.useRef(false);

    const activeDragSnapshotRef = React.useRef<SessionListDragSnapshot | null>(null);
    const keyboardScrollTargetRef = React.useRef<string | null>(null);
    // Mounted geometry changes (virtualized rows arriving, scroll, resize) re-select the place under a carry.
    const entityDragRuntime = useEntityDragDropRuntime();
    const attachTreeDrop = useEntityDropDomBinding(entityDragRuntime);
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
    const sectionsRef = React.useRef(input.sessionSections);
    sectionsRef.current = input.sessionSections;
    const spaceMembershipTargetsRef = React.useRef(input.spaceMembershipTargets);
    spaceMembershipTargetsRef.current = input.spaceMembershipTargets;
    const spaceMembershipSourceSpaceIdRef = React.useRef(input.spaceMembershipSourceSpaceId);
    spaceMembershipSourceSpaceIdRef.current = input.spaceMembershipSourceSpaceId;
    const layoutRef = React.useRef(input.sessionListLayoutV1);
    layoutRef.current = input.sessionListLayoutV1;
    const manualSessionOrderingEnabledRef = React.useRef(input.manualSessionOrderingEnabled);
    manualSessionOrderingEnabledRef.current = input.manualSessionOrderingEnabled;
    const isFolderActionsEnabledForServerIdRef = React.useRef(input.isFolderActionsEnabledForServerId);
    isFolderActionsEnabledForServerIdRef.current = input.isFolderActionsEnabledForServerId;
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
        keyboardScrollTargetRef.current = null;
        setActiveDragSnapshot(null);
        setDraggingSessionKey(null);
        autoscrollActive.value = false;
        autoscrollPointerY.value = null;
        overlayVisible.value = 0;
        overlayKind.value = TREE_DROP_OVERLAY_KIND_NONE;
    }, [autoscrollActive, autoscrollPointerY, overlayKind, overlayVisible]);

    const registerRowContentGeometry = React.useCallback((rowId: string, ref: TreeDropMeasurableRef | null) => {
        if (!ref) return;
        const snapshot = activeDragSnapshotRef.current;
        if (!snapshot) return;
        // This presentation cell owns measured space, but never entity topology or an Action.
        const topologyRow = rowId === SESSION_LIST_SUPPORTING_SECTIONS_NODE.id
            ? { rowId, parentRowId: null, containerId: rowId, depth: 0, kind: 'leaf' as const }
            : snapshot.topology.rows.find((row) => row.rowId === rowId);
        if (!topologyRow) return;
        void measureTreeContentBounds(ref, readViewportMetrics).then((contentBounds) => {
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

    const handleTreeScroll = React.useCallback((event: { nativeEvent?: {
        contentOffset?: { y?: number };
        contentSize?: { height?: number };
    } }) => {
        const nextOffset = Number(event.nativeEvent?.contentOffset?.y ?? 0);
        if (!Number.isFinite(nextOffset)) return;
        scrollOffsetYRef.current = nextOffset;
        autoscrollScrollOffsetY.value = nextOffset;
        // The web virtualizer emits content size with scroll events, not the
        // native-only onContentSizeChange callback.
        const contentHeight = event.nativeEvent?.contentSize?.height;
        if (typeof contentHeight === 'number' && Number.isFinite(contentHeight)) {
            autoscrollContentHeight.value = Math.max(0, contentHeight);
        }
        // Scrolling under a still pointer changes the place beneath it.
        if (activeDragSnapshotRef.current) entityDragRuntime.refresh();
    }, [autoscrollContentHeight, autoscrollScrollOffsetY, entityDragRuntime]);

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
        attachTreeDrop(ref);
        // Publish viewport metrics on the measurement clock as well, before
        // a same-turn row measurement can convert against the previous viewport.
        void measureWindowBounds(ref, (bounds) => {
            viewportBoundsRef.current = bounds;
            viewportWindowYRef.current = bounds.y;
            viewportWindowXRef.current = bounds.x;
            viewportHeightRef.current = bounds.height;
            autoscrollViewportTopY.value = bounds.y;
            autoscrollViewportHeight.value = bounds.height;
        });
    }, [attachTreeDrop, autoscrollViewportHeight, autoscrollViewportTopY]);

    const buildBaseCommitContext = React.useCallback((scope?: SessionOrganizationMutationScope): SessionListBaseCommitContext => {
        const requireCapturedScope = () => {
            if (!scope) throw new Error('Organization writes require the captured mutation scope');
            return scope;
        };
        return {
            latestItems: listItemsRef.current,
            latestTree: latestTreeRef.current,
            sessionSections: sectionsRef.current,
            spaceMembershipTargets: spaceMembershipTargetsRef.current,
            spaceMembershipSourceSpaceId: spaceMembershipSourceSpaceIdRef.current,
            sessionListGroupOrderV1: groupOrderRef.current,
            sessionWorkspaceOrderV1: workspaceOrderRef.current,
            sessionListLayoutV1: layoutRef.current,
            manualSessionOrderingEnabled: manualSessionOrderingEnabledRef.current,
            isFolderOrganizationEnabled: (serverId) => isFolderActionsEnabledForServerIdRef.current(serverId),
            setSessionListGroupOrderV1: async next => {
                await setSessionListGroupOrderV1Ref.current(next, requireCapturedScope());
            },
            setSessionWorkspaceOrderV1: async next => {
                await setSessionWorkspaceOrderV1Ref.current(next, requireCapturedScope());
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
                    layoutV1: layoutRef.current,
                }).canReorderSiblings;
            return resolveSessionListDragPointer({
                snapshot,
                registry: dropGeometryRegistry,
                pointer,
                viewport: readViewportMetrics(),
                canReorderSessionSiblings,
                // Geometry names a same-Home candidate from the list topology. The entity
                // resolver alone admits manager using the canonical relation projection.
                canPutSessionUnder: () => true,
            });
        } catch {
            return IDLE_RESOLVED_DROP;
        }
    }, [dropGeometryRegistry, readViewportMetrics]);

    const entityDragDrop = useSessionListEntityDragDrop({
        presentationScopeKey: JSON.stringify([input.presentationScopeKey ?? null, input.sessionListLayoutV1]),
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
        resolveKeyboardGeometry: visual => {
            const snapshot = activeDragSnapshotRef.current;
            if (!snapshot || visual.kind === 'none') return { kind: 'none' };
            const content = dropGeometryRegistry.getContentGeometry();
            const viewport = readViewportMetrics();
            const row = content.rows.find(row => row.id === visual.targetId);
            if (!row) {
                const target = snapshot.topology.rowMetadataById.get(visual.targetId);
                if (target && keyboardScrollTargetRef.current !== visual.targetId) {
                    keyboardScrollTargetRef.current = visual.targetId;
                    input.scrollToIndex?.(target.itemIndex);
                }
                return { kind: 'none' };
            }
            const top = row.bounds.y - viewport.scrollOffsetY;
            const edge = visual.kind === 'line' && visual.edge === 'bottom' ? top + row.bounds.height : top;
            const destinationVisible = visual.kind === 'line'
                ? edge >= 0 && edge <= viewport.viewportHeight
                : top < viewport.viewportHeight && top + row.bounds.height > 0;
            if (!destinationVisible) {
                const targetY = visual.kind === 'line' && visual.edge === 'bottom'
                    ? row.bounds.y + row.bounds.height : row.bounds.y;
                const offset = Math.max(0, targetY - viewport.viewportHeight / 2);
                const request = `${visual.targetId}:${offset}`;
                if (keyboardScrollTargetRef.current !== request) {
                    keyboardScrollTargetRef.current = request;
                    input.scrollToOffset?.(offset);
                }
                return { kind: 'none' };
            }
            keyboardScrollTargetRef.current = null;
            const implicit = resolveImplicitDropZoneBounds({ topologyDropZones: snapshot.topology.dropZones,
                rows: content.rows, rowMetadataById: snapshot.topology.rowMetadataById });
            return resolveTreeDropVisualGeometry({ visual, rows: content.rows,
                dropZones: [...content.dropZones, ...implicit], viewport });
        },
        onKeyboardGeometry: geometry => writeSessionListDropOverlayGeometry(dropOverlayShared, geometry),
        onCarryDispatched: () => {
            // The committed placement glides (P5 §6): the rows are captured where the frozen drag list shows them.
            if (Platform.OS === 'web' && !reducedMotion) captureSessionListPlacementFlight();
            clearDragState();
        },
        onCarryRetired: clearDragState,
    });

    const stagedMove = useSessionListStagedMove({
        getItems: () => listItemsRef.current,
        foldersFeatureEnabled: input.folderActionsEnabled,
        beginCarry: (snapshot, mode) => {
            const carry = entityDragDrop.beginCarry(snapshot, mode);
            if (!carry) { clearDragState(); return null; }
            activeDragSnapshotRef.current = snapshot;
            setActiveDragSnapshot(snapshot);
            remeasureAllRegisteredRows();
            return carry;
        },
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
        const carry = carryRef.current;
        const snapshot = activeDragSnapshotRef.current;
        try {
            await carry?.end(true, null);
        } finally {
            if (activeDragSnapshotRef.current === snapshot) clearDragState();
        }
    }, [clearDragState]);

    const handleDragStart = React.useCallback((sessionKey: string, sourceRowId?: string) => {
        let snapshot: SessionListDragSnapshot;
        try {
            snapshot = buildSessionListDragSnapshot({
                items: listItemsRef.current,
                viewItems: listItemsRef.current,
                sessionDragKey: sourceRowId ?? sessionKey,
                foldersFeatureEnabled: input.folderActionsEnabled,
            });
        } catch {
            clearDragState();
            return;
        }
        carryRef.current?.cancel();
        carryRef.current = entityDragDrop.beginCarry(snapshot, 'pointer');
        if (!carryRef.current) { clearDragState(); return; }
        activeDragSnapshotRef.current = snapshot;
        setActiveDragSnapshot(snapshot);
        setNativeContextMenuSessionKey(null);
        setDraggingSessionKey(sessionKey);
        remeasureAllRegisteredRows();
        return carryRef.current;
    }, [autoscrollActive, autoscrollPointerY, clearDragState, entityDragDrop, input.folderActionsEnabled, remeasureAllRegisteredRows]);

    const handleDragUpdate = React.useCallback((_event: UseSessionInlineDragDropResultEvent) => {}, []);
    const handleDragCancel = React.useCallback((event?: UseSessionInlineDragCancelEvent) => {
        carryRef.current?.cancel();
        carryRef.current = null;
        clearDragState();
    }, [clearDragState]);

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
        if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
        setAttentionGestureHeld(true);
        nativeListScrollInteractionActiveRef.current = true;
        setNativeContextMenuSessionKey(null);
    }, [setAttentionGestureHeld]);

    const handleNativeListScrollInteractionEnd = React.useCallback(() => {
        if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
        setAttentionGestureHeld(false);
        nativeListScrollInteractionActiveRef.current = false;
    }, [setAttentionGestureHeld]);

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
        const scope = source?.scope;
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
    }, [entityDragDrop.targetId, entityDragRuntime, prepareTreeRowSource]);

    const applyKeyboardMove = React.useCallback((sourceRowId: string, direction: SessionListKeyboardMoveDirection) => {
        try {
            const tree = latestTreeRef.current;
            const source = buildSessionListDragSource({ tree, sourceRowId });
            const result = buildSessionListKeyboardMoveResult({ tree, source, direction });
            return { result, committed: performTreeResult(sourceRowId, result) };
        } catch { return null; }
    }, [performTreeResult]);

    const moveToFolder = React.useCallback((serverId: string, sessionId: string, folderId: string | null) => {
        const row = latestTreeRef.current.rowMetadataById.get(treeRowId.session(serverId, sessionId))
            ?? [...latestTreeRef.current.rowMetadataById.values()].find(candidate => candidate.kind === 'session'
                && candidate.serverId === serverId && candidate.sessionId === sessionId);
        const source = row ? prepareTreeRowSource(row.rowId) : null;
        const targetId = entityDragDrop.targetId;
        if (!source || !targetId) { source?.dispose(); return Promise.resolve(false); }
        return entityDragRuntime.perform(source.sourceId, targetId, { kind: 'folder-assignment', folderId }, 'chooser')
            .then(outcome => outcome?.status === 'applied').finally(() => source.dispose());
    }, [entityDragDrop.targetId, entityDragRuntime, prepareTreeRowSource]);

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
