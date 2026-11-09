import * as React from 'react';
import type { SessionSynopsisV1 } from '@happier-dev/protocol/messages/structured/sessionSynopsisV1';
import { readSessionMemoryEnabledV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { resolveSessionRecapState, type SessionRecapState } from '@happier-dev/protocol/sessions/awareness/action';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { observeSessionSynopses } from '@/sync/ops/sessionSynopsis';
import { storage } from '@/sync/domains/state/storageStore';
import { readStoredSessionTranscriptForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { describeWorkerUpdateHeadline } from '@/components/work/status/resolveWorkStatusTone';
import { getAppliedActiveServerId, subscribeAppliedActiveServer } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

import { resolveSessionRecap, type SessionRecap } from './sessionRecap';

const NO_SYNOPSES: readonly SessionSynopsisV1[] = Object.freeze([]);
export type { SessionRecapState } from '@happier-dev/protocol/sessions/awareness/action';

/** The Recap alone, for surfaces that show nothing until one exists (the Summary card). */
export function useSessionRecap(address: SessionAddress | null): SessionRecap | null {
    return useSessionRecapState(address).recap;
}

/**
 * The Recap for the Summary card: the memory worker's latest synopsis, observed through the shared
 * System Record repository while the card is mounted. The worker-update fallback reads the delivered
 * `WorkerUpdate` headline from this exact Session's readable retained transcript.
 */
export function useSessionRecapState(address: SessionAddress | null, enabled = true): SessionRecapState {
    const [synopsisInput, setSynopsisInput] = React.useState<Readonly<{
        serverId: string; sessionId: string; lifetime: ActiveServerAccountScopeLifetime | null; synopses: readonly SessionSynopsisV1[];
        status: 'ready' | 'loading' | 'unavailable';
    }> | null>(null);
    const serverId = address?.serverId ?? null;
    const sessionId = address?.sessionId ?? null;
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const appliedServerId = React.useSyncExternalStore(subscribeAppliedActiveServer, getAppliedActiveServerId, getAppliedActiveServerId);
    const focusedHome = areServerProfileIdentifiersEquivalent(appliedServerId, serverId);
    const lifetime = activeLifetime && areServerProfileIdentifiersEquivalent(activeLifetime.scope.serverId, serverId)
        ? activeLifetime : null;
    const current = lifetime?.isCurrent() ?? !focusedHome;
    const readable = storage((state) => {
        const session = sessionId ? state.sessions[sessionId] : undefined;
        return session ? areServerProfileIdentifiersEquivalent(session.serverId ?? appliedServerId, serverId)
            && isSessionContentReadable(readSessionContentAvailability(session)) : null;
    });
    const ownerMetadata = storage((state) => {
        const session = sessionId ? state.sessions[sessionId] : undefined;
        return readable && session ? readSessionOwnerMetadataView(session) : null;
    });
    const memoryEnabled = readSessionMemoryEnabledV1(ownerMetadata);
    const currentSynopsisInput = synopsisInput?.serverId === serverId && synopsisInput.sessionId === sessionId
        && (!focusedHome || synopsisInput.lifetime === lifetime) && (synopsisInput.lifetime?.isCurrent() ?? true)
        ? synopsisInput : null;
    const synopses = currentSynopsisInput?.synopses ?? NO_SYNOPSES;
    const synopsisStatus = currentSynopsisInput?.status ?? 'loading';
    const synopsisRecap = React.useMemo(() => resolveSessionRecap({ memoryEnabled, synopses, latestWorkerUpdate: null }), [memoryEnabled, synopses]);
    // Capture custody from the compact admitted pointer even when a synopsis supplies the text.
    // Losing that synopsis must never relabel an older Account's retained body with a new lifetime.
    const latestMessage = storage((state) => readStoredSessionTranscriptForAddress(state, address,
        { activeServerId: appliedServerId })?.latestWorkerUpdates?.latestMessage ?? null);
    const workerCustody = React.useMemo(() => ({
        lifetime: focusedHome ? captureActiveServerAccountScopeLifetime() : null,
        backgroundHome: !focusedHome,
    }), [serverId, sessionId, latestMessage, ownerMetadata, focusedHome]);
    const needsFallback = enabled && current && readable === true && !synopsisRecap
        && (workerCustody.lifetime?.isCurrent() ?? workerCustody.backgroundHome);
    const workerMessage = storage((state) => needsFallback && latestMessage
        ? readStoredSessionTranscriptForAddress(state, address, { activeServerId: appliedServerId })?.messagesById[latestMessage.messageId] ?? null : null);
    const transcriptLoaded = storage((state) => needsFallback
        ? readStoredSessionTranscriptForAddress(state, address, { activeServerId: appliedServerId })?.isLoaded ?? false : false);
    // Retained rows keep their captured Account lifetime until transcript or owner metadata admission;
    // a scope change alone cannot relabel them as content from the next Account.
    const workerInput = React.useMemo(() => {
        if (!serverId || !sessionId || workerMessage?.kind !== 'agent-event' || workerMessage.event.type !== 'worker-update') return null;
        return { ...workerCustody,
            latestWorkerUpdate: { headline: describeWorkerUpdateHeadline(workerMessage.event.update),
                body: workerMessage.event.update.result ?? null, atMs: workerMessage.createdAt,
                workerSessionId: workerMessage.event.update.workerKind === 'session' ? workerMessage.event.update.workerId : null } };
    }, [serverId, sessionId, workerMessage, workerCustody]);
    React.useEffect(() => {
        if (!enabled) return;
        if (!serverId || !sessionId || !readable || !memoryEnabled) return;
        return observeSessionSynopses({
            session: { serverId, sessionId },
            onChange: (next, status) => setSynopsisInput({ serverId, sessionId, lifetime, status, synopses: next.length === 0 ? NO_SYNOPSES : next }),
        });
    }, [serverId, sessionId, lifetime, focusedHome, enabled, readable, memoryEnabled]);
    return React.useMemo((): SessionRecapState => {
        const latestWorkerUpdate = workerInput && (workerInput.lifetime?.isCurrent() ?? workerInput.backgroundHome)
            ? workerInput.latestWorkerUpdate : null;
        return resolveSessionRecapState({ contentReadable: current && readable !== false,
            memoryEnabled, synopses, synopsisStatus, latestWorkerUpdate, transcriptLoaded });
    }, [current, readable, transcriptLoaded, memoryEnabled, synopses, synopsisStatus, workerInput]);
}
