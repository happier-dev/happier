import type { NormalizedMessage, RawRecord } from '../typesRaw';
import { normalizeRawMessage } from '../typesRaw';
import { computeNextSessionSeqFromUpdate } from '../realtimeSessionSeq';
import type { Session } from '../storageTypes';
import type { Metadata } from '../storageTypes';
import { computeNextReadStateV1 } from '../readStateV1';
import type { ApiMessage, ApiSessionMessagesResponse } from '../apiTypes';
import { ApiSessionMessagesResponseSchema } from '../apiTypes';
import { storage } from '../storage';
import type { Encryption } from '../encryption/encryption';
import { nowServerMs } from '../time';
export { handleNewMessageSocketUpdate } from './newMessageSocketUpdate';
export { fetchAndApplySessions } from './sessionsSnapshot';
export type { SessionListEncryption } from './sessionsSnapshot';

type SessionEncryption = {
    decryptAgentState: (version: number, value: string | null) => Promise<any>;
    decryptMetadata: (version: number, value: string) => Promise<any>;
};

export function handleDeleteSessionSocketUpdate(params: {
    sessionId: string;
    deleteSession: (sessionId: string) => void;
    removeSessionEncryption: (sessionId: string) => void;
    removeProjectManagerSession: (sessionId: string) => void;
    clearGitStatusForSession: (sessionId: string) => void;
    log: { log: (message: string) => void };
}) {
    const { sessionId, deleteSession, removeSessionEncryption, removeProjectManagerSession, clearGitStatusForSession, log } = params;

    // Remove session from storage
    deleteSession(sessionId);

    // Remove encryption keys from memory
    removeSessionEncryption(sessionId);

    // Remove from project manager
    removeProjectManagerSession(sessionId);

    // Clear any cached git status
    clearGitStatusForSession(sessionId);

    log.log(`🗑️ Session ${sessionId} deleted from local storage`);
}

export async function buildUpdatedSessionFromSocketUpdate(params: {
    session: Session;
    updateBody: any;
    updateSeq: number;
    updateCreatedAt: number;
    sessionEncryption: SessionEncryption;
}): Promise<{ nextSession: Session; agentState: any }> {
    const { session, updateBody, updateSeq, updateCreatedAt, sessionEncryption } = params;

    const agentState = updateBody.agentState
        ? await sessionEncryption.decryptAgentState(updateBody.agentState.version, updateBody.agentState.value)
        : session.agentState;

    const metadata = updateBody.metadata
        ? await sessionEncryption.decryptMetadata(updateBody.metadata.version, updateBody.metadata.value)
        : session.metadata;

    const nextSession: Session = {
        ...session,
        agentState,
        agentStateVersion: updateBody.agentState ? updateBody.agentState.version : session.agentStateVersion,
        metadata,
        metadataVersion: updateBody.metadata ? updateBody.metadata.version : session.metadataVersion,
        updatedAt: updateCreatedAt,
        seq: computeNextSessionSeqFromUpdate({
            currentSessionSeq: session.seq ?? 0,
            updateType: 'update-session',
            containerSeq: updateSeq,
            messageSeq: undefined,
        }),
    };

    return { nextSession, agentState };
}

export async function repairInvalidReadStateV1(params: {
    sessionId: string;
    sessionSeqUpperBound: number;
    attempted: Set<string>;
    inFlight: Set<string>;
    getSession: (sessionId: string) => { metadata?: Metadata | null } | undefined;
    updateSessionMetadataWithRetry: (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;
    now: () => number;
}): Promise<void> {
    const { sessionId, sessionSeqUpperBound, attempted, inFlight, getSession, updateSessionMetadataWithRetry, now } = params;

    if (attempted.has(sessionId) || inFlight.has(sessionId)) {
        return;
    }

    const session = getSession(sessionId);
    const readState = session?.metadata?.readStateV1;
    if (!readState) return;
    if (readState.sessionSeq <= sessionSeqUpperBound) return;

    attempted.add(sessionId);
    inFlight.add(sessionId);
    try {
        await updateSessionMetadataWithRetry(sessionId, (metadata) => {
            const prev = metadata.readStateV1;
            if (!prev) return metadata;
            if (prev.sessionSeq <= sessionSeqUpperBound) return metadata;

            const result = computeNextReadStateV1({
                prev,
                sessionSeq: sessionSeqUpperBound,
                pendingActivityAt: prev.pendingActivityAt,
                now: now(),
            });
            if (!result.didChange) return metadata;
            return { ...metadata, readStateV1: result.next };
        });
    } catch {
        // ignore
    } finally {
        inFlight.delete(sessionId);
    }
}

type SessionMessagesEncryption = {
    decryptMessages: (messages: ApiMessage[]) => Promise<any[]>;
};

export async function fetchAndApplyMessages(params: {
    sessionId: string;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: Map<string, Set<string>>;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    markMessagesLoaded: (sessionId: string) => void;
    onMessagesPage?: (page: ApiSessionMessagesResponse) => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const { sessionId, getSessionEncryption, request, sessionReceivedMessages, applyMessages, markMessagesLoaded, log } =
        params;

    log.log(`💬 fetchMessages starting for session ${sessionId} - acquiring lock`);

    // Get encryption - may not be ready yet if session was just created
    // Throwing an error triggers backoff retry in InvalidateSync
    const encryption = getSessionEncryption(sessionId);
    if (!encryption) {
        log.log(`💬 fetchMessages: Session encryption not ready for ${sessionId}, will retry`);
        throw new Error(`Session encryption not ready for ${sessionId}`);
    }

    // Request (apiSocket.request calibrates server time best-effort from the HTTP Date header)
    const response = await request(`/v1/sessions/${sessionId}/messages`);
    const json = await response.json();
    const parsed = ApiSessionMessagesResponseSchema.safeParse(json);
    if (!parsed.success) {
        throw new Error(`Invalid /messages response: ${parsed.error.message}`);
    }
    const data = parsed.data;
    params.onMessagesPage?.(data);

    // Collect existing messages
    let eixstingMessages = sessionReceivedMessages.get(sessionId);
    if (!eixstingMessages) {
        eixstingMessages = new Set<string>();
        sessionReceivedMessages.set(sessionId, eixstingMessages);
    }

    // Decrypt and normalize messages
    const normalizedMessages: NormalizedMessage[] = [];

    // Filter out existing messages and prepare for batch decryption
    const messagesToDecrypt: ApiMessage[] = [];
    for (const msg of [...data.messages].reverse()) {
        if (!eixstingMessages.has(msg.id)) {
            messagesToDecrypt.push(msg);
        }
    }

    // Batch decrypt all messages at once
    const decryptedMessages = await encryption.decryptMessages(messagesToDecrypt);

    // Process decrypted messages
    for (let i = 0; i < decryptedMessages.length; i++) {
        const decrypted = decryptedMessages[i];
        if (decrypted) {
            eixstingMessages.add(decrypted.id);
            // Normalize the decrypted message
            const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
            if (normalized) {
                normalizedMessages.push(normalized);
            }
        }
    }

    // Apply to storage
    applyMessages(sessionId, normalizedMessages);
    markMessagesLoaded(sessionId);
    log.log(`💬 fetchMessages completed for session ${sessionId} - processed ${normalizedMessages.length} messages`);
}

export async function fetchAndApplyOlderMessages(params: {
    sessionId: string;
    beforeSeq: number;
    limit: number;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: Map<string, Set<string>>;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onMessagesPage?: (page: ApiSessionMessagesResponse) => void;
    log: { log: (message: string) => void };
}): Promise<{ applied: number; page: ApiSessionMessagesResponse }> {
    const { sessionId, beforeSeq, limit, getSessionEncryption, request, sessionReceivedMessages, applyMessages, log } = params;

    // Get encryption - may not be ready yet if session was just created
    const encryption = getSessionEncryption(sessionId);
    if (!encryption) {
        throw new Error(`Session encryption not ready for ${sessionId}`);
    }

    const qs = new URLSearchParams({ beforeSeq: String(beforeSeq), limit: String(limit) });
    const response = await request(`/v1/sessions/${sessionId}/messages?${qs.toString()}`);
    const json = await response.json();
    const parsed = ApiSessionMessagesResponseSchema.safeParse(json);
    if (!parsed.success) {
        throw new Error(`Invalid /messages response: ${parsed.error.message}`);
    }
    const data = parsed.data;
    params.onMessagesPage?.(data);

    let eixstingMessages = sessionReceivedMessages.get(sessionId);
    if (!eixstingMessages) {
        eixstingMessages = new Set<string>();
        sessionReceivedMessages.set(sessionId, eixstingMessages);
    }

    const messagesToDecrypt: ApiMessage[] = [];
    for (const msg of [...data.messages].reverse()) {
        if (!eixstingMessages.has(msg.id)) {
            messagesToDecrypt.push(msg);
        }
    }

    const decryptedMessages = await encryption.decryptMessages(messagesToDecrypt);

    const normalizedMessages: NormalizedMessage[] = [];
    for (let i = 0; i < decryptedMessages.length; i++) {
        const decrypted = decryptedMessages[i];
        if (decrypted) {
            eixstingMessages.add(decrypted.id);
            const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
            if (normalized) {
                normalizedMessages.push(normalized);
            }
        }
    }

    applyMessages(sessionId, normalizedMessages);
    log.log(`💬 fetchOlderMessages completed for session ${sessionId} - applied ${normalizedMessages.length} messages`);
    return { applied: normalizedMessages.length, page: data };
}

export async function fetchAndApplyNewerMessages(params: {
    sessionId: string;
    afterSeq: number;
    limit: number;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: Map<string, Set<string>>;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onMessagesPage?: (page: ApiSessionMessagesResponse) => void;
    log: { log: (message: string) => void };
}): Promise<{ applied: number; page: ApiSessionMessagesResponse }> {
    const { sessionId, afterSeq, limit, getSessionEncryption, request, sessionReceivedMessages, applyMessages, log } = params;

    const encryption = getSessionEncryption(sessionId);
    if (!encryption) {
        throw new Error(`Session encryption not ready for ${sessionId}`);
    }

    const qs = new URLSearchParams({ afterSeq: String(afterSeq), limit: String(limit) });
    const response = await request(`/v1/sessions/${sessionId}/messages?${qs.toString()}`);
    const json = await response.json();
    const parsed = ApiSessionMessagesResponseSchema.safeParse(json);
    if (!parsed.success) {
        throw new Error(`Invalid /messages response: ${parsed.error.message}`);
    }
    const data = parsed.data;
    params.onMessagesPage?.(data);

    let existingMessages = sessionReceivedMessages.get(sessionId);
    if (!existingMessages) {
        existingMessages = new Set<string>();
        sessionReceivedMessages.set(sessionId, existingMessages);
    }

    // Server returns ascending order in forward mode; decrypt/apply in that same order.
    const messagesToDecrypt: ApiMessage[] = [];
    for (const msg of data.messages) {
        if (!existingMessages.has(msg.id)) {
            messagesToDecrypt.push(msg);
        }
    }

    const decryptedMessages = await encryption.decryptMessages(messagesToDecrypt);

    const normalizedMessages: NormalizedMessage[] = [];
    for (let i = 0; i < decryptedMessages.length; i++) {
        const decrypted = decryptedMessages[i];
        if (decrypted) {
            existingMessages.add(decrypted.id);
            const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
            if (normalized) {
                normalizedMessages.push(normalized);
            }
        }
    }

    applyMessages(sessionId, normalizedMessages);
    log.log(`💬 fetchNewerMessages completed for session ${sessionId} - applied ${normalizedMessages.length} messages`);
    return { applied: normalizedMessages.length, page: data };
}
