import React from 'react';
import { Platform } from 'react-native';

import { storage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    deleteSessionDraft,
    getExistingSessionDraftProjection,
    subscribeSessionDraft,
    type ExistingSessionDraftProjection,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import {
    createSessionListRowStoreStateSelector,
    selectSessionListRowStateSnapshot,
} from '@/sync/store/sessionListRowStateSnapshot';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { TreeDropOverlaySharedValues } from '@/components/ui/treeDragDrop';
import type {
    RegisterSessionListTreeRowBounds,
    UnregisterSessionListTreeRowBounds,
} from '../SessionListHeaderFrame';
import type {
    UseSessionInlineDragCancelEvent,
    UseSessionInlineDragDropResultEvent,
    UseSessionInlineDragResolveDropResultEvent,
    UseSessionInlineDragResolvedDrop,
} from '../useSessionInlineDrag';
import {
    useSessionListRelativeTimeNowMs,
    useSessionListRuntimeNowMs,
    useSessionListRuntimeWake,
} from '@/hooks/session/sessionListRuntimeClock';
import {
    buildCachedSessionListRowModel,
    createSessionListRowModelsCache,
    resolveSessionListRowModelAdjacency,
} from './buildSessionListRowModels';
import { SessionListRow } from './SessionListRow';
import type {
    SessionListRowPresentationSettings,
    SessionListRowSessionItem,
    SessionListRowStoreState,
} from './sessionListRowModelTypes';
import type { SessionListRowStoreSubscriptionMode } from './sessionListVisibleRowStoreScopes';
import type { SessionItemProps } from '../SessionItem';

const EMPTY_SESSION_LIST_ROW_STORE_STATE: SessionListRowStoreState = Object.freeze({});
const EMPTY_FOLDER_MOVE_MENU_ITEMS: readonly DropdownMenuItem[] = Object.freeze([]);

type SessionListRowMoveActionHandlers = Readonly<{
    onMoveDown?: () => void;
    onMoveToFolder?: () => void;
    onMoveToWorkspaceRoot?: () => void;
    onMoveUp?: () => void;
    onSelectFolderMoveMenuItem?: (itemId: string) => void;
}>;

export type SessionListRowModelBoundaryProps = Readonly<{
    activeServerId?: string | null;
    dataActive: boolean;
    dataIndex: number;
    dragEnabled: boolean;
    draggingSessionKey: string | null;
    folderMoveMenuItems?: readonly DropdownMenuItem[];
    folderViewEnabled: boolean;
    forkActionContext?: SessionItemProps['forkActionContext'];
    getRowMoveActionHandlers: (input: Readonly<{
        item: SessionListRowSessionItem;
        sourceLabel: string;
        sourceRowId: string;
    }>) => SessionListRowMoveActionHandlers;
    getRowNativeContextMenuOpenChangeHandler: (sessionKey: string) => (next: boolean) => void;
    getRowSetTagsHandler: (sessionKey: string) => (newTags: string[]) => void;
    getRowTogglePinnedHandler: (sessionKey: string) => () => void;
    groupKey: string;
    item: SessionListRowSessionItem;
    items: ReadonlyArray<SessionListViewItem>;
    nativeContextMenuSessionKey: string | null;
    onDragCancel: (event: UseSessionInlineDragCancelEvent) => void;
    onDragStart: (sessionKey: string) => void;
    onDropResult: (event: UseSessionInlineDragDropResultEvent) => void;
    onRegisterTreeRowBounds: RegisterSessionListTreeRowBounds;
    onUnregisterTreeRowBounds: UnregisterSessionListTreeRowBounds;
    overlayShared: TreeDropOverlaySharedValues;
    prioritySessionRowKeys: ReadonlySet<string>;
    resolveDropResult: (event: UseSessionInlineDragResolveDropResultEvent) => UseSessionInlineDragResolvedDrop;
    rowStoreSubscriptionEnabled: boolean;
    rowStoreSubscriptionMode: SessionListRowStoreSubscriptionMode;
    settings: SessionListRowPresentationSettings;
    viewableSessionRowKeys: ReadonlySet<string> | null;
}>;

function subscribeToNoRowStoreUpdates(): () => void {
    return () => undefined;
}

function readEmptyRowStoreState(): SessionListRowStoreState {
    return EMPTY_SESSION_LIST_ROW_STORE_STATE;
}

function readNoExistingSessionDraft(): ExistingSessionDraftProjection | null {
    return null;
}

function useExistingSessionDraftProjection(input: Readonly<{
    enabled: boolean;
    scope: ServerAccountScope | null;
    sessionId: string;
}>): ExistingSessionDraftProjection | null {
    const { enabled, scope, sessionId } = input;
    const address = React.useMemo(() => ({ kind: 'session' as const, sessionId }), [sessionId]);
    const subscribe = React.useMemo(() => {
        if (!enabled || !scope) return subscribeToNoRowStoreUpdates;
        return (listener: () => void) => subscribeSessionDraft(scope, address, listener);
    }, [address, enabled, scope]);
    const getSnapshot = React.useMemo(() => {
        if (!enabled || !scope) return readNoExistingSessionDraft;
        return () => getExistingSessionDraftProjection(scope, sessionId);
    }, [enabled, scope, sessionId]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * One unsubscribed read of this row's store state.
 *
 * A row normally inherits its frozen snapshot from the last render where the surface was active.
 * A row that has never been active has nothing to inherit, so it needs the current value once —
 * without subscribing, which is the whole point of the freeze.
 */
function readSessionListRowStoreStateOnce(input: Readonly<{
    activeServerId?: string | null;
    serverId?: string | null;
    sessionId: string;
}>): SessionListRowStoreState {
    const selector = createSessionListRowStoreStateSelector(
        [{ sessionId: input.sessionId, serverId: input.serverId ?? null }],
        input.activeServerId,
    );
    return selector(storage.getState());
}

// The subscription set changes constantly (every viewability change while
// scrolling, and every row at once when the surface goes data-inactive behind a
// modal). Selecting between a subscribed and an unsubscribed COMPONENT would
// change the element type at this position, so React would unmount and remount
// the whole row subtree — hundreds of views per screenful — on each of those
// transitions. The subscription is therefore switched inside one component:
// when it is disabled the store is never subscribed (no listener at all) and the
// snapshot is a frozen constant, so the row keeps its mounted subtree.
function useSessionListRowStoreState(input: Readonly<{
    activeServerId?: string | null;
    enabled: boolean;
    serverId?: string | null;
    sessionId: string;
}>): SessionListRowStoreState {
    const { activeServerId, enabled, serverId, sessionId } = input;
    const readRowStoreState = React.useMemo(() => {
        if (!enabled) return readEmptyRowStoreState;
        const selector = createSessionListRowStoreStateSelector(
            [{ sessionId, serverId: serverId ?? null }],
            activeServerId,
        );
        return () => selector(storage.getState());
    }, [activeServerId, enabled, serverId, sessionId]);

    return React.useSyncExternalStore(
        enabled ? storage.subscribe : subscribeToNoRowStoreUpdates,
        readRowStoreState,
        readRowStoreState,
    );
}

export const SessionListRowModelBoundary = React.memo(function SessionListRowModelBoundary(
    props: SessionListRowModelBoundaryProps,
) {
    const activeScope = useActiveServerAccountScope();
    const draftScope = React.useMemo(() => activeScope
        ? createServerAccountScope(props.item.serverId ?? activeScope.serverId, activeScope.accountId)
        : null, [activeScope, props.item.serverId]);
    const liveRowStoreState = useSessionListRowStoreState({
        activeServerId: props.activeServerId,
        enabled: props.rowStoreSubscriptionEnabled,
        serverId: props.item.serverId,
        sessionId: props.item.session.id,
    });
    const liveDraftProjection = useExistingSessionDraftProjection({
        enabled: props.rowStoreSubscriptionEnabled,
        scope: draftScope,
        sessionId: props.item.session.id,
    });
    // `null` means "this row has never held a live snapshot", which is different from "its live
    // snapshot is empty" and must not be collapsed into the same value.
    //
    // Opening a session deactivates the list while it keeps rendering behind the pushed screen, and
    // the engine can mount containers during that window — so a row's FIRST render can happen while
    // the surface is inactive. Such a row has nothing frozen to fall back to, and an inactive row
    // never reads the store, so it would present an empty snapshot for as long as the surface stays
    // away. MEASURED as the reported symptom: half-swipe back immediately after opening a session
    // and the list is blank; wait first and it is populated but scrolled to the top.
    const frozenRowStoreStateRef = React.useRef<SessionListRowStoreState | null>(null);
    const frozenDraftProjectionRef = React.useRef<ExistingSessionDraftProjection | null>(null);
    if (props.dataActive) {
        frozenRowStoreStateRef.current = liveRowStoreState;
        frozenDraftProjectionRef.current = liveDraftProjection;
    } else if (frozenRowStoreStateRef.current === null) {
        frozenRowStoreStateRef.current = readSessionListRowStoreStateOnce({
            activeServerId: props.activeServerId,
            serverId: props.item.serverId,
            sessionId: props.item.session.id,
        });
        frozenDraftProjectionRef.current = draftScope
            ? getExistingSessionDraftProjection(draftScope, props.item.session.id)
            : null;
    }
    const rowStoreState = props.dataActive
        ? liveRowStoreState
        : frozenRowStoreStateRef.current ?? EMPTY_SESSION_LIST_ROW_STORE_STATE;
    const draftProjection = props.dataActive
        ? liveDraftProjection
        : frozenDraftProjectionRef.current;

    return (
        <SessionListRowModelBoundaryContent
            {...props}
            draftProjection={draftProjection}
            draftScope={draftScope}
            rowStoreState={rowStoreState}
        />
    );
});

type SessionListRowModelBoundaryContentProps = SessionListRowModelBoundaryProps & Readonly<{
    draftProjection: ExistingSessionDraftProjection | null;
    draftScope: ServerAccountScope | null;
    rowStoreState: SessionListRowStoreState;
}>;

const SessionListRowModelBoundaryContent = React.memo(function SessionListRowModelBoundaryContent(
    props: SessionListRowModelBoundaryContentProps,
) {
    const relativeNowMs = useSessionListRelativeTimeNowMs(props.dataActive);
    // The row reads the SAME shared runtime clock as group placement
    // (useVisibleSessionListRuntimeNowMs), so the working indicator and the
    // session's group can never cross a freshness boundary in different
    // render cycles. The row only contributes its own wake horizon (below,
    // straight from the freshly built row model), which can be earlier than
    // the list's when its renderable is fresher than the committed view data.
    const runtimeNowMs = useSessionListRuntimeNowMs(props.dataActive);
    const settings = React.useMemo<SessionListRowPresentationSettings>(() => ({
        ...props.settings,
        relativeNowMs,
        runtimeNowMs,
    }), [props.settings, relativeNowMs, runtimeNowMs]);
    const rowModelsCacheRef = React.useRef(createSessionListRowModelsCache());
    const storeSnapshot = selectSessionListRowStateSnapshot(props.rowStoreState, {
        sessionId: props.item.session.id,
        serverId: props.item.serverId,
    });
    const snapshot = React.useMemo(() => ({
        ...storeSnapshot,
        draft: props.draftProjection
            ? { preview: props.draftProjection.preview }
            : null,
    }), [props.draftProjection, storeSnapshot]);
    const adjacency = React.useMemo(
        () => resolveSessionListRowModelAdjacency(props.items, props.dataIndex),
        [props.dataIndex, props.items],
    );
    const rowModel = React.useMemo(() => buildCachedSessionListRowModel({
        item: props.item,
        snapshot,
        dataIndex: props.dataIndex,
        adjacency,
        settings,
        cache: rowModelsCacheRef.current,
    }), [adjacency, props.dataIndex, props.item, settings, snapshot]);

    useSessionListRuntimeWake(rowModel.nextRuntimeFreshnessAtMs, props.dataActive);

    const sessionKey = rowModel.rowKey || null;
    const rowAttentionAnimationEnabled = props.rowStoreSubscriptionMode === 'all-rendered'
        || props.viewableSessionRowKeys === null
        || sessionKey === null
        || props.viewableSessionRowKeys.has(sessionKey)
        || props.prioritySessionRowKeys.has(sessionKey);
    const supportsPin = Boolean(sessionKey);
    const onTogglePinned = supportsPin && sessionKey
        ? props.getRowTogglePinnedHandler(sessionKey)
        : null;
    const onSetTags = sessionKey
        ? props.getRowSetTagsHandler(sessionKey)
        : null;
    const isIos = Platform.OS === 'ios';
    const nativeContextMenuOpen = isIos && sessionKey != null && props.nativeContextMenuSessionKey === sessionKey;
    const handleNativeContextMenuOpenChange = isIos && sessionKey
        ? props.getRowNativeContextMenuOpenChangeHandler(sessionKey)
        : null;
    const moveActionHandlers = props.getRowMoveActionHandlers({
        sourceRowId: rowModel.treeRowId,
        sourceLabel: props.item.session.id,
        item: props.item,
    });
    const onDeleteDraft = React.useMemo(() => {
        const scope = props.draftScope;
        if (!scope || !props.draftProjection) return null;
        return () => deleteSessionDraft({
            scope,
            address: { kind: 'session', sessionId: props.item.session.id },
        });
    }, [props.draftProjection, props.draftScope, props.item.session.id]);

    return (
        <SessionListRow
            sessionKey={sessionKey}
            treeRowId={rowModel.treeRowId}
            groupKey={props.groupKey}
            onDragStart={props.onDragStart}
            onDropResult={props.onDropResult}
            onDragCancel={props.onDragCancel}
            resolveDropResult={props.resolveDropResult}
            onRegisterTreeRowBounds={props.onRegisterTreeRowBounds}
            onUnregisterTreeRowBounds={props.onUnregisterTreeRowBounds}
            isDragActive={props.draggingSessionKey != null}
            isBeingDragged={sessionKey != null && sessionKey === props.draggingSessionKey}
            dragEnabled={props.dragEnabled}
            dataIndex={props.dataIndex}
            overlayShared={props.overlayShared}
            rowModel={rowModel}
            session={rowModel.session}
            subtitleOverride={rowModel.subtitle ?? null}
            subtitleEllipsizeMode={rowModel.subtitleEllipsizeMode}
            serverId={rowModel.serverId ?? undefined}
            serverName={rowModel.serverName}
            currentUserId={rowModel.currentUserId}
            showServerBadge={rowModel.showServerBadge}
            pinned={rowModel.isPinned}
            onTogglePinned={onTogglePinned}
            onDeleteDraft={onDeleteDraft}
            tags={rowModel.tags}
            allKnownTags={rowModel.allKnownTags}
            onSetTags={onSetTags}
            tagsEnabled={rowModel.tagsEnabled}
            selected={rowModel.isSelected}
            isFirst={rowModel.adjacency.isFirst}
            isLast={rowModel.adjacency.isLast}
            isSingle={rowModel.adjacency.isSingle}
            variant={rowModel.variant ?? undefined}
            activityTimeMode={rowModel.activity.mode === 'updatedAt' ? 'updatedAt' : undefined}
            folderDepth={rowModel.folder.depth}
            folderMoveMenuItems={props.folderViewEnabled ? props.folderMoveMenuItems ?? EMPTY_FOLDER_MOVE_MENU_ITEMS : EMPTY_FOLDER_MOVE_MENU_ITEMS}
            forkActionContext={props.forkActionContext}
            onMoveToFolder={props.folderViewEnabled ? moveActionHandlers.onMoveToFolder : undefined}
            onMoveToWorkspaceRoot={props.folderViewEnabled ? moveActionHandlers.onMoveToWorkspaceRoot : undefined}
            onMoveUp={props.folderViewEnabled ? moveActionHandlers.onMoveUp : undefined}
            onMoveDown={props.folderViewEnabled ? moveActionHandlers.onMoveDown : undefined}
            onSelectFolderMoveMenuItem={moveActionHandlers.onSelectFolderMoveMenuItem}
            secondaryLineMode={rowModel.secondaryLineMode}
            compact={rowModel.compact}
            compactMinimal={rowModel.compactMinimal}
            rowAttentionAnimationEnabled={rowAttentionAnimationEnabled}
            {...(isIos && sessionKey != null && props.dragEnabled
                ? {
                    nativeInlineDragEnabled: true,
                }
                : null)}
            {...(isIos && sessionKey != null
                ? {
                    nativeContextMenuOpen,
                    onNativeContextMenuOpenChange: handleNativeContextMenuOpenChange ?? undefined,
                }
                : null)}
        />
    );
});
