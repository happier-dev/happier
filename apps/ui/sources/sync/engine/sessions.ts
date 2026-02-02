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
import { systemPrompt } from '../prompt/systemPrompt';
import { Platform } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { randomUUID } from '@/platform/randomUUID';
import { buildOutgoingMessageMeta } from '../messageMeta';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog';
import {
    deleteMessageQueueV1DiscardedItem,
    deleteMessageQueueV1Item,
    discardMessageQueueV1Item,
    enqueueMessageQueueV1Item,
    restoreMessageQueueV1DiscardedItem,
    updateMessageQueueV1Item,
} from '../messageQueueV1';
import { decodeMessageQueueV1ToPendingMessages, reconcilePendingMessagesFromMetadata } from '../messageQueueV1Pending';
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

type UpdateSessionMetadataWithRetry = (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;

export async function fetchAndApplyPendingMessages(params: {
    sessionId: string;
    encryption: Encryption;
}): Promise<void> {
    const { sessionId, encryption } = params;

    const sessionEncryption = encryption.getSessionEncryption(sessionId);
    if (!sessionEncryption) {
        storage.getState().applyPendingLoaded(sessionId);
        storage.getState().applyDiscardedPendingMessages(sessionId, []);
        return;
    }

    const session = storage.getState().sessions[sessionId];
    if (!session) {
        storage.getState().applyPendingLoaded(sessionId);
        storage.getState().applyDiscardedPendingMessages(sessionId, []);
        return;
    }

    const decoded = await decodeMessageQueueV1ToPendingMessages({
        messageQueueV1: session.metadata?.messageQueueV1,
        messageQueueV1Discarded: session.metadata?.messageQueueV1Discarded,
        decryptRaw: (encrypted) => sessionEncryption.decryptRaw(encrypted),
    });

    const existingPendingState = storage.getState().sessionPending[sessionId];
    const reconciled = reconcilePendingMessagesFromMetadata({
        messageQueueV1: session.metadata?.messageQueueV1,
        messageQueueV1Discarded: session.metadata?.messageQueueV1Discarded,
        decodedPending: decoded.pending,
        decodedDiscarded: decoded.discarded,
        existingPending: existingPendingState?.messages ?? [],
        existingDiscarded: existingPendingState?.discarded ?? [],
    });

    storage.getState().applyPendingMessages(sessionId, reconciled.pending);
    storage.getState().applyDiscardedPendingMessages(sessionId, reconciled.discarded);
}

export async function enqueuePendingMessage(params: {
    sessionId: string;
    text: string;
    displayText?: string;
    encryption: Encryption;
    updateSessionMetadataWithRetry: UpdateSessionMetadataWithRetry;
}): Promise<void> {
    const { sessionId, text, displayText, encryption, updateSessionMetadataWithRetry } = params;

    storage.getState().markSessionOptimisticThinking(sessionId);

    const sessionEncryption = encryption.getSessionEncryption(sessionId);
    if (!sessionEncryption) {
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw new Error(`Session ${sessionId} not found`);
    }

    const session = storage.getState().sessions[sessionId];
    if (!session) {
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw new Error(`Session ${sessionId} not found in storage`);
    }

    const permissionMode = session.permissionMode || 'default';
    const flavor = session.metadata?.flavor;
    const agentId = resolveAgentIdFromFlavor(flavor);
    const modelMode = session.modelMode || (agentId ? getAgentCore(agentId).model.defaultMode : 'default');
    const model = agentId && getAgentCore(agentId).model.supportsSelection && modelMode !== 'default' ? modelMode : undefined;

    const localId = randomUUID();

    let sentFrom: string;
    if (Platform.OS === 'web') {
        sentFrom = 'web';
    } else if (Platform.OS === 'android') {
        sentFrom = 'android';
    } else if (Platform.OS === 'ios') {
        sentFrom = isRunningOnMac() ? 'mac' : 'ios';
    } else {
        sentFrom = 'web';
    }

    const content: RawRecord = {
        role: 'user',
        content: {
            type: 'text',
            text,
        },
        meta: buildOutgoingMessageMeta({
            sentFrom,
            permissionMode: permissionMode || 'default',
            model,
            appendSystemPrompt: systemPrompt,
            displayText,
        }),
    };

    const createdAt = nowServerMs();
    const updatedAt = createdAt;
    const encryptedRawRecord = await sessionEncryption.encryptRawRecord(content);

    storage.getState().upsertPendingMessage(sessionId, {
        id: localId,
        localId,
        createdAt,
        updatedAt,
        text,
        displayText,
        rawRecord: content,
    });

    try {
        await updateSessionMetadataWithRetry(sessionId, (metadata) =>
            enqueueMessageQueueV1Item(metadata, {
                localId,
                message: encryptedRawRecord,
                createdAt,
                updatedAt,
            }),
        );
    } catch (e) {
        storage.getState().removePendingMessage(sessionId, localId);
        storage.getState().clearSessionOptimisticThinking(sessionId);
        throw e;
    }
}

export async function updatePendingMessage(params: {
    sessionId: string;
    pendingId: string;
    text: string;
    encryption: Encryption;
    updateSessionMetadataWithRetry: UpdateSessionMetadataWithRetry;
}): Promise<void> {
    const { sessionId, pendingId, text, encryption, updateSessionMetadataWithRetry } = params;

    const sessionEncryption = encryption.getSessionEncryption(sessionId);
    if (!sessionEncryption) {
        throw new Error(`Session ${sessionId} not found`);
    }

    const existing = storage.getState().sessionPending[sessionId]?.messages?.find((m) => m.id === pendingId);
    if (!existing) {
        throw new Error('Pending message not found');
    }

    const content: RawRecord = existing.rawRecord
        ? {
              ...(existing.rawRecord as any),
              content: {
                  type: 'text',
                  text,
              },
          }
        : {
              role: 'user',
              content: { type: 'text', text },
              meta: {
                  appendSystemPrompt: systemPrompt,
              },
          };

    const encryptedRawRecord = await sessionEncryption.encryptRawRecord(content);
    const updatedAt = nowServerMs();

    await updateSessionMetadataWithRetry(sessionId, (metadata) =>
        updateMessageQueueV1Item(metadata, {
            localId: pendingId,
            message: encryptedRawRecord,
            createdAt: existing.createdAt,
            updatedAt,
        }),
    );

    storage.getState().upsertPendingMessage(sessionId, {
        ...existing,
        text,
        updatedAt,
        rawRecord: content,
    });
}

export async function deletePendingMessage(params: {
    sessionId: string;
    pendingId: string;
    updateSessionMetadataWithRetry: UpdateSessionMetadataWithRetry;
}): Promise<void> {
    const { sessionId, pendingId, updateSessionMetadataWithRetry } = params;

    await updateSessionMetadataWithRetry(sessionId, (metadata) => deleteMessageQueueV1Item(metadata, pendingId));
    storage.getState().removePendingMessage(sessionId, pendingId);
}

export async function discardPendingMessage(params: {
    sessionId: string;
    pendingId: string;
    opts?: { reason?: 'switch_to_local' | 'manual' };
    updateSessionMetadataWithRetry: UpdateSessionMetadataWithRetry;
    encryption: Encryption;
}): Promise<void> {
    const { sessionId, pendingId, opts, updateSessionMetadataWithRetry, encryption } = params;

    const discardedAt = nowServerMs();
    await updateSessionMetadataWithRetry(sessionId, (metadata) =>
        discardMessageQueueV1Item(metadata, {
            localId: pendingId,
            discardedAt,
            discardedReason: opts?.reason ?? 'manual',
        }),
    );
    await fetchAndApplyPendingMessages({ sessionId, encryption });
}

export async function restoreDiscardedPendingMessage(params: {
    sessionId: string;
    pendingId: string;
    updateSessionMetadataWithRetry: UpdateSessionMetadataWithRetry;
    encryption: Encryption;
}): Promise<void> {
    const { sessionId, pendingId, updateSessionMetadataWithRetry, encryption } = params;

    await updateSessionMetadataWithRetry(sessionId, (metadata) =>
        restoreMessageQueueV1DiscardedItem(metadata, { localId: pendingId, now: nowServerMs() }),
    );
    await fetchAndApplyPendingMessages({ sessionId, encryption });
}

export async function deleteDiscardedPendingMessage(params: {
    sessionId: string;
    pendingId: string;
    updateSessionMetadataWithRetry: UpdateSessionMetadataWithRetry;
    encryption: Encryption;
}): Promise<void> {
    const { sessionId, pendingId, updateSessionMetadataWithRetry, encryption } = params;

    await updateSessionMetadataWithRetry(sessionId, (metadata) => deleteMessageQueueV1DiscardedItem(metadata, pendingId));
    await fetchAndApplyPendingMessages({ sessionId, encryption });
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
