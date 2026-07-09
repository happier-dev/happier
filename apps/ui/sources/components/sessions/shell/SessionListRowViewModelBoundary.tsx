import * as React from 'react';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import {
    useSessionListRowRenderablesForItems,
} from '@/sync/domains/state/storage';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionFolderMoveTarget } from '@/sync/domains/session/folders';
import type { TreeDropOverlaySharedValues } from '@/components/ui/treeDragDrop';

import { SessionListSessionItem } from './sessionListSessionItem';
import {
    buildSessionListRowViewModel,
    type SessionReachableDisplay,
    type SessionListRowViewModel,
} from './sessionListRowViewModels';
import { useSessionListRelativeNowMs } from './sessionListRowClocks';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from '@/hooks/session/sessionListRuntimeClock';
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

const EMPTY_ROW_RENDERABLES = new Map<string, SessionListRenderableSession>() as ReadonlyMap<string, SessionListRenderableSession>;
export type SessionListRowViewModelBoundaryProps = Readonly<{
    activeColorMode?: 'activityAndAttention' | 'attentionOnly' | 'allActive' | null;
    allKnownTags: string[];
    compact: boolean;
    compactMinimal: boolean;
    currentUserId: string | null;
    dataActive: boolean;
    dataIndex: number;
    dragEnabled: boolean;
    draggingSessionKey: string | null;
    folderMoveTargets: readonly SessionFolderMoveTarget[];
    hasMultipleMachines: boolean;
    hideInactiveSessions?: boolean | null;
    identityDisplay?: 'avatar' | 'agentLogo' | 'none' | null;
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    items: ReadonlyArray<SessionListIndexItem>;
    nativeContextMenuSessionKey: string | null;
    onDragCancel?: (event: UseSessionInlineDragCancelEvent) => void;
    onDragStart: (sessionKey: string) => void;
    onDropResult: (event: UseSessionInlineDragDropResultEvent) => void | Promise<void>;
    onMoveDown?: () => void;
    onMoveToFolder?: () => void;
    onMoveToSessionFolder?: (folderId: string | null) => void | Promise<void>;
    onMoveToWorkspaceRoot?: () => void;
    onMoveUp?: () => void;
    onNativeContextMenuOpenChangeSessionKey: ((sessionKey: string, next: boolean) => void) | null;
    onRegisterTreeRowBounds: RegisterSessionListTreeRowBounds;
    onSetTagsSessionKey: ((sessionKey: string, newTags: string[]) => void) | null;
    onTogglePinnedSessionKey: ((sessionKey: string) => void) | null;
    onUnregisterTreeRowBounds: UnregisterSessionListTreeRowBounds;
    overlayShared: TreeDropOverlaySharedValues;
    pinnedSessionKeys: ReadonlySet<string>;
    reachableSessionDisplayById: ReadonlyMap<string, SessionReachableDisplay>;
    reachableSessionDisplayByKey: ReadonlyMap<string, SessionReachableDisplay>;
    resolveDropResult: (event: UseSessionInlineDragResolveDropResultEvent) => UseSessionInlineDragResolvedDrop;
    rowAttentionAnimationEnabled: boolean;
    rowHeight: number;
    selectedSessionId: string | null;
    sessionTags: Record<string, string[]>;
    showPinnedServerBadge: boolean;
    showServerBadge: boolean;
    tagsEnabled: boolean;
    treeRowId: string;
    workingIndicatorMode?: 'spinner' | 'pulse' | null;
    workingTextMode?: 'animated' | 'static' | null;
}>;

export const SessionListRowViewModelBoundary = React.memo(function SessionListRowViewModelBoundary(
    props: SessionListRowViewModelBoundaryProps,
) {
    const rowItems = React.useMemo(() => [props.item], [props.item]);
    const liveRowRenderableByKey = useSessionListRowRenderablesForItems(props.dataActive ? rowItems : null);
    const frozenRowRenderableByKeyRef = React.useRef<ReadonlyMap<string, SessionListRenderableSession>>(EMPTY_ROW_RENDERABLES);
    if (props.dataActive) {
        frozenRowRenderableByKeyRef.current = liveRowRenderableByKey;
    }
    const rowRenderableByKey = props.dataActive
        ? liveRowRenderableByKey
        : frozenRowRenderableByKeyRef.current;

    const relativeNowMs = useSessionListRelativeNowMs(props.dataActive);
    // The row reads the SAME shared runtime clock as group placement, so the
    // working indicator and the session's group can never cross a freshness
    // boundary in different render cycles. The row contributes its own wake
    // horizon (below, straight from the freshly built view model), which can
    // be earlier than the list's when its renderable is fresher.
    const runtimeNowMs = useSessionListRuntimeNowMs(props.dataActive);
    const rowViewModel = React.useMemo<SessionListRowViewModel>(() => buildSessionListRowViewModel({
        item: props.item,
        index: props.dataIndex,
        listItems: props.items,
        reachableSessionDisplayById: props.reachableSessionDisplayById,
        reachableSessionDisplayByKey: props.reachableSessionDisplayByKey,
        rowRenderableByKey,
        relativeNowMs,
        runtimeNowMs,
        workingIndicatorMode: props.workingIndicatorMode === 'pulse' ? 'pulse' : 'spinner',
        workingTextMode: props.workingTextMode === 'static' ? 'static' : 'animated',
        identityDisplay: props.identityDisplay === 'agentLogo' || props.identityDisplay === 'none' ? props.identityDisplay : 'avatar',
        activeColorMode: props.activeColorMode === 'attentionOnly' || props.activeColorMode === 'allActive'
            ? props.activeColorMode
            : 'activityAndAttention',
        hideInactiveSessions: props.hideInactiveSessions === true,
        hasMultipleMachines: props.hasMultipleMachines,
        pinnedSessionKeys: props.pinnedSessionKeys,
        sessionTags: props.sessionTags,
        selectedSessionId: props.selectedSessionId,
        showServerBadge: props.showServerBadge,
        showPinnedServerBadge: props.showPinnedServerBadge,
    }), [
        props.activeColorMode,
        props.dataIndex,
        props.hasMultipleMachines,
        props.hideInactiveSessions,
        props.identityDisplay,
        props.item,
        props.items,
        props.pinnedSessionKeys,
        props.reachableSessionDisplayById,
        props.reachableSessionDisplayByKey,
        props.selectedSessionId,
        props.sessionTags,
        props.showPinnedServerBadge,
        props.showServerBadge,
        props.workingIndicatorMode,
        props.workingTextMode,
        relativeNowMs,
        rowRenderableByKey,
        runtimeNowMs,
    ]);

    useSessionListRuntimeWake(rowViewModel.nextRuntimeFreshnessAtMs, props.dataActive);

    return (
        <SessionListSessionItem
            item={props.item}
            rowViewModel={rowViewModel}
            rowHeight={props.rowHeight}
            dragEnabled={props.dragEnabled}
            treeRowId={props.treeRowId}
            onDragStart={props.onDragStart}
            resolveDropResult={props.resolveDropResult}
            onDropResult={props.onDropResult}
            onDragCancel={props.onDragCancel}
            onTogglePinnedSessionKey={props.onTogglePinnedSessionKey}
            onSetTagsSessionKey={props.onSetTagsSessionKey}
            onNativeContextMenuOpenChangeSessionKey={props.onNativeContextMenuOpenChangeSessionKey}
            draggingSessionKey={props.draggingSessionKey}
            nativeContextMenuSessionKey={props.nativeContextMenuSessionKey}
            dataIndex={props.dataIndex}
            overlayShared={props.overlayShared}
            onRegisterTreeRowBounds={props.onRegisterTreeRowBounds}
            onUnregisterTreeRowBounds={props.onUnregisterTreeRowBounds}
            currentUserId={props.currentUserId}
            allKnownTags={props.allKnownTags}
            tagsEnabled={props.tagsEnabled}
            compact={props.compact}
            compactMinimal={props.compactMinimal}
            rowAttentionAnimationEnabled={props.rowAttentionAnimationEnabled}
            folderMoveTargets={props.folderMoveTargets}
            onMoveToSessionFolder={props.onMoveToSessionFolder}
            onMoveToFolder={props.onMoveToFolder}
            onMoveToWorkspaceRoot={props.onMoveToWorkspaceRoot}
            onMoveUp={props.onMoveUp}
            onMoveDown={props.onMoveDown}
        />
    );
});
