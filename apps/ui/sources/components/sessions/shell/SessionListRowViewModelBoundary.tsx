import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionListHomeObservation } from '@/sync/domains/session/listing/sessionListHomeObservation';
import * as React from 'react';
import type { View } from 'react-native';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import {
    useSessionListRowRenderablesForItems,
} from '@/sync/domains/state/storage';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { TreeDropOverlaySharedValues } from '@/components/ui/treeDragDrop';

import type { SessionAttentionStandingPolicy } from '@/sync/domains/session/organization/attentionStanding';

import { SessionListSessionItem } from './sessionListSessionItem';
import { shouldReadLiveRowRenderables } from './sessionListRowRenderableFreeze';
import {
    buildSessionListRowViewModel,
    resolveSessionListRowViewModelAdjacency,
    resolveSessionListUnscopedSelectionIsUnique,
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
import type { ExistingSessionDraftProjection } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { STAGE_SPOTLIGHT_TARGET_IDS } from '@/components/onboarding/tour/stage/stageSpotlightTargetIds';
import {
    useSpotlightTarget,
} from '@/components/onboarding/tour/stage/useSpotlightTarget';
import type { SessionItemProps } from './SessionItem';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

const EMPTY_ROW_RENDERABLES = new Map<string, SessionListRenderableSession>() as ReadonlyMap<string, SessionListRenderableSession>;
export type SessionListRowViewModelBoundaryProps = Readonly<{
    audienceScope?: ServerAccountScope;
    audienceLabel?: string | null;
    /** This row's exact-Home list currentness, from the canonical per-Home observation owner. */
    homeObservation?: SessionListHomeObservation | null;
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
    forkActionContext?: SessionItemProps['forkActionContext'];
    hasMultipleMachines: boolean;
    hideInactiveSessions?: boolean | null;
    identityDisplay?: 'avatar' | 'agentLogo' | 'none' | null;
    draft?: ExistingSessionDraftProjection | null;
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    items: ReadonlyArray<SessionListIndexItem>;
    nativeContextMenuSessionKey: string | null;
    onDragCancel?: (event: UseSessionInlineDragCancelEvent) => void;
    onDragStart: (sessionKey: string) => void;
    onDropResult: (event: UseSessionInlineDragDropResultEvent) => void | Promise<void>;
    onMoveDown?: () => void;
    onDeleteDraft?: () => void | Promise<void>;
    onMoveToFolder?: () => void;
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
    selectedSessionServerId?: string | null;
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
    const agentSwitchingEnabled = useFeatureEnabled('sessions.agentSwitching', {
        scopeKind: 'spawn',
        serverId: props.item.serverId ?? null,
    });
    const adjacency = React.useMemo(
        () => resolveSessionListRowViewModelAdjacency(props.items, props.dataIndex),
        [props.dataIndex, props.items],
    );
    const unscopedSelectionIsUnique = React.useMemo(
        () => !String(props.selectedSessionServerId ?? '').trim()
            && props.selectedSessionId === props.item.sessionId
            && resolveSessionListUnscopedSelectionIsUnique(props.items, props.selectedSessionId),
        [props.item.sessionId, props.items, props.selectedSessionId, props.selectedSessionServerId],
    );
    const rowViewModel = React.useMemo<SessionListRowViewModel>(() => buildSessionListRowViewModel({
        audienceScopes: props.audienceScope ? new Map([[props.audienceScope.serverId, props.audienceScope]]) : undefined,
        homeObservations: props.item.serverId && props.homeObservation
            ? { [props.item.serverId]: props.homeObservation }
            : undefined,
        item: props.item,
        adjacency,
        unscopedSelectionIsUnique,
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
        selectedSessionServerId: props.selectedSessionServerId,
        showServerBadge: props.showServerBadge,
        showPinnedServerBadge: props.showPinnedServerBadge,
        attentionStandingEnabled: props.attentionStandingEnabled,
        attentionStandingPolicy: props.attentionStandingPolicy,
        existingDraft: props.draft,
    }), [
        props.audienceScope,
        props.homeObservation,
        props.activeColorMode,
        props.attentionStandingEnabled,
        props.attentionStandingPolicy,
        adjacency,
        props.hasMultipleMachines,
        props.hideInactiveSessions,
        props.identityDisplay,
        props.draft,
        props.item,
        props.pinnedSessionKeys,
        props.reachableSessionDisplayById,
        props.reachableSessionDisplayByKey,
        props.selectedSessionId,
        props.selectedSessionServerId,
        props.sessionTags,
        props.showPinnedServerBadge,
        props.showServerBadge,
        props.workingIndicatorMode,
        props.workingTextMode,
        relativeNowMs,
        rowRenderableByKey,
        runtimeNowMs,
        unscopedSelectionIsUnique,
    ]);

    const sessionItem = (
        <SessionListSessionItem
            item={props.item}
            rowViewModel={rowViewModel}
            agentSwitchingEnabled={agentSwitchingEnabled}
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
            forkActionContext={props.forkActionContext}
            onMoveToFolder={props.onMoveToFolder}
            onMoveToWorkspaceRoot={props.onMoveToWorkspaceRoot}
            onMoveUp={props.onMoveUp}
            onMoveDown={props.onMoveDown}
            onDeleteDraft={props.onDeleteDraft}
            measurementTarget={props.item.groupKind === 'attention' ? {
                ref: stageSpotlightRef,
                onLayout: stageSpotlightProps.onLayout,
                style: stageSpotlightProps.style,
            } : undefined}
        />
    );
    return sessionItem;
});
