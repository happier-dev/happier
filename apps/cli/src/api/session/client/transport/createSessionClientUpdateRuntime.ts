import { logger } from '@/ui/logger';
import { buildDaemonInitialPromptLocalId } from '@/agent/runtime/daemonInitialPrompt';
import { readSessionUserMessageDeliveryIntentMeta } from '@happier-dev/protocol';

import type { AgentState, Metadata, Update, UserMessage } from '../../../types';
import { handleSessionNewMessageUpdate } from '../../sessionNewMessageUpdate';
import { handleSessionStateUpdate } from '../../sessionStateUpdateHandling';
import type { KnownPendingQueueState, PendingQueueState } from '../../pendingQueueState';
import { extractAssistantTextSnapshotFromSessionContent } from '../../turns/extractAssistantTextSnapshot';
import type { TurnAssistantTextSnapshotStore } from '../../turns/assistantTextSnapshot';
import type { PendingMaterializationActiveTurnPolicy } from '../../pendingMaterializationActiveTurnPolicy';
import { blocksPendingMaterializationDuringActiveTurn } from '../../pendingMaterializationActiveTurnPolicy';
import {
    isActiveLatestTurnStatus,
    type LatestTurnStatusSnapshot,
} from '../../sessionTurnStatusSnapshot';
import type { PendingQueueRuntimeActivityProjection } from '@/agent/runtime/session/input/pendingQueueDrainPolicy';
import type { SessionCatchUpAuthorization } from '../../sessionChangesSyncOnConnect';

export type SessionClientUpdateRuntime = Readonly<{
    handleUpdate: (data: Update, opts: {
        source: 'session-scoped' | 'user-scoped';
        catchUpAfterSeq?: number;
        catchUpAuthorization?: SessionCatchUpAuthorization;
        pendingMaterializationActiveTurnPolicy?: PendingMaterializationActiveTurnPolicy;
    }) => void;
    observeCommittedAck: (params: { seq: number; localId?: string | null; markAsUserMessage?: boolean; refreshAgentQueueEchoSuppression?: boolean }) => void;
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

function normalizeDeliveredUserMessageSeq(value: unknown): number | null {
    return Number.isSafeInteger(value) && (value as number) >= 0
        ? value as number
        : null;
}

function isExplicitCatchUpAuthorization(authorization: SessionCatchUpAuthorization | undefined): boolean {
    return authorization === 'explicit_cursor';
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
        getLatestTurnStatus: () => LatestTurnStatusSnapshot | undefined;
        getPendingQueueState?: () => PendingQueueState;
        applyPendingQueueState: (state: KnownPendingQueueState) => boolean;
        onPendingChangedDrainTrigger?: (state: KnownPendingQueueState) => void;
        getPendingMessages: () => UserMessage[];
        getPendingMessageCallback: () => ((message: UserMessage) => boolean | void) | null;
        getUserMessageCallbackAttachedAtMs: () => number | null;
        onConnectedServiceTurnLifecycleEvent?: (event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled') => void;
        emit: (event: string, payload?: unknown) => void;
        hasSelfEchoSuppressedLocalId: (localId: string) => boolean;
        hasAgentQueueEchoSuppressedLocalId: (localId: string) => boolean;
        hasAgentQueueDeliveredLocalId: (localId: string) => boolean;
        hasCanonicalPendingDeliveryLocalId: (localId: string) => boolean;
        markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
        markAgentQueueDeliveredLocalId: (localId: string) => void;
        clearAgentQueueEchoSuppressedLocalId: (localId: string) => void;
        clearAgentQueueDeliveredLocalId: (localId: string) => void;
        hasPendingQueueMaterializedLocalId: (localId: string) => boolean;
        deleteMaterializedLocalId: (localId: string) => void;
        initialLastObservedMessageSeq: number;
        observeCommittedUserMessageSeq?: (params: { localId: string | null | undefined; seq: number }) => void;
        onUserMessageDeliveredToAgentQueue?: (seq: number) => void;
        onUserMessageDeliveryProvenByLocalEcho?: (seq: number) => void;
        getDeliveredUserMessageSeq?: () => number | null;
        turnAssistantTextSnapshotStore?: TurnAssistantTextSnapshotStore;
        onRuntimeActivityProjectionFromServer?: (projection: PendingQueueRuntimeActivityProjection) => void;
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
                    && bodyRecord.t === 'message-updated'
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
                    hasAgentQueueDeliveredLocalId: (localId) => deps.hasAgentQueueDeliveredLocalId(localId),
                    markAgentQueueEchoSuppressedLocalId: (localId) => deps.markAgentQueueEchoSuppressedLocalId(localId),
                    markAgentQueueDeliveredLocalId: (localId) => deps.markAgentQueueDeliveredLocalId(localId),
                    clearAgentQueueEchoSuppressedLocalId: (localId) => deps.clearAgentQueueEchoSuppressedLocalId(localId),
                    clearAgentQueueDeliveredLocalId: (localId) => deps.clearAgentQueueDeliveredLocalId(localId),
                    hasPendingQueueMaterializedLocalId: (localId) => deps.hasPendingQueueMaterializedLocalId(localId),
                    deleteMaterializedLocalId: (localId) => deps.deleteMaterializedLocalId(localId),
                    pendingMessageCallback: deps.getPendingMessageCallback(),
                    pendingMessages: deps.getPendingMessages(),
                    shouldDeliverUserMessageToAgentQueue: (message, update) => {
                        const isCatchUpUpdate = update?.id?.startsWith('catchup-') === true;
                        const msgSeq = readMessageSeqFromUpdate(update);
                        const deliveredWatermark = normalizeDeliveredUserMessageSeq(deps.getDeliveredUserMessageSeq?.());
                        if (deliveredWatermark !== null && msgSeq !== null && msgSeq <= deliveredWatermark) {
                            logger.debug('[DELIVERY-DECISION] user-message skipped below delivered watermark', {
                                sessionId: deps.sessionId,
                                updateId: update?.id,
                                messageLocalId: typeof message.localId === 'string' ? message.localId : null,
                                msgSeq,
                                deliveredWatermark,
                                catchUpAfterSeq: normalizeCatchUpAfterSeq(opts.catchUpAfterSeq),
                                catchUpAuthorization: opts.catchUpAuthorization ?? null,
                            });
                            return false;
                        }
                        if (
                            readSessionUserMessageDeliveryIntentMeta(message.meta) === 'explicit_pending'
                            && !isExplicitCatchUpAuthorization(opts.catchUpAuthorization)
                            && blocksPendingMaterializationDuringActiveTurn(opts.pendingMaterializationActiveTurnPolicy)
                            && isActiveLatestTurnStatus(deps.getLatestTurnStatus())
                        ) {
                            logger.debug('[DELIVERY-DECISION] explicit-pending user-message held during active turn', {
                                sessionId: deps.sessionId,
                                updateId: update?.id,
                                messageLocalId: typeof message.localId === 'string' ? message.localId : null,
                                catchUpAfterSeq: normalizeCatchUpAfterSeq(opts.catchUpAfterSeq),
                                catchUpAuthorization: opts.catchUpAuthorization ?? null,
                            });
                            return false;
                        }
                        if (!isCatchUpUpdate) return true;
                        const localId = typeof message.localId === 'string' ? message.localId.trim() : '';
                        if (localId && deps.hasCanonicalPendingDeliveryLocalId(localId)) {
                            logger.debug('[DELIVERY-DECISION] catch-up user-message suppressed (canonical pending delivery owns row)', {
                                sessionId: deps.sessionId,
                                updateId: update?.id,
                                messageLocalId: localId,
                                catchUpAfterSeq: normalizeCatchUpAfterSeq(opts.catchUpAfterSeq),
                                catchUpAuthorization: opts.catchUpAuthorization ?? null,
                            });
                            return false;
                        }
                        if (message.meta?.source === 'daemon-initial-prompt') {
                            const expectedLocalId = buildDaemonInitialPromptLocalId(deps.sessionId);
                            return Boolean(expectedLocalId && localId === expectedLocalId);
                        }

                        const catchUpAfterSeq = normalizeCatchUpAfterSeq(opts.catchUpAfterSeq);
                        if (catchUpAfterSeq !== null && (isExplicitCatchUpAuthorization(opts.catchUpAuthorization) || catchUpAfterSeq > 0)) {
                            return msgSeq !== null && msgSeq > catchUpAfterSeq;
                        }

                        logger.warn('[DELIVERY-DECISION] catch-up user-message suppressed (no explicit authorization)', {
                            sessionId: deps.sessionId,
                            updateId: update?.id,
                            messageLocalId: localId || null,
                            catchUpAfterSeq,
                            catchUpAuthorization: opts.catchUpAuthorization ?? null,
                            callbackAttachedAtMs: deps.getUserMessageCallbackAttachedAtMs(),
                            messageCreatedAtMs: typeof (message as { createdAt?: unknown })?.createdAt === 'number'
                                ? (message as { createdAt: number }).createdAt
                                : null,
                        });
                        return false;
                    },
                    shouldResolveSkippedUserMessage: (_message, update) => {
                        const msgSeq = readMessageSeqFromUpdate(update);
                        const deliveredWatermark = normalizeDeliveredUserMessageSeq(deps.getDeliveredUserMessageSeq?.());
                        return deliveredWatermark !== null && msgSeq !== null && msgSeq <= deliveredWatermark;
                    },
                    onUserMessageDeliveredToAgentQueue: (seq) => deps.onUserMessageDeliveredToAgentQueue?.(seq),
                    // Conditional: an always-present wrapper would defeat the legacy fallback to
                    // the queue-handoff hook inside handleSessionNewMessageUpdate.
                    ...(deps.onUserMessageDeliveryProvenByLocalEcho
                        ? { onUserMessageDeliveryProvenByLocalEcho: deps.onUserMessageDeliveryProvenByLocalEcho }
                        : {}),
                    onConnectedServiceTurnLifecycleEvent: (event) => deps.onConnectedServiceTurnLifecycleEvent?.(event),
                    emit: (event, payload) => deps.emit(event, payload),
                    observeCommittedUserMessageSeq: (params) => deps.observeCommittedUserMessageSeq?.(params),
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
                let pendingChangedDrainTrigger: KnownPendingQueueState | null = null;
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
                    onPendingChangedDrainTrigger: (state) => {
                        pendingChangedDrainTrigger = state;
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
                    if (pendingChangedDrainTrigger) {
                        const canonicalPendingQueueState = deps.getPendingQueueState?.()
                            ?? stateUpdateResult.pendingQueueState;
                        if (canonicalPendingQueueState?.known) {
                            deps.onPendingChangedDrainTrigger?.(canonicalPendingQueueState);
                        }
                    }
                    if (stateUpdateResult.runtimeActivityProjection) {
                        deps.onRuntimeActivityProjectionFromServer?.(stateUpdateResult.runtimeActivityProjection);
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
                if (
                    params.refreshAgentQueueEchoSuppression === true
                    && typeof params.localId === 'string'
                    && params.localId.length > 0
                ) {
                    deps.markAgentQueueEchoSuppressedLocalId(params.localId);
                    deps.onUserMessageDeliveredToAgentQueue?.(params.seq);
                }
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
