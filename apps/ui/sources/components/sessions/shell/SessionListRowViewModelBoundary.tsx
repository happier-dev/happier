import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useSessionListRowViewportFact, type SessionListRowViewport } from './sessionListRowViewport';
import { resolveSessionListRowStoreScopeKey } from './row/sessionListVisibleRowStoreScopes';
import type { SessionListHomeObservation } from '@/sync/domains/session/listing/sessionListHomeObservation';
import * as React from 'react';
import type { View } from 'react-native';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import {
    useSessionListRowRenderablesForItems,
} from '@/sync/domains/state/storage';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { sessionTagKey } from './sessionTagUtils';
import type { TreeDropOverlaySharedValues } from '@/components/ui/treeDragDrop';

import type { SessionAttentionStandingPolicy } from '@/sync/domains/session/organization/attentionStanding';

import { SessionListSessionItem } from './sessionListSessionItem';
import { shouldReadLiveRowRenderables } from './sessionListRowRenderableFreeze';
import {
    buildSessionListRowViewModel,
    readSessionListRowRefreshAtMs,
    type SessionReachableDisplay,
    type SessionListRowViewModel,
    type SessionListSelectedRowContextInput,
} from './sessionListRowViewModels';
import {
    useSessionListRuntimeDeadlineNowMs,
} from '@/hooks/session/sessionListRuntimeClock';
import type {
    UseSessionInlineDragStart,
    UseSessionInlineDragCancelEvent,
    UseSessionInlineDragDropResultEvent,
    UseSessionInlineDragResolveDropResultEvent,
    UseSessionInlineDragResolvedDrop,
} from './useSessionInlineDrag';
import type {
    RegisterSessionListTreeRowBounds,
    UnregisterSessionListTreeRowBounds,
} from './SessionListHeaderFrame';
import { deleteSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { useSessionListRowExistingDraft } from './useSessionListRowExistingDraft';
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
    dragEnabled: boolean;
    draggingSessionKey: string | null;
    draggingTreeRowId?: string | null;
    forkActionContext?: SessionItemProps['forkActionContext'];
    hideInactiveSessions?: boolean | null;
    identityDisplay?: 'avatar' | 'agentLogo' | 'none' | null;
    /** The active Account scope whose drafts this row shows; the row observes its own draft. */
    draftScope: ServerAccountScope | null;
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    unscopedSelectionIsUnique: boolean;
    nativeContextMenuSessionKey: string | null;
    onDragCancel?: (event: UseSessionInlineDragCancelEvent) => void;
    onDragStart: UseSessionInlineDragStart;
    onDropResult: (event: UseSessionInlineDragDropResultEvent) => void | Promise<void>;
    onMoveDown?: () => void;
    onSetReportsCollapsed?: SessionItemProps['onSetReportsCollapsed'];
    onMoveToFolder?: () => void;
    sectionMove?: SessionItemProps['sectionMove'];
    spaceMembership?: SessionItemProps['spaceMembership'];
    onMoveToWorkspaceRoot?: () => void;
    onMoveUp?: () => void;
    onNativeContextMenuOpenChangeSessionKey: ((sessionKey: string, next: boolean) => void) | null;
    onRegisterTreeRowBounds: RegisterSessionListTreeRowBounds;
    onSetTagsSessionKey: ((sessionKey: string, newTags: string[]) => void) | null;
    onTogglePinnedSessionKey: ((sessionKey: string) => void) | null;
    onUnregisterTreeRowBounds: UnregisterSessionListTreeRowBounds;
    overlayShared: TreeDropOverlaySharedValues;
    pinnedSessionKeys: ReadonlySet<string>;
    reachableSessionDisplay: SessionReachableDisplay | undefined;
    resolveDropResult: (event: UseSessionInlineDragResolveDropResultEvent) => UseSessionInlineDragResolvedDrop;
    /** The list's row membership; the row reads whether it keeps its attention animation live. */
    rowViewport: SessionListRowViewport;
    rowHeight: number;
    selectedSessionId: string | null;
    selectedSessionServerId?: string | null;
    sessionTags: Record<string, string[]>;
    showPinnedServerBadge: boolean;
    showServerBadge: boolean;
    tagsEnabled: boolean;
    treeRowId: string;
}> & (SessionListSelectedRowContextInput | { [Key in keyof SessionListSelectedRowContextInput]?: undefined });

export const SessionListRowViewModelBoundary = React.memo(function SessionListRowViewModelBoundary(
    props: SessionListRowViewModelBoundaryProps,
) {
    const stageSpotlightRef = React.useRef<View>(null);
    const stageSpotlightProps = useSpotlightTarget(
        stageSpotlightRef,
        props.item.groupKind === 'attention' ? STAGE_SPOTLIGHT_TARGET_IDS.attentionGroup : null,
    );
    const rowItems = React.useMemo(() => [props.item], [props.item]);
    const rowAttentionAnimationEnabled = useSessionListRowViewportFact(
        props.rowViewport, 'subscribed', resolveSessionListRowStoreScopeKey(props.item));
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

    const rowKey = buildSessionListServerScopedRowKey(props.item.serverId, props.item.sessionId);
    const session = rowKey ? rowRenderableByKey.get(rowKey) ?? null : null;
    const standing = props.item.serverId
        ? props.attentionStandingPolicy.overridesBySessionKey[sessionTagKey(props.item.serverId, props.item.sessionId)]
        : undefined;
    const reminderAtMs = typeof standing === 'object' ? standing.remindAt ?? null : null;
    const readNextRefreshAtMs = React.useCallback((nowMs: number) => (
        readSessionListRowRefreshAtMs({ session, reminderAtMs, homeObservation: props.homeObservation }, nowMs)
    ), [session, reminderAtMs, props.homeObservation]);
    const runtimeNowMs = useSessionListRuntimeDeadlineNowMs(readNextRefreshAtMs, props.dataActive);
    const relativeNowMs = runtimeNowMs;
    const agentSwitchingEnabled = useFeatureEnabled('sessions.agentSwitching', {
        scopeKind: 'spawn',
        serverId: props.item.serverId ?? null,
    });
    const { draft, preview: draftPreview } = useSessionListRowExistingDraft({
        activeScope: props.draftScope,
        serverId: props.item.serverId,
        sessionId: props.item.sessionId,
        dataActive: props.dataActive,
    });
    const draftScope = props.draftScope;
    const sessionId = props.item.sessionId;
    const hasDraft = draft !== null;
    const onDeleteDraft = React.useMemo(() => (draftScope && hasDraft
        ? async (): Promise<void> => {
            await deleteSessionDraft({ scope: draftScope, address: { kind: 'session', sessionId } });
        }
        : undefined), [draftScope, hasDraft, sessionId]);
    const rowViewModel = React.useMemo<SessionListRowViewModel>(() => buildSessionListRowViewModel({
        audienceScopes: props.audienceScope ? new Map([[props.audienceScope.serverId, props.audienceScope]]) : undefined,
        homeObservations: props.item.serverId && props.homeObservation
            ? { [props.item.serverId]: props.homeObservation }
            : undefined,
        item: props.item,
        unscopedSelectionIsUnique: props.unscopedSelectionIsUnique,
        reachableSessionDisplay: props.reachableSessionDisplay,
        rowRenderableByKey,
        relativeNowMs,
        runtimeNowMs,
        identityDisplay: props.identityDisplay === 'agentLogo' || props.identityDisplay === 'none' ? props.identityDisplay : 'avatar',
        activeColorMode: props.activeColorMode === 'attentionOnly' || props.activeColorMode === 'allActive'
            ? props.activeColorMode
            : 'activityAndAttention',
        hideInactiveSessions: props.hideInactiveSessions === true,
        pinnedSessionKeys: props.pinnedSessionKeys,
        sessionTags: props.sessionTags,
        selectedSessionId: props.selectedSessionId,
        selectedSessionServerId: props.selectedSessionServerId,
        showServerBadge: props.showServerBadge,
        showPinnedServerBadge: props.showPinnedServerBadge,
        attentionStandingEnabled: props.attentionStandingEnabled,
        attentionStandingPolicy: props.attentionStandingPolicy,
        existingDraft: draft,
        rowContext: props.rowContextEnabled === undefined ? undefined : {
            rowContextEnabled: props.rowContextEnabled,
            rowContextIdentityDisplay: props.rowContextIdentityDisplay,
            rowContextGroupServerId: props.rowContextGroupServerId,
            rowContextGroupProjectKey: props.rowContextGroupProjectKey,
            rowContextGroupFallbackKey: props.rowContextGroupFallbackKey,
            rowContextBaseline: props.rowContextBaseline,
            rowContextProjectTitle: props.rowContextProjectTitle,
            rowContextProjectFaviconServerId: props.rowContextProjectFaviconServerId,
            rowContextProjectFaviconMachineId: props.rowContextProjectFaviconMachineId,
            rowContextProjectFaviconWorkspacePath: props.rowContextProjectFaviconWorkspacePath,
            rowContextStatusWords: props.rowContextStatusWords,
        },
    }), [
        props.rowContextEnabled,
        props.rowContextIdentityDisplay,
        props.rowContextGroupServerId,
        props.rowContextGroupProjectKey,
        props.rowContextGroupFallbackKey,
        props.rowContextBaseline,
        props.rowContextProjectTitle,
        props.rowContextProjectFaviconServerId,
        props.rowContextProjectFaviconMachineId,
        props.rowContextProjectFaviconWorkspacePath,
        props.rowContextStatusWords,
        props.audienceScope,
        props.homeObservation,
        props.activeColorMode,
        props.attentionStandingEnabled,
        props.attentionStandingPolicy,
        props.hideInactiveSessions,
        props.identityDisplay,
        draft,
        props.item,
        props.pinnedSessionKeys,
        props.reachableSessionDisplay,
        props.selectedSessionId,
        props.selectedSessionServerId,
        props.sessionTags,
        props.showPinnedServerBadge,
        props.showServerBadge,
        relativeNowMs,
        rowRenderableByKey,
        runtimeNowMs,
        props.unscopedSelectionIsUnique,
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
            draggingTreeRowId={props.draggingTreeRowId}
            nativeContextMenuSessionKey={props.nativeContextMenuSessionKey}
            overlayShared={props.overlayShared}
            onRegisterTreeRowBounds={props.onRegisterTreeRowBounds}
            onUnregisterTreeRowBounds={props.onUnregisterTreeRowBounds}
            currentUserId={props.currentUserId}
            allKnownTags={props.allKnownTags}
            tagsEnabled={props.tagsEnabled}
            compact={props.compact}
            compactMinimal={props.compactMinimal}
            rowAttentionAnimationEnabled={rowAttentionAnimationEnabled}
            forkActionContext={props.forkActionContext}
            onMoveToFolder={props.onMoveToFolder}
            sectionMove={props.sectionMove}
            spaceMembership={props.spaceMembership}
            onMoveToWorkspaceRoot={props.onMoveToWorkspaceRoot}
            onMoveUp={props.onMoveUp}
            onMoveDown={props.onMoveDown}
            onDeleteDraft={onDeleteDraft}
            draftPreview={draftPreview}
            onSetReportsCollapsed={props.onSetReportsCollapsed}
            measurementTarget={props.item.groupKind === 'attention' ? {
                ref: stageSpotlightRef,
                onLayout: stageSpotlightProps.onLayout,
                style: stageSpotlightProps.style,
            } : undefined}
        />
    );
    return sessionItem;
});
