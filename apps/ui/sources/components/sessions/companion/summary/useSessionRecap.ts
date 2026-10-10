import * as React from 'react';
import type { SessionSynopsisV1 } from '@happier-dev/protocol';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { observeSessionSynopses } from '@/sync/ops/sessionSynopsis';
import { storage } from '@/sync/domains/state/storageStore';
import { readStoredSessionMessagesForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getAppliedActiveServerId, subscribeAppliedActiveServer } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

import { resolveSessionRecap, type SessionRecap } from './sessionRecap';

const NO_SYNOPSES: readonly SessionSynopsisV1[] = Object.freeze([]);

/**
 * The Recap for the Summary card: the memory worker's latest synopsis, observed through the shared
 * System Record repository while the card is mounted. The worker-update fallback reads the delivered
 * `WorkerUpdate` headline from this exact Session's readable retained transcript.
 */
export function useSessionRecap(address: SessionAddress | null): SessionRecap | null {
    const [synopsisInput, setSynopsisInput] = React.useState<Readonly<{
        serverId: string; sessionId: string; lifetime: ActiveServerAccountScopeLifetime | null; synopses: readonly SessionSynopsisV1[];
    }> | null>(null);
    const serverId = address?.serverId ?? null;
    const sessionId = address?.sessionId ?? null;
    const activeScope = useActiveServerAccountScope(serverId);
    const accountId = activeScope?.accountId ?? null;
    const appliedServerId = React.useSyncExternalStore(subscribeAppliedActiveServer, getAppliedActiveServerId, getAppliedActiveServerId);
    const focusedHome = areServerProfileIdentifiersEquivalent(appliedServerId, serverId);
    const lifetime = React.useMemo(() => activeScope ? captureActiveServerAccountScopeLifetime() : null, [activeScope]);
    const subscribeLifetime = React.useCallback((listener: () => void) => {
        const subscription = lifetime?.onRetire(listener);
        return () => subscription?.dispose();
    }, [lifetime]);
    const readCurrent = React.useCallback(() => lifetime?.isCurrent() ?? !focusedHome, [lifetime, focusedHome]);
    const current = React.useSyncExternalStore(subscribeLifetime, readCurrent, readCurrent);
    const session = storage((state) => sessionId ? state.sessions[sessionId] : undefined);
    const transcript = storage((state) => sessionId ? state.sessionMessages[sessionId] : undefined);
    // Retained rows keep their captured Account lifetime until the transcript is hydrated again;
    // a scope change alone cannot relabel them as content from the next Account.
    const workerInput = React.useMemo(() => {
        if (!serverId || !sessionId || !session || !isSessionContentReadable(readSessionContentAvailability(session))) return null;
        const inputLifetime = focusedHome ? captureActiveServerAccountScopeLifetime() : null;
        const messages = readStoredSessionMessagesForAddress({
            sessions: { [sessionId]: session },
            sessionMessages: { [sessionId]: transcript },
        }, { serverId, sessionId });
        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (message.kind === 'agent-event' && message.event.type === 'worker-update'
                && message.event.update.headline.trim()) {
                return { lifetime: inputLifetime, backgroundHome: !focusedHome,
                    latestWorkerUpdate: { headline: message.event.update.headline, atMs: message.createdAt } };
            }
        }
        return null;
    }, [serverId, sessionId, session, transcript, focusedHome]);
    React.useEffect(() => {
        setSynopsisInput(null);
        if (!serverId || !sessionId) return;
        return observeSessionSynopses({
            session: { serverId, sessionId },
            onChange: (next) => setSynopsisInput({ serverId, sessionId, lifetime, synopses: next.length === 0 ? NO_SYNOPSES : next }),
        });
    }, [serverId, sessionId, accountId, lifetime, focusedHome]);
    return React.useMemo(() => {
        if (!current) return null;
        const synopses = synopsisInput?.serverId === serverId && synopsisInput.sessionId === sessionId
            && (!focusedHome || synopsisInput.lifetime === lifetime) && (synopsisInput.lifetime?.isCurrent() ?? true)
            ? synopsisInput.synopses : NO_SYNOPSES;
        const latestWorkerUpdate = workerInput && (workerInput.lifetime?.isCurrent() ?? workerInput.backgroundHome)
            ? workerInput.latestWorkerUpdate : null;
        return resolveSessionRecap({ synopses, latestWorkerUpdate });
    }, [current, synopsisInput, workerInput, serverId, sessionId, lifetime, focusedHome]);
}
