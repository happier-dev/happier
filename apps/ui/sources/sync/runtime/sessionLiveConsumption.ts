import {
    getVisibleSessionIds,
    isSessionVisible,
    subscribeActiveViewingSessionVisibilityChanges,
} from '@/sync/domains/session/activeViewingSession';
import {
    isSessionFullContentConsumerActive,
    sessionNeedsLiveTranscript,
    sessionScmMutationSignalWanted,
    type SessionNeedsLiveTranscriptInput,
} from '@/sync/domains/session/realtime/sessionRealtimeVisibility';
import {
    readMountedSessionRealtimeScmConsumerScopes,
    resolveSessionRealtimeScmScopeForMountedConsumers,
    subscribeMountedSessionRealtimeScmConsumerScopeChanges,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import { isSessionRealtimeTranscriptSuppressed } from '@/sync/runtime/sessionRealtimeTranscriptSuppression';
import {
    readMountedSessionRealtimeTranscriptConsumerSessionIds,
    subscribeSessionRealtimeTranscriptConsumerChanges,
} from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { voiceSessionBindingStore } from '@/voice/sessionBinding/voiceSessionBindingStore';

export type SessionLiveConsumption = Readonly<{
    isVisible: boolean;
    isFullContentConsumer: boolean;
}>;

/** The session-independent inputs of the live-transcript decision, so every reader assembles them once. */
type SessionLiveTranscriptInputs = Required<Pick<
    SessionNeedsLiveTranscriptInput,
    | 'explicitTranscriptConsumerSessionIds'
    | 'voicePrimaryActionSessionId'
    | 'voiceTrackedSessionIds'
    | 'voiceReadbackSessionIds'
    | 'voiceBoundTargetSessionIds'
    | 'scmMountedScopes'
>>;

function getVoiceBoundTargetSessionIds(): string[] {
    return voiceSessionBindingStore
        .getState()
        .list()
        .map((binding) => binding.targetSessionId)
        .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.trim().length > 0);
}

function readSessionLiveTranscriptInputs(sourceServerId?: string | null): SessionLiveTranscriptInputs {
    const voiceTarget = useVoiceTargetStore.getState();
    return {
        explicitTranscriptConsumerSessionIds: readMountedSessionRealtimeTranscriptConsumerSessionIds(sourceServerId),
        voicePrimaryActionSessionId: voiceTarget.primaryActionSessionId,
        voiceTrackedSessionIds: voiceTarget.trackedSessionIds,
        voiceReadbackSessionIds: voiceTarget.lastFocusedSessionId ? [voiceTarget.lastFocusedSessionId] : [],
        voiceBoundTargetSessionIds: getVoiceBoundTargetSessionIds(),
        scmMountedScopes: readMountedSessionRealtimeScmConsumerScopes(),
    };
}

/**
 * Single source of truth for "is this session a live-content consumer right now?".
 *
 * Assembles the same reason fan-out the realtime router consumes (visibility, explicit
 * transcript consumers, voice primary/tracked/readback/bound targets, SCM same-session)
 * so the catch-up policy gate and realtime routing can never diverge.
 *
 * Hidden sessions in the same SCM project scope are intentionally NOT full-content consumers:
 * their workspace-mutation signal is resolved separately via resolveSessionScmMutationSignal
 * and fed from the durable projection path without hydrating their transcripts.
 *
 * Read it at decision time (the visibility signal is a now-decision, not an enqueue-decision).
 */
export function resolveSessionLiveConsumption(
    sessionId: string,
    sourceServerId?: string | null,
): SessionLiveConsumption {
    if (isSessionRealtimeTranscriptSuppressed(sessionId, sourceServerId)) {
        return { isVisible: false, isFullContentConsumer: false };
    }
    const visible = isSessionVisible(sessionId, sourceServerId);
    const inputs = readSessionLiveTranscriptInputs(sourceServerId);
    const scmMountedScopes = inputs.scmMountedScopes;
    const isFullContentConsumer = isSessionFullContentConsumerActive({
        sessionId,
        isVisible: visible,
        ...inputs,
        sessionScmScope: scmMountedScopes.length > 0
            ? resolveSessionRealtimeScmScopeForMountedConsumers(storage.getState(), sessionId, scmMountedScopes)
            : null,
    });
    return { isVisible: visible, isFullContentConsumer };
}

/**
 * Every session this client currently consumes a live transcript for, across every server scope.
 *
 * Each candidate is decided by the same `sessionNeedsLiveTranscript` reasons as
 * `resolveSessionLiveConsumption`, so a session the realtime router accepts is always declared here.
 */
export function readSessionLiveTranscriptInterestSessionIds(): string[] {
    const inputs = readSessionLiveTranscriptInputs();
    const visibleSessionIds = getVisibleSessionIds();
    const visible = new Set(visibleSessionIds);
    const candidates = new Set<string>(visibleSessionIds);
    for (const sessionId of inputs.explicitTranscriptConsumerSessionIds ?? []) candidates.add(sessionId);
    if (inputs.voicePrimaryActionSessionId) candidates.add(inputs.voicePrimaryActionSessionId);
    for (const sessionId of inputs.voiceTrackedSessionIds ?? []) candidates.add(sessionId);
    for (const sessionId of inputs.voiceReadbackSessionIds ?? []) candidates.add(sessionId);
    for (const sessionId of inputs.voiceBoundTargetSessionIds ?? []) candidates.add(sessionId);
    for (const scope of inputs.scmMountedScopes ?? []) {
        if (scope.sessionId) candidates.add(scope.sessionId);
    }

    return Array.from(candidates)
        .filter((sessionId) => sessionNeedsLiveTranscript({ ...inputs, sessionId, isVisible: visible.has(sessionId) }).active)
        .sort();
}

/** Notifies whenever a source of the declared transcript interest set changed; the reader re-derives the set. */
export function subscribeToSessionLiveTranscriptInterestChanges(listener: () => void): () => void {
    const unsubscribers = [
        subscribeActiveViewingSessionVisibilityChanges(listener),
        subscribeSessionRealtimeTranscriptConsumerChanges(listener),
        subscribeMountedSessionRealtimeScmConsumerScopeChanges(listener),
        useVoiceTargetStore.subscribe(() => listener()),
        voiceSessionBindingStore.subscribe(() => listener()),
    ];
    return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
    };
}

/**
 * Whether a mounted SCM consumer wants workspace-mutation signals from this session.
 *
 * Uses the same suppression gate and SCM scope assembly as resolveSessionLiveConsumption so the
 * projection-path mutation side channel can never diverge from realtime routing/catch-up facts.
 */
export function resolveSessionScmMutationSignal(
    sessionId: string,
    sourceServerId?: string | null,
): boolean {
    if (isSessionRealtimeTranscriptSuppressed(sessionId, sourceServerId)) {
        return false;
    }
    const scmMountedScopes = readMountedSessionRealtimeScmConsumerScopes();
    if (scmMountedScopes.length === 0) {
        return false;
    }
    return sessionScmMutationSignalWanted({
        sessionId,
        sessionScmScope: resolveSessionRealtimeScmScopeForMountedConsumers(storage.getState(), sessionId, scmMountedScopes),
        scmMountedScopes,
    });
}
