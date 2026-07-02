import { logger } from '@/ui/logger';
import { buildDaemonInitialPromptLocalId } from '@/agent/runtime/daemonInitialPrompt';

import type { AgentState, Metadata, Update, UserMessage } from '../../../types';
import { handleSessionNewMessageUpdate } from '../../sessionNewMessageUpdate';
import { handleSessionStateUpdate } from '../../sessionStateUpdateHandling';
import type { KnownPendingQueueState } from '../../pendingQueueState';
import { extractAssistantTextSnapshotFromSessionContent } from '../../turns/extractAssistantTextSnapshot';
import type { TurnAssistantTextSnapshotStore } from '../../turns/assistantTextSnapshot';

export type SessionClientUpdateRuntime = Readonly<{
    handleUpdate: (data: Update, opts: { source: 'session-scoped' | 'user-scoped'; catchUpAfterSeq?: number; catchUpAfterSeqIsExplicit?: boolean }) => void;
    observeCommittedAck: (params: { seq: number; localId?: string | null; markAsUserMessage?: boolean }) => void;
    getLastObservedMessageSeq: () => number;
    setLastObservedMessageSeq: (value: number) => void;
    getLastObservedUserMessageSeq: () => number;
    getPendingWakeSeq: () => number;
}>;

function readMessageSeqFromUpdate(update: Update): number | null {
    const body = update.body;
    const bodyRecord = body && typeof body === 'object' && !Array.isArray(body)
        ? body as Record<string, unknown>
        : null;
    const messageRecord = bodyRecord?.message && typeof bodyRecord.message === 'object' && !Array.isArray(bodyRecord.message)
        ? bodyRecord.message as Record<string, unknown>
        : null;
    const seq = messageRecord?.seq;
    return typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : null;
}

function normalizeCatchUpAfterSeq(value: number | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : null;
}

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
        applyPendingQueueState: (state: KnownPendingQueueState) => boolean;
        getPendingMessages: () => UserMessage[];
        getPendingMessageCallback: () => ((message: UserMessage) => void) | null;
        getUserMessageCallbackAttachedAtMs: () => number | null;
        onConnectedServiceTurnLifecycleEvent?: (event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled') => void;
        emit: (event: string, payload?: unknown) => void;
        hasSelfEchoSuppressedLocalId: (localId: string) => boolean;
        hasAgentQueueEchoSuppressedLocalId: (localId: string) => boolean;
        markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
        hasPendingQueueMaterializedLocalId: (localId: string) => boolean;
        deleteMaterializedLocalId: (localId: string) => void;
        initialLastObservedMessageSeq: number;
        observeCommittedUserMessageSeq?: (params: { localId: string | null | undefined; seq: number }) => void;
        turnAssistantTextSnapshotStore?: TurnAssistantTextSnapshotStore;
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

                const body = data.body;
                const bodyRecord = body && typeof body === 'object' && !Array.isArray(body)
                    ? body as Record<string, unknown>
                    : null;
                const messageRecord = bodyRecord?.message && typeof bodyRecord.message === 'object' && !Array.isArray(bodyRecord.message)
                    ? bodyRecord.message as Record<string, unknown>
                    : null;
                if (
                    bodyRecord?.t === 'message-updated'
                    && bodyRecord.sid === deps.sessionId
                ) {
                    const updatedLocalId = typeof messageRecord?.localId === 'string'
                        ? messageRecord.localId
                        : null;
                    if (updatedLocalId && deps.hasSelfEchoSuppressedLocalId(updatedLocalId)) {
                        deps.deleteMaterializedLocalId(updatedLocalId);
                    }
                }
                if (
                    bodyRecord?.sid === deps.sessionId
                    && (bodyRecord.t === 'new-message' || bodyRecord.t === 'message-updated')
                    && messageRecord?.messageRole === 'user'
                    && typeof messageRecord.seq === 'number'
                    && Number.isFinite(messageRecord.seq)
                ) {
                    deps.observeCommittedUserMessageSeq?.({
                        localId: typeof messageRecord.localId === 'string' ? messageRecord.localId : null,
                        seq: messageRecord.seq,
                    });
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
                        const localId = typeof message.localId === 'string' ? message.localId.trim() : '';
                        if (message.meta?.source === 'daemon-initial-prompt') {
                            const expectedLocalId = buildDaemonInitialPromptLocalId(deps.sessionId);
                            return Boolean(expectedLocalId && localId === expectedLocalId);
                        }

                        const catchUpAfterSeq = normalizeCatchUpAfterSeq(opts.catchUpAfterSeq);
                        if (catchUpAfterSeq !== null && (opts.catchUpAfterSeqIsExplicit === true || catchUpAfterSeq > 0)) {
                            const msgSeq = readMessageSeqFromUpdate(update);
                            return msgSeq !== null && msgSeq > catchUpAfterSeq;
                        }

                        logger.warn('[DELIVERY-DECISION] catch-up user-message suppressed (no explicit authorization)', {
                            sessionId: deps.sessionId,
                            updateId: update?.id,
                            messageLocalId: localId || null,
                            catchUpAfterSeq,
                            catchUpAfterSeqIsExplicit: opts.catchUpAfterSeqIsExplicit,
                            callbackAttachedAtMs: deps.getUserMessageCallbackAttachedAtMs(),
                            messageCreatedAtMs: typeof (message as { createdAt?: unknown })?.createdAt === 'number'
                                ? (message as { createdAt: number }).createdAt
                                : null,
                        });
                        return false;
                    },
                    onConnectedServiceTurnLifecycleEvent: (event) => deps.onConnectedServiceTurnLifecycleEvent?.(event),
                    emit: (event, payload) => deps.emit(event, payload),
                    debug: (message, payload) => logger.debug(message, payload),
                    debugLargeJson: (message, payload) => logger.debugLargeJson(message, payload),
                    observeMessage: (message, seq) => {
                        const extracted = extractAssistantTextSnapshotFromSessionContent(message);
                        if (!extracted) return;
                        deps.turnAssistantTextSnapshotStore?.observe({
                            text: extracted.text,
                            provider: extracted.provider,
                            sidechainId: extracted.sidechainId,
                            seq,
                            localId: typeof (message as { localId?: unknown }).localId === 'string'
                                ? (message as { localId: string }).localId
                                : null,
                            source: 'socket',
                        });
                    },
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
                    if (stateUpdateResult.pendingQueueState) {
                        shouldEmitMetadataUpdated = deps.applyPendingQueueState(stateUpdateResult.pendingQueueState) || shouldEmitMetadataUpdated;
                    }
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
                deps.observeCommittedUserMessageSeq?.({
                    localId: params.localId,
                    seq: params.seq,
                });
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
