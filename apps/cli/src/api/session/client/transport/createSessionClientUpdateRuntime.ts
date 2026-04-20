import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

import type { AgentState, Metadata, Update, UserMessage } from '../../../types';
import { handleSessionNewMessageUpdate } from '../../sessionNewMessageUpdate';
import { handleSessionStateUpdate } from '../../sessionStateUpdateHandling';

export type SessionClientUpdateRuntime = Readonly<{
    handleUpdate: (data: Update, opts: { source: 'session-scoped' | 'user-scoped' }) => void;
    observeCommittedAck: (params: { seq: number; markAsUserMessage?: boolean }) => void;
    getLastObservedMessageSeq: () => number;
    setLastObservedMessageSeq: (value: number) => void;
    getLastObservedUserMessageSeq: () => number;
    getPendingWakeSeq: () => number;
}>;

export function createSessionClientUpdateRuntime(
    deps: Readonly<{
        sessionId: string;
        sessionEncryptionMode: 'e2ee' | 'plain';
        encryptionKey: Uint8Array;
        encryptionVariant: 'legacy' | 'dataKey';
        getMetadata: () => Metadata | null;
        setMetadata: (metadata: Metadata | null) => void;
        getMetadataVersion: () => number;
        setMetadataVersion: (version: number) => void;
        getAgentState: () => AgentState | null;
        setAgentState: (agentState: AgentState | null) => void;
        getAgentStateVersion: () => number;
        setAgentStateVersion: (version: number) => void;
        getPendingMessages: () => UserMessage[];
        getPendingMessageCallback: () => ((message: UserMessage) => void) | null;
        getUserMessageCallbackAttachedAtMs: () => number | null;
        emit: (event: string, payload?: unknown) => void;
        hasSelfEchoSuppressedLocalId: (localId: string) => boolean;
        hasAgentQueueEchoSuppressedLocalId: (localId: string) => boolean;
        markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
        hasPendingQueueMaterializedLocalId: (localId: string) => boolean;
        deleteMaterializedLocalId: (localId: string) => void;
        initialLastObservedMessageSeq: number;
    }>,
): SessionClientUpdateRuntime {
    const receivedMessageIds = new Set<string>();
    let lastObservedMessageSeq = deps.initialLastObservedMessageSeq;
    let lastObservedUserMessageSeq = 0;
    let pendingWakeSeq = 0;

    return {
        handleUpdate(data, opts) {
            try {
                logger.debugLargeJson(`[SOCKET] [UPDATE:${opts.source}] Received update:`, data);

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                    return;
                }

                if (
                    (data.body as any)?.t === 'message-updated'
                    && (data.body as any)?.sid === deps.sessionId
                ) {
                    const updatedLocalId = typeof (data.body as any)?.message?.localId === 'string'
                        ? (data.body as any).message.localId
                        : null;
                    if (updatedLocalId && deps.hasSelfEchoSuppressedLocalId(updatedLocalId)) {
                        deps.deleteMaterializedLocalId(updatedLocalId);
                    }
                }

                const newMessageHandlingResult = handleSessionNewMessageUpdate({
                    update: data,
                    sessionId: deps.sessionId,
                    encryptionKey: deps.encryptionKey,
                    encryptionVariant: deps.encryptionVariant,
                    receivedMessageIds,
                    lastObservedMessageSeq,
                    lastObservedUserMessageSeq,
                    hasSelfEchoSuppressedLocalId: (localId) => deps.hasSelfEchoSuppressedLocalId(localId),
                    hasAgentQueueEchoSuppressedLocalId: (localId) => deps.hasAgentQueueEchoSuppressedLocalId(localId),
                    markAgentQueueEchoSuppressedLocalId: (localId) => deps.markAgentQueueEchoSuppressedLocalId(localId),
                    hasPendingQueueMaterializedLocalId: (localId) => deps.hasPendingQueueMaterializedLocalId(localId),
                    deleteMaterializedLocalId: (localId) => deps.deleteMaterializedLocalId(localId),
                    pendingMessageCallback: deps.getPendingMessageCallback(),
                    pendingMessages: deps.getPendingMessages(),
                    shouldDeliverUserMessageToAgentQueue: (message, update) => {
                        if (!update?.id?.startsWith('catchup-')) return true;
                        if (message.meta?.source === 'daemon-initial-prompt') return true;
                        if (lastObservedMessageSeq > 0) return true;

                        const attachedAtMs = deps.getUserMessageCallbackAttachedAtMs();
                        if (typeof attachedAtMs !== 'number' || !Number.isFinite(attachedAtMs)) return true;
                        const lookbackMs = configuration.startupTranscriptCatchUpLookbackMs;
                        if (typeof lookbackMs !== 'number' || !Number.isFinite(lookbackMs) || lookbackMs < 0) return true;
                        const createdAtMs = typeof (message as any).createdAt === 'number' ? (message as any).createdAt : null;
                        if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs)) return true;
                        return createdAtMs >= attachedAtMs - lookbackMs;
                    },
                    emit: (event, payload) => deps.emit(event, payload),
                    debug: (message, payload) => logger.debug(message, payload),
                    debugLargeJson: (message, payload) => logger.debugLargeJson(message, payload),
                });
                if (newMessageHandlingResult.handled) {
                    lastObservedMessageSeq = newMessageHandlingResult.lastObservedMessageSeq;
                    lastObservedUserMessageSeq = Math.max(
                        lastObservedUserMessageSeq,
                        newMessageHandlingResult.lastObservedUserMessageSeq,
                    );
                    return;
                }

                let shouldEmitMetadataUpdated = false;
                const stateUpdateResult = handleSessionStateUpdate({
                    update: data,
                    updateSource: opts.source,
                    sessionId: deps.sessionId,
                    sessionEncryptionMode: deps.sessionEncryptionMode,
                    metadata: deps.getMetadata(),
                    metadataVersion: deps.getMetadataVersion(),
                    agentState: deps.getAgentState(),
                    agentStateVersion: deps.getAgentStateVersion(),
                    pendingWakeSeq,
                    encryptionKey: deps.encryptionKey,
                    encryptionVariant: deps.encryptionVariant,
                    onMetadataUpdated: () => {
                        shouldEmitMetadataUpdated = true;
                    },
                    onWarning: (message) => logger.debug(message),
                });
                if (stateUpdateResult.handled) {
                    deps.setMetadata(stateUpdateResult.metadata);
                    deps.setMetadataVersion(stateUpdateResult.metadataVersion);
                    deps.setAgentState(stateUpdateResult.agentState);
                    deps.setAgentStateVersion(stateUpdateResult.agentStateVersion);
                    pendingWakeSeq = stateUpdateResult.pendingWakeSeq;
                    if (shouldEmitMetadataUpdated) {
                        deps.emit('metadata-updated');
                    }
                    return;
                }

                deps.emit('message', data.body);
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error });
            }
        },

        observeCommittedAck(params) {
            lastObservedMessageSeq = Math.max(lastObservedMessageSeq, params.seq);
            if (params.markAsUserMessage === true) {
                lastObservedUserMessageSeq = Math.max(lastObservedUserMessageSeq, params.seq);
            }
        },

        getLastObservedMessageSeq() {
            return lastObservedMessageSeq;
        },

        setLastObservedMessageSeq(value) {
            lastObservedMessageSeq = value;
        },

        getLastObservedUserMessageSeq() {
            return lastObservedUserMessageSeq;
        },

        getPendingWakeSeq() {
            return pendingWakeSeq;
        },
    };
}
