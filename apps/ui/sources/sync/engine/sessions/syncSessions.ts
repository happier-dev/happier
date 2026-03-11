import type { NormalizedMessage, RawRecord } from '@/sync/typesRaw';
import { normalizeRawMessage } from '@/sync/typesRaw';
import { computeNextSessionSeqFromUpdate } from '@/sync/domains/session/sequence/realtimeSessionSeq';
import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import { computeNextReadStateV1 } from '@/sync/domains/state/readStateV1';
import type { ApiMessage, ApiSessionMessagesResponse } from '@/sync/api/types/apiTypes';
import { ApiSessionMessagesResponseSchema } from '@/sync/api/types/apiTypes';
import { storage } from '@/sync/domains/state/storage';
import type { Encryption } from '@/sync/encryption/encryption';
import { nowServerMs } from '@/sync/runtime/time';
import { getTaskLifecycleEventFromRawContent, type TaskLifecycleEvent } from './taskLifecycle';
import { parsePlainSessionAgentState, parsePlainSessionMetadata } from './parsePlainSessionPayload';
export { handleNewMessageSocketUpdate } from './sessionSocketUpdate';
export { handleMessageUpdatedSocketUpdate } from './sessionSocketUpdate';
export { fetchAndApplySessions } from './sessionSnapshot';
export type { SessionListEncryption } from './sessionSnapshot';

type SessionEncryption = {
    decryptAgentState: (version: number, value: string | null) => Promise<any>;
    decryptMetadata: (version: number, value: string) => Promise<any>;
};

export function handleDeleteSessionSocketUpdate(params: {
    sessionId: string;
    deleteSession: (sessionId: string) => void;
    removeSessionEncryption: (sessionId: string) => void;
    removeProjectManagerSession: (sessionId: string) => void;
    clearScmStatusForSession: (sessionId: string) => void;
    log: { log: (message: string) => void };
}) {
    const { sessionId, deleteSession, removeSessionEncryption, removeProjectManagerSession, clearScmStatusForSession, log } = params;

    // Remove session from storage
    deleteSession(sessionId);

    // Remove encryption keys from memory
    removeSessionEncryption(sessionId);

    // Remove from project manager
    removeProjectManagerSession(sessionId);

    // Clear any cached git status
    clearScmStatusForSession(sessionId);

    log.log(`🗑️ Session ${sessionId} deleted from local storage`);
}

export async function buildUpdatedSessionFromSocketUpdate(params: {
    session: Session;
    updateBody: any;
    updateSeq: number;
    updateCreatedAt: number;
    sessionEncryption: SessionEncryption | null;
}): Promise<{ nextSession: Session; agentState: any }> {
    const { session, updateBody, updateSeq, updateCreatedAt, sessionEncryption } = params;

    const encryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    if (encryptionMode === 'e2ee' && !sessionEncryption) {
        throw new Error(`Session encryption not found for ${session.id}`);
    }

    const agentState = updateBody.agentState
        ? encryptionMode === 'plain'
            ? parsePlainSessionAgentState(updateBody.agentState.value)
            : await sessionEncryption!.decryptAgentState(updateBody.agentState.version, updateBody.agentState.value)
        : session.agentState;

    const metadata = updateBody.metadata
        ? encryptionMode === 'plain'
            ? parsePlainSessionMetadata(updateBody.metadata.value)
            : await sessionEncryption!.decryptMetadata(updateBody.metadata.version, updateBody.metadata.value)
        : session.metadata;

    const nextSession: Session = {
        ...session,
        encryptionMode,
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
    scope?: 'main' | 'sidechain' | 'all';
    sidechainId?: string | null;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    isSessionKnown?: (sessionId: string) => boolean;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: Map<string, Map<string, number>>;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onTaskLifecycleEvent?: (event: TaskLifecycleEvent) => void;
    markMessagesLoaded: (sessionId: string) => void;
    onMessagesPage?: (page: ApiSessionMessagesResponse) => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const { sessionId, getSessionEncryption, request, sessionReceivedMessages, applyMessages, markMessagesLoaded, log } =
        params;

    log.log(`💬 fetchMessages starting for session ${sessionId} - acquiring lock`);

    const DEBUG_MESSAGE_DECRYPT =
        typeof globalThis !== 'undefined'
        && (
            (globalThis as any).__HAPPIER_DEBUG_MESSAGE_DECRYPT__ === true
            || (typeof localStorage !== 'undefined' && localStorage.getItem('happier.debug.messageDecrypt') === '1')
        );

    // Get encryption - may not be ready yet if session was just created
    // Throwing an error triggers backoff retry in InvalidateSync
    const encryption = getSessionEncryption(sessionId);
    if (!encryption) {
        if (params.isSessionKnown?.(sessionId) === false) {
            log.log(`💬 fetchMessages: Session ${sessionId} is not known on this server; skipping message fetch`);
            return;
        }
        log.log(`💬 fetchMessages: Session encryption not ready for ${sessionId}, will retry`);
        throw new Error(`Session encryption not ready for ${sessionId}`);
    }

    // Request (apiSocket.request calibrates server time best-effort from the HTTP Date header)
    const scope = params.scope ?? 'main';
    const sidechainId = typeof params.sidechainId === 'string' && params.sidechainId.trim().length > 0 ? params.sidechainId.trim() : null;
    if (scope === 'sidechain' && sidechainId === null) {
        throw new Error('fetchMessages: sidechainId is required when scope=sidechain');
    }
    const qs = new URLSearchParams();
    if (scope !== 'all') {
        qs.set('scope', scope);
    } else {
        qs.set('scope', 'all');
    }
    if (scope === 'sidechain' && sidechainId) {
        qs.set('sidechainId', sidechainId);
    }
    const response = await request(`/v1/sessions/${sessionId}/messages?${qs.toString()}`);
    const json = await response.json();
    const parsed = ApiSessionMessagesResponseSchema.safeParse(json);
    if (!parsed.success) {
        throw new Error(`Invalid /messages response: ${parsed.error.message}`);
    }
    const data = parsed.data;
    params.onMessagesPage?.(data);

    // Collect existing messages
    let existingMessages = sessionReceivedMessages.get(sessionId);
    if (!existingMessages) {
        existingMessages = new Map<string, number>();
        sessionReceivedMessages.set(sessionId, existingMessages);
    }

    // Decrypt and normalize messages
    const normalizedMessages: NormalizedMessage[] = [];

    // Filter out existing messages and prepare for batch decryption
    const messagesToDecrypt: ApiMessage[] = [];
    for (const msg of [...data.messages].reverse()) {
        const msgUpdatedAt = typeof msg.updatedAt === 'number' ? msg.updatedAt : msg.createdAt;
        const existingUpdatedAt = existingMessages.get(msg.id);
        if (existingUpdatedAt === undefined || msgUpdatedAt > existingUpdatedAt) {
            messagesToDecrypt.push(msg);
        }
    }

    // Batch decrypt all messages at once
    const decryptedMessages = await encryption.decryptMessages(messagesToDecrypt);

    // Process decrypted messages
    const debugDecryptStats = DEBUG_MESSAGE_DECRYPT
        ? {
            fetched: data.messages.length,
            toDecrypt: messagesToDecrypt.length,
            decryptedEntries: decryptedMessages.length,
            decryptedWithContent: 0,
            normalized: 0,
        }
        : null;

    for (let i = 0; i < decryptedMessages.length; i++) {
        const decrypted = decryptedMessages[i];
        const inputMessage = messagesToDecrypt[i];
        const inputWasEncrypted = inputMessage?.content?.t === 'encrypted';
        if (decrypted) {
            if (debugDecryptStats && decrypted.content !== null) {
                debugDecryptStats.decryptedWithContent++;
            }

            const inputUpdatedAt = inputMessage
                ? (typeof inputMessage.updatedAt === 'number' ? inputMessage.updatedAt : inputMessage.createdAt)
                : decrypted.createdAt;
            // IMPORTANT: Do not mark encrypted messages as "received" when decryption failed.
            // Otherwise a keyless device (or a device with delayed key init) can permanently
            // treat encrypted history as empty until runtime state is fully reset.
            if (decrypted.content !== null || !inputWasEncrypted) {
                existingMessages.set(decrypted.id, inputUpdatedAt);
            }

            // Expected: encrypted history can be present even when this device lacks the secret key.
            // In that case decryption yields null and we must not attempt to normalize/log it.
            if (inputWasEncrypted && decrypted.content === null) {
                continue;
            }

            const lifecycleEvent = getTaskLifecycleEventFromRawContent(decrypted.content, decrypted.createdAt);
            if (lifecycleEvent) {
                params.onTaskLifecycleEvent?.(lifecycleEvent);
            }
            // Normalize the decrypted message
            const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content, { seq: decrypted.seq ?? undefined });
            if (normalized) {
                const rawSidechainId = inputMessage?.sidechainId;
                if (typeof rawSidechainId === 'string' && rawSidechainId.trim().length > 0) {
                    normalized.sidechainId = rawSidechainId.trim();
                    normalized.isSidechain = true;
                }
                normalizedMessages.push(normalized);
            }
        }
    }

    if (debugDecryptStats) {
        debugDecryptStats.normalized = normalizedMessages.length;
        const sample = messagesToDecrypt[0];
        const sampleCipherPreview =
            sample && sample.content?.t === 'encrypted' && typeof sample.content.c === 'string'
                ? `${sample.content.c.slice(0, 24)}…(${sample.content.c.length})`
                : null;

        log.log(
            `[debug] fetchMessages decrypt stats for ${sessionId}: `
                + `fetched=${debugDecryptStats.fetched} `
                + `toDecrypt=${debugDecryptStats.toDecrypt} `
                + `decryptedWithContent=${debugDecryptStats.decryptedWithContent} `
                + `normalized=${debugDecryptStats.normalized}`
                + (sample ? ` sample={id:${sample.id} seq:${sample.seq} cipher:${sampleCipherPreview}}` : '')
        );
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
    scope?: 'main' | 'sidechain' | 'all';
    sidechainId?: string | null;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    isSessionKnown?: (sessionId: string) => boolean;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: Map<string, Map<string, number>>;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onTaskLifecycleEvent?: (event: TaskLifecycleEvent) => void;
    onMessagesPage?: (page: ApiSessionMessagesResponse) => void;
    onNormalizedMessages?: (messages: NormalizedMessage[]) => void;
    log: { log: (message: string) => void };
}): Promise<{ applied: number; page: ApiSessionMessagesResponse }> {
    const { sessionId, beforeSeq, limit, getSessionEncryption, request, sessionReceivedMessages, applyMessages, log } = params;

    // Get encryption - may not be ready yet if session was just created
    const encryption = getSessionEncryption(sessionId);
    if (!encryption) {
        if (params.isSessionKnown?.(sessionId) === false) {
            log.log(`💬 fetchOlderMessages: Session ${sessionId} is not known on this server; skipping page fetch`);
            return {
                applied: 0,
                page: {
                    messages: [],
                    hasMore: false,
                    nextBeforeSeq: null,
                },
            };
        }
        throw new Error(`Session encryption not ready for ${sessionId}`);
    }

    const scope = params.scope ?? 'main';
    const sidechainId = typeof params.sidechainId === 'string' && params.sidechainId.trim().length > 0 ? params.sidechainId.trim() : null;
    if (scope === 'sidechain' && sidechainId === null) {
        throw new Error('fetchOlderMessages: sidechainId is required when scope=sidechain');
    }

    const qs = new URLSearchParams({ beforeSeq: String(beforeSeq), limit: String(limit), scope });
    if (scope === 'sidechain' && sidechainId) {
        qs.set('sidechainId', sidechainId);
    }
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
        eixstingMessages = new Map<string, number>();
        sessionReceivedMessages.set(sessionId, eixstingMessages);
    }

    const messagesToDecrypt: ApiMessage[] = [];
    for (const msg of [...data.messages].reverse()) {
        const msgUpdatedAt = typeof msg.updatedAt === 'number' ? msg.updatedAt : msg.createdAt;
        const existingUpdatedAt = eixstingMessages.get(msg.id);
        if (existingUpdatedAt === undefined || msgUpdatedAt > existingUpdatedAt) {
            messagesToDecrypt.push(msg);
        }
    }

    const decryptedMessages = await encryption.decryptMessages(messagesToDecrypt);

    const normalizedMessages: NormalizedMessage[] = [];
    for (let i = 0; i < decryptedMessages.length; i++) {
        const decrypted = decryptedMessages[i];
        if (decrypted) {
            const inputMessage = messagesToDecrypt[i];
            const inputWasEncrypted = inputMessage?.content?.t === 'encrypted';

            const inputUpdatedAt = inputMessage
                ? (typeof inputMessage.updatedAt === 'number' ? inputMessage.updatedAt : inputMessage.createdAt)
                : decrypted.createdAt;
            if (decrypted.content !== null || !inputWasEncrypted) {
                eixstingMessages.set(decrypted.id, inputUpdatedAt);
            }
            if (inputWasEncrypted && decrypted.content === null) {
                continue;
            }
            // Older pages can include historical lifecycle markers (task_complete/turn_aborted) that
            // should not clobber current in-flight UI state. Lifecycle handling is reserved for
            // newer/socket flows.
            const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content, { seq: decrypted.seq ?? undefined });
            if (normalized) {
                const rawSidechainId = inputMessage?.sidechainId;
                if (typeof rawSidechainId === 'string' && rawSidechainId.trim().length > 0) {
                    normalized.sidechainId = rawSidechainId.trim();
                    normalized.isSidechain = true;
                }
                normalizedMessages.push(normalized);
            }
        }
    }

    params.onNormalizedMessages?.(normalizedMessages);
    applyMessages(sessionId, normalizedMessages);
    log.log(`💬 fetchOlderMessages completed for session ${sessionId} - applied ${normalizedMessages.length} messages`);
    return { applied: normalizedMessages.length, page: data };
}

export async function fetchAndApplyNewerMessages(params: {
    sessionId: string;
    afterSeq: number;
    limit: number;
    scope?: 'main' | 'sidechain' | 'all';
    sidechainId?: string | null;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
    isSessionKnown?: (sessionId: string) => boolean;
    request: (path: string) => Promise<Response>;
    sessionReceivedMessages: Map<string, Map<string, number>>;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onTaskLifecycleEvent?: (event: TaskLifecycleEvent) => void;
    onMessagesPage?: (page: ApiSessionMessagesResponse) => void;
    onNormalizedMessages?: (messages: NormalizedMessage[]) => void;
    log: { log: (message: string) => void };
}): Promise<{ applied: number; page: ApiSessionMessagesResponse }> {
    const { sessionId, afterSeq, limit, getSessionEncryption, request, sessionReceivedMessages, applyMessages, log } = params;

    const encryption = getSessionEncryption(sessionId);
    if (!encryption) {
        if (params.isSessionKnown?.(sessionId) === false) {
            log.log(`💬 fetchNewerMessages: Session ${sessionId} is not known on this server; skipping page fetch`);
            return {
                applied: 0,
                page: {
                    messages: [],
                    nextAfterSeq: null,
                },
            };
        }
        throw new Error(`Session encryption not ready for ${sessionId}`);
    }

    const scope = params.scope ?? 'main';
    const sidechainId = typeof params.sidechainId === 'string' && params.sidechainId.trim().length > 0 ? params.sidechainId.trim() : null;
    if (scope === 'sidechain' && sidechainId === null) {
        throw new Error('fetchNewerMessages: sidechainId is required when scope=sidechain');
    }

    const qs = new URLSearchParams({ afterSeq: String(afterSeq), limit: String(limit), scope });
    if (scope === 'sidechain' && sidechainId) {
        qs.set('sidechainId', sidechainId);
    }
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
        existingMessages = new Map<string, number>();
        sessionReceivedMessages.set(sessionId, existingMessages);
    }

    // Server returns ascending order in forward mode; decrypt/apply in that same order.
    const messagesToDecrypt: ApiMessage[] = [];
    for (const msg of data.messages) {
        const msgUpdatedAt = typeof msg.updatedAt === 'number' ? msg.updatedAt : msg.createdAt;
        const existingUpdatedAt = existingMessages.get(msg.id);
        if (existingUpdatedAt === undefined || msgUpdatedAt > existingUpdatedAt) {
            messagesToDecrypt.push(msg);
        }
    }

    const decryptedMessages = await encryption.decryptMessages(messagesToDecrypt);

    const normalizedMessages: NormalizedMessage[] = [];
    for (let i = 0; i < decryptedMessages.length; i++) {
        const decrypted = decryptedMessages[i];
        if (decrypted) {
            const inputMessage = messagesToDecrypt[i];
            const inputWasEncrypted = inputMessage?.content?.t === 'encrypted';

            const inputUpdatedAt = inputMessage
                ? (typeof inputMessage.updatedAt === 'number' ? inputMessage.updatedAt : inputMessage.createdAt)
                : decrypted.createdAt;
            if (decrypted.content !== null || !inputWasEncrypted) {
                existingMessages.set(decrypted.id, inputUpdatedAt);
            }
            if (inputWasEncrypted && decrypted.content === null) {
                continue;
            }
            const lifecycleEvent = getTaskLifecycleEventFromRawContent(decrypted.content, decrypted.createdAt);
            if (lifecycleEvent) {
                params.onTaskLifecycleEvent?.(lifecycleEvent);
            }
            const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content, { seq: decrypted.seq ?? undefined });
            if (normalized) {
                const rawSidechainId = inputMessage?.sidechainId;
                if (typeof rawSidechainId === 'string' && rawSidechainId.trim().length > 0) {
                    normalized.sidechainId = rawSidechainId.trim();
                    normalized.isSidechain = true;
                }
                normalizedMessages.push(normalized);
            }
        }
    }

    params.onNormalizedMessages?.(normalizedMessages);
    applyMessages(sessionId, normalizedMessages);
    log.log(`💬 fetchNewerMessages completed for session ${sessionId} - applied ${normalizedMessages.length} messages`);
    return { applied: normalizedMessages.length, page: data };
}
