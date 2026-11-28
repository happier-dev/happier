import { getVisibleSessionSurfaces, isSessionSurfaceVisible, subscribeSessionSurfaceVisibility } from '@/sync/domains/session/sessionSurfaceVisibility';
import {
    isSessionFullContentConsumerActive,
    sessionScmMutationSignalWanted,
} from '@/sync/domains/session/realtime/sessionRealtimeVisibility';
import {
    readMountedSessionRealtimeScmConsumerScopes,
    resolveSessionRealtimeScmScopeForMountedConsumers,
    subscribeMountedSessionRealtimeScmConsumerScopes,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import { readMountedSessionRealtimeTranscriptConsumerSessionIds, subscribeSessionRealtimeTranscriptConsumers } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { storage } from '@/sync/domains/state/storage';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { getVoiceSessionSnapshot, useVoiceSessionStore } from '@/voice/session/voiceSessionStore';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readLatestMessageSessionIds, subscribeLatestMessageDemand } from './sessionListLatestMessage';
import type { SessionConsumptionReplaceV1 } from '@happier-dev/protocol/sessions';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    areSessionAddressesEqual,
    normalizeSessionAddress,
    type SessionAddress,
} from '@/sync/domains/session/sessionAddress';

export type SessionLiveConsumption = Readonly<{
    isVisible: boolean;
    isFullContentConsumer: boolean;
}>;

function addTrimmedSessionId(ids: string[], value: unknown): void {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) ids.push(trimmed);
}

function resolveSourceSessionAddress(
    sessionId: string,
    sourceServerId?: string | null,
): SessionAddress | null {
    return normalizeSessionAddress(
        sourceServerId ?? getActiveServerSnapshot().serverId,
        sessionId,
    );
}

function readMatchingSessionId(
    address: SessionAddress | null | undefined,
    source: SessionAddress | null,
): string | null {
    return areSessionAddressesEqual(address, source) ? source?.sessionId ?? null : null;
}

function getVoiceBoundSessionIds(serverId: string | null): string[] {
    if (!serverId) return [];
    const snapshot = getVoiceSessionSnapshot();
    if (!snapshot.canStop || !snapshot.sessionId) return [];
    const binding = voiceSessionBindingStore.getState().getByControlSessionId(snapshot.sessionId);
    if (!binding || binding.adapterId !== snapshot.adapterId) return [];
    const ids: string[] = [];
    // A global conversation has no target. Each bound address supplies its
    // own Home; the control id is not a transcript address.
    if (binding.conversationSessionAddress.serverId === serverId) {
        addTrimmedSessionId(ids, binding.conversationSessionAddress.sessionId);
    }
    if (binding.targetSessionAddress?.serverId === serverId) {
        addTrimmedSessionId(ids, binding.targetSessionAddress.sessionId);
    }
    return ids;
}

/**
 * Single source of truth for "is this session a live-content consumer right now?".
 *
 * Hidden sessions in the same SCM project scope are intentionally NOT full-content consumers:
 * their workspace-mutation signal is resolved separately via resolveSessionScmMutationSignal
 * and fed from the durable projection path without hydrating their transcripts. Only the
 * mounted SCM consumer's own session (scmSameSession) stays a full-content consumer here.
 */
export function resolveSessionLiveConsumption(
    sessionId: string,
    sourceServerId?: string | null,
): SessionLiveConsumption {
    const visible = isSessionSurfaceVisible(sessionId, sourceServerId);
    const source = resolveSourceSessionAddress(sessionId, sourceServerId);
    const targetState = useVoiceTargetStore.getState();
    const voiceActive = getVoiceSessionSnapshot().canStop;
    const isFullContentConsumer = isSessionFullContentConsumerActive({
        sessionId,
        serverId: source?.serverId ?? null,
        isVisible: visible,
        explicitTranscriptConsumerSessionIds: readMountedSessionRealtimeTranscriptConsumerSessionIds(sourceServerId),
        voicePrimaryActionSessionId: voiceActive ? readMatchingSessionId(targetState.primaryActionSessionAddress, source) : null,
        // Account Follow Include in Voice is a background update/catch-up
        // authority, never a full transcript-consumption reason. The retained
        // compatibility projection likewise cannot hydrate content.
        voiceTrackedSessionIds: [],
        voiceReadbackSessionIds: voiceActive && readMatchingSessionId(targetState.lastFocusedSessionAddress, source)
            ? [source!.sessionId]
            : [],
        voiceBoundTargetSessionIds: getVoiceBoundSessionIds(source?.serverId ?? null),
        scmMountedScopes: readMountedSessionRealtimeScmConsumerScopes(),
    });
    return { isVisible: visible, isFullContentConsumer };
}

/**
 * Whether a mounted SCM consumer wants workspace-mutation signals from this session.
 *
 * Uses the same mounted-scope registry and scope inference as resolveSessionLiveConsumption's
 * SCM reason assembly, so the projection-path mutation side channel can never diverge from the
 * realtime routing facts. Unlike the full-content decision, the (comparatively expensive) hidden
 * session project-scope inference runs only here — once per skipped durable message, never on the
 * per-tick ephemeral path.
 */
export function resolveSessionScmMutationSignal(sessionId: string, sourceServerId?: string | null): boolean {
    const scmMountedScopes = readMountedSessionRealtimeScmConsumerScopes();
    if (scmMountedScopes.length === 0) {
        return false;
    }
    const address = { serverId: resolveSourceSessionAddress(sessionId, sourceServerId)?.serverId ?? null, sessionId };
    return sessionScmMutationSignalWanted({
        sessionId,
        serverId: address.serverId,
        sessionScmScope: resolveSessionRealtimeScmScopeForMountedConsumers(sourceServerId == null
            ? storage.getState() : readSessionScmScopeState(sessionId, address.serverId), address, scmMountedScopes),
        scmMountedScopes,
    });
}

function readSessionScmScopeState(sessionId: string, serverId: string | null) {
    const state = storage.getState();
    const full = state.sessions[sessionId];
    const fullHome = full?.serverId ?? getActiveServerSnapshot().serverId;
    if (full && (!serverId || areServerProfileIdentifiersEquivalent(fullHome, serverId))) return state;
    const row = readSessionListRowsForServerId(state.sessionListRowsByServerId, serverId)?.[sessionId];
    // Scoped rows already contain admitted owner/shared display workspace facts.
    return { sessions: row ? { [sessionId]: { metadata: row.metadata, metadataLayoutVersion: 0 } } : {} };
}

/** One projection per captured socket Home. Its lifetime ends with that socket. */
export function createSessionConsumptionProjection(serverId: string): Readonly<{
    read: () => SessionConsumptionReplaceV1;
    subscribe: (listener: (declaration: SessionConsumptionReplaceV1) => void) => () => void;
    dispose: () => void;
}> {
    const listeners = new Set<(declaration: SessionConsumptionReplaceV1) => void>();
    let declaration: SessionConsumptionReplaceV1 = { v: 1, liveSessionIds: [], durableSessionIds: [] };
    const scmSessionIds = new Set<string>();
    const sameHome = (id: string | null | undefined) => Boolean(id && areServerProfileIdentifiersEquivalent(id, serverId));
    let scmScopes = readMountedSessionRealtimeScmConsumerScopes().filter(scope => sameHome(scope.serverId));
    function updateScmSession(sessionId: string): void {
        const state = readSessionScmScopeState(sessionId, serverId);
        const wanted = sessionScmMutationSignalWanted({ sessionId, serverId,
            sessionScmScope: resolveSessionRealtimeScmScopeForMountedConsumers(state,
                { serverId, sessionId }, scmScopes), scmMountedScopes: scmScopes });
        if (wanted) scmSessionIds.add(sessionId); else scmSessionIds.delete(sessionId);
    }
    function rebuildScmSessions(): void {
        scmSessionIds.clear();
        if (scmScopes.length === 0) return;
        const state = storage.getState();
        const ids = new Set(Object.keys(readSessionListRowsForServerId(state.sessionListRowsByServerId, serverId) ?? {}));
        for (const session of Object.values(state.sessions)) {
            if (sameHome(session.serverId ?? getActiveServerSnapshot().serverId)) ids.add(session.id);
        }
        for (const id of ids) updateScmSession(id);
    }
    function refresh(): void {
        const live = new Set<string>();
        for (const address of getVisibleSessionSurfaces()) if (sameHome(address.serverId)) live.add(address.sessionId);
        for (const id of readMountedSessionRealtimeTranscriptConsumerSessionIds(serverId)) live.add(id);
        for (const scope of scmScopes) if (scope.needsMutationTranscript && scope.sessionId) live.add(scope.sessionId);
        const target = useVoiceTargetStore.getState();
        if (getVoiceSessionSnapshot().canStop) {
            for (const address of [target.primaryActionSessionAddress, target.lastFocusedSessionAddress]) {
                if (address && sameHome(address.serverId)) live.add(address.sessionId);
            }
        }
        for (const id of getVoiceBoundSessionIds(serverId)) live.add(id);
        const liveSessionIds = [...live].filter(id => resolveSessionLiveConsumption(id, serverId).isFullContentConsumer).sort();
        const durableSessionIds = [...new Set([...liveSessionIds, ...scmSessionIds])].sort();
        const latestMessageSessionIds = readLatestMessageSessionIds(serverId).sort();
        const previousLatestMessageSessionIds = declaration.latestMessageSessionIds ?? [];
        if (latestMessageSessionIds.length === previousLatestMessageSessionIds.length
            && latestMessageSessionIds.every((id, index) => id === previousLatestMessageSessionIds[index])
            && liveSessionIds.length === declaration.liveSessionIds.length
            && liveSessionIds.every((id, index) => id === declaration.liveSessionIds[index])
            && durableSessionIds.length === declaration.durableSessionIds.length
            && durableSessionIds.every((id, index) => id === declaration.durableSessionIds[index])) return;
        declaration = { v: 1, liveSessionIds, durableSessionIds,
            ...(latestMessageSessionIds.length > 0 && { latestMessageSessionIds }) };
        for (const listener of listeners) listener(declaration);
    }
    const refreshScm = () => {
        scmScopes = readMountedSessionRealtimeScmConsumerScopes().filter(scope => sameHome(scope.serverId));
        rebuildScmSessions(); refresh();
    };
    const disposers = [
        subscribeSessionSurfaceVisibility(refresh),
        subscribeLatestMessageDemand(refresh),
        subscribeSessionRealtimeTranscriptConsumers(refresh),
        subscribeMountedSessionRealtimeScmConsumerScopes(refreshScm),
        useVoiceTargetStore.subscribe(refresh),
        voiceSessionBindingStore.subscribe(refresh),
        useVoiceSessionStore.subscribe(refresh),
        storage.subscribe((state, previous) => {
            if (scmScopes.length === 0 || state.sessionListRenderableDelta === previous.sessionListRenderableDelta) return;
            const currentRows = readSessionListRowsForServerId(state.sessionListRowsByServerId, serverId);
            const previousRows = readSessionListRowsForServerId(previous.sessionListRowsByServerId, serverId);
            const delta = state.sessionListRenderableDelta;
            if (!delta) return;
            let changed = false;
            for (const id of new Set([...delta.changedSessionIds, ...delta.removedSessionIds])) {
                const next = currentRows?.[id]?.metadata;
                const before = previousRows?.[id]?.metadata;
                if (next?.path === before?.path && next?.machineId === before?.machineId && next?.host === before?.host
                    && next?.externalSessionV1?.machineId === before?.externalSessionV1?.machineId
                    && next?.sessionWorkspaceLocationV1 === before?.sessionWorkspaceLocationV1
                    && next?.projectId === before?.projectId && next?.workspaceId === before?.workspaceId
                    && currentRows?.[id]?.projectKey === previousRows?.[id]?.projectKey
                    && Boolean(currentRows?.[id]) === Boolean(previousRows?.[id])) continue;
                updateScmSession(id); changed = true;
            }
            if (changed) refresh();
        }, { sessionListRenderableDelta: true }),
    ];
    refreshScm();
    return {
        read: () => declaration,
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        dispose: () => { for (const dispose of disposers) dispose(); listeners.clear(); },
    };
}
