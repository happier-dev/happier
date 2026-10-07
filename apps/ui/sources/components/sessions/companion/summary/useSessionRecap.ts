import * as React from 'react';
import type { SessionSynopsisV1 } from '@happier-dev/protocol';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { observeSessionSynopses } from '@/sync/ops/sessionSynopsis';
import { storage } from '@/sync/domains/state/storageStore';
import { readStoredSessionMessagesForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';

import { resolveSessionRecap, type SessionRecap } from './sessionRecap';

const NO_SYNOPSES: readonly SessionSynopsisV1[] = Object.freeze([]);

/**
 * The Recap for the Summary card: the memory worker's latest synopsis, observed through the shared
 * System Record repository while the card is mounted. The worker-update fallback reads the delivered
 * `WorkerUpdate` headline from this exact Session's readable retained transcript.
 */
export function useSessionRecap(address: SessionAddress | null): SessionRecap | null {
    const [synopses, setSynopses] = React.useState<readonly SessionSynopsisV1[]>(NO_SYNOPSES);
    const serverId = address?.serverId ?? null;
    const sessionId = address?.sessionId ?? null;
    const activeScope = useActiveServerAccountScope(serverId);
    const accountId = activeScope?.accountId ?? null;
    const session = storage((state) => sessionId ? state.sessions[sessionId] : undefined);
    const transcript = storage((state) => sessionId ? state.sessionMessages[sessionId] : undefined);
    const latestWorkerUpdate = React.useMemo(() => {
        if (!serverId || !sessionId || !session || !isSessionContentReadable(readSessionContentAvailability(session))) return null;
        const messages = readStoredSessionMessagesForAddress({
            sessions: { [sessionId]: session },
            sessionMessages: { [sessionId]: transcript },
        }, { serverId, sessionId });
        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (message.kind === 'agent-event' && message.event.type === 'worker-update'
                && message.event.update.headline.trim()) {
                return { headline: message.event.update.headline, atMs: message.createdAt };
            }
        }
        return null;
    }, [serverId, sessionId, session, transcript]);
    React.useEffect(() => {
        setSynopses(NO_SYNOPSES);
        if (!serverId || !sessionId) return;
        return observeSessionSynopses({
            session: { serverId, sessionId },
            onChange: (next) => setSynopses(next.length === 0 ? NO_SYNOPSES : next),
        });
    }, [serverId, sessionId, accountId]);
    return React.useMemo(
        () => resolveSessionRecap({ synopses, latestWorkerUpdate }),
        [synopses, latestWorkerUpdate],
    );
}
