import * as React from 'react';
import type { View } from 'react-native';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import {
    useSessionListRowRenderablesForItems,
} from '@/sync/domains/state/storage';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionFolderMoveTarget } from '@/sync/domains/session/folders';
import type { TreeDropOverlaySharedValues } from '@/components/ui/treeDragDrop';

import type { SessionAttentionStandingPolicy } from '@/sync/domains/session/organization/attentionStanding';

import { SessionListSessionItem } from './sessionListSessionItem';
import { shouldReadLiveRowRenderables } from './sessionListRowRenderableFreeze';
import {
    buildSessionListRowViewModel,
    type SessionReachableDisplay,
    type SessionListRowViewModel,
} from './sessionListRowViewModels';
import {
    useSessionListRelativeNowMs,
    useSessionListRuntimeNowMs,
} from '@/hooks/session/sessionListRuntimeClock';
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
import { STAGE_SPOTLIGHT_TARGET_IDS } from '@/components/onboarding/tour/stage/stageSpotlightTargetIds';
import {
    useSpotlightTarget,
} from '@/components/onboarding/tour/stage/useSpotlightTarget';

const EMPTY_ROW_RENDERABLES = new Map<string, SessionListRenderableSession>() as ReadonlyMap<string, SessionListRenderableSession>;
export type SessionListRowViewModelBoundaryProps = Readonly<{
    activeColorMode?: 'activityAndAttention' | 'attentionOnly' | 'allActive' | null;
    allKnownTags: string[];
    attentionStandingEnabled: boolean;
    attentionStandingPolicy: SessionAttentionStandingPolicy;
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
    const stageSpotlightRef = React.useRef<View>(null);
    const stageSpotlightProps = useSpotlightTarget(
        stageSpotlightRef,
        props.item.groupKind === 'attention' ? STAGE_SPOTLIGHT_TARGET_IDS.attentionGroup : null,
    );
    const rowItems = React.useMemo(() => [props.item], [props.item]);
    const frozenRowRenderableByKeyRef = React.useRef<ReadonlyMap<string, SessionListRenderableSession>>(EMPTY_ROW_RENDERABLES);
    // A row can FIRST render while the surface is inactive - the list keeps rendering behind a
    // pushed screen - and such a row has no frozen snapshot to fall back to. Presenting its starting
    // EMPTY map would blank it until the surface returns, so "never frozen anything" reads live
    // once. See `shouldReadLiveRowRenderables`.
    const readLiveRowRenderables = shouldReadLiveRowRenderables({
        dataActive: props.dataActive,
        hasFrozenRenderables: frozenRowRenderableByKeyRef.current !== EMPTY_ROW_RENDERABLES,
    });
    const liveRowRenderableByKey = useSessionListRowRenderablesForItems(readLiveRowRenderables ? rowItems : null);
    if (readLiveRowRenderables) {
        frozenRowRenderableByKeyRef.current = liveRowRenderableByKey;
    }
    const rowRenderableByKey = props.dataActive
        ? liveRowRenderableByKey
        : frozenRowRenderableByKeyRef.current;

    const relativeNowMs = useSessionListRelativeNowMs(props.dataActive);
    // The row reads the SAME shared runtime clock as group placement. The
    // list-level surface owns the single earliest-wake registration; rows
    // subscribe to the shared timestamp without adding per-row effects.
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
        attentionStandingEnabled: props.attentionStandingEnabled,
        attentionStandingPolicy: props.attentionStandingPolicy,
    }), [
        props.activeColorMode,
        props.attentionStandingEnabled,
        props.attentionStandingPolicy,
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

    const sessionItem = (
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
            measurementTarget={props.item.groupKind === 'attention' ? {
                ref: stageSpotlightRef,
                onLayout: stageSpotlightProps.onLayout,
                style: stageSpotlightProps.style,
            } : undefined}
        />
    );
    return sessionItem;
});
