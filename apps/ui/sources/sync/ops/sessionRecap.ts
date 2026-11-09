import { readSessionMemoryEnabledV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { resolveSessionRecap, resolveSessionRecapState, type SessionRecapState } from '@happier-dev/protocol/sessions/awareness/action';
import { describeWorkerUpdateHeadline } from '@/components/work/status/resolveWorkStatusTone';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storageStore';
import { findSessionListLookupSession } from '@/sync/domains/session/listing/sessionListLookupState';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readStoredSessionTranscriptForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getAppliedActiveServerId } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readSessionSynopses } from './sessionSynopsis';

/** Caller first acquires current Session access through the ordinary by-id Action reader. */
export async function readSessionRecapForAddress(address: SessionAddress, signal?: AbortSignal): Promise<SessionRecapState> {
    const unavailable = { status: 'unavailable', recap: null } as const;
    const lifetime = captureActiveServerAccountScopeLifetime();
    const activeServerId = getAppliedActiveServerId();
    const focused = areServerProfileIdentifiersEquivalent(activeServerId, address.serverId);
    if (focused && !lifetime?.isCurrent()) return unavailable;
    const state = storage.getState();
    const raw = state.sessions[address.sessionId];
    const session = raw && areServerProfileIdentifiersEquivalent(raw.serverId ?? activeServerId, address.serverId)
        ? raw : findSessionListLookupSession(state, address)?.session;
    if (!session || !isSessionContentReadable(readSessionContentAvailability(session))) return unavailable;
    const memoryEnabled = readSessionMemoryEnabledV1(readSessionOwnerMetadataView(session));
    signal?.throwIfAborted();
    const synopsis = memoryEnabled ? await readSessionSynopses(address) : { status: 'ready' as const, synopses: [] };
    signal?.throwIfAborted();
    if (focused && !lifetime?.isCurrent()) return unavailable;
    const synopsisRecap = resolveSessionRecap({ memoryEnabled, synopses: synopsis.synopses, latestWorkerUpdate: null });
    if (synopsisRecap) return { status: 'ready', recap: synopsisRecap };
    const transcript = readStoredSessionTranscriptForAddress(storage.getState(), address, { activeServerId });
    const pointer = transcript?.latestWorkerUpdates?.latestMessage;
    const message = pointer ? transcript?.messagesById[pointer.messageId] : null;
    const update = message?.kind === 'agent-event' && message.event.type === 'worker-update' ? message.event.update : null;
    return resolveSessionRecapState({ contentReadable: true, memoryEnabled, synopses: synopsis.synopses,
        synopsisStatus: synopsis.status, transcriptLoaded: transcript?.isLoaded ?? false,
        latestWorkerUpdate: update && message ? { headline: describeWorkerUpdateHeadline(update), body: update.result,
            atMs: message.createdAt, workerSessionId: update.workerKind === 'session' ? update.workerId : null } : null });
}
