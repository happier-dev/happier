import { logger } from '@/ui/logger';
import type { AgentState, Metadata, Update } from '../../../types';
import { handleSessionNewMessageUpdate } from '../../sessionNewMessageUpdate';
import { handleSessionStateUpdate } from '../../sessionStateUpdateHandling';
import type { KnownPendingQueueState, PendingQueueState } from '../../pendingQueueState';
import { extractAssistantTextSnapshotFromSessionContent } from '../../turns/extractAssistantTextSnapshot';
import type { TurnAssistantTextSnapshotStore } from '../../turns/assistantTextSnapshot';
import type { PendingQueueRuntimeActivityProjection } from '@/agent/runtime/session/input/pendingQueueDrainPolicy';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { ParticipantExecutionRunRecipientRoutingIdentityV1Schema } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import type { ParticipantExecutionRunRecipientRoutingIdentityV1 } from '@happier-dev/protocol';

export type SessionClientUpdateRuntime = Readonly<{
    handleUpdate: (data: Update, opts: {
        source: 'session-scoped' | 'user-scoped';
    }) => void;
    observeCommittedAck: (params: { seq: number; localId?: string | null; markAsUserMessage?: boolean; refreshAgentQueueEchoSuppression?: boolean }) => void;
    getLastObservedMessageSeq: () => number;
    setLastObservedMessageSeq: (value: number) => void;
    getLastObservedUserMessageSeq: () => number;
    getPendingWakeSeq: () => number;
}>;

export function createSessionClientUpdateRuntime(
    deps: Readonly<{
        getServerIdentityId: () => string | null | undefined;
        sessionId: string;
        getMetadataLayoutVersion?: () => number;
        getMetadata: () => Metadata | null;
        setMetadata: (metadata: Metadata | null) => void;
        getMetadataVersion: () => number;
        setMetadataVersion: (version: number) => void;
        getAgentState: () => AgentState | null;
        setAgentState: (agentState: AgentState | null) => void;
        getAgentStateVersion: () => number;
        setAgentStateVersion: (version: number) => void;
        syncMetadataEnvelopeTupleFromServer?: () => Promise<void>;
        getPendingQueueState?: () => PendingQueueState;
        applyPendingQueueState: (state: KnownPendingQueueState) => boolean;
        onPendingChangedDrainTrigger?: (
            state: KnownPendingQueueState,
            recipient?: ParticipantExecutionRunRecipientRoutingIdentityV1,
            observedPendingVersion?: number,
        ) => void;
        onConnectedServiceTurnLifecycleEvent?: (event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled') => void;
        emit: (event: string, payload?: unknown) => void;
        markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
        initialLastObservedMessageSeq: number;
        observeCommittedUserMessageSeq?: (params: { localId: string | null | undefined; seq: number }) => void;
        consumeLocallyAuthoredTranscriptObservationLocalId?: (localId: string) => boolean;
        turnAssistantTextSnapshotStore?: TurnAssistantTextSnapshotStore;
        onRuntimeActivityProjectionFromServer?: (projection: PendingQueueRuntimeActivityProjection) => void;
        onArchivedAtFromServer?: (archivedAt: number | null) => void;
    }> & SessionStoredContentCryptoContext,
): SessionClientUpdateRuntime {
    const receivedMessageIds = new Set<string>();
    let lastObservedMessageSeq = deps.initialLastObservedMessageSeq;
    // Own-write acks above a seq this client has not seen. The watermark crosses
    // them only through a contiguous run, so a foreign row in a gap still reads.
    const ownAckedSeqsAhead = new Set<number>();
    const advanceThroughOwnAcks = () => {
        while (ownAckedSeqsAhead.delete(lastObservedMessageSeq + 1)) lastObservedMessageSeq += 1;
        for (const seq of ownAckedSeqsAhead) if (seq <= lastObservedMessageSeq) ownAckedSeqsAhead.delete(seq);
    };
    let lastObservedUserMessageSeq = 0;
    let pendingWakeSeq = 0;
    const latestExecutionRunPendingWakeVersion = new Map<string, number>();

    return {
        handleUpdate(data, opts) {
            try {
                logger.debugLargeJson(`[SOCKET] [UPDATE:${opts.source}] Received update:`, data);

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                    return;
                }

                const body = data.body;
                if ((body.t === 'new-message' || body.t === 'message-updated')
                    && body.sid === deps.sessionId && body.delivery !== 'full') {
                    logger.warnLocalFile('[SOCKET] Session runtime requires full message delivery');
                    return;
                }
                const bodyRecord = body && typeof body === 'object' && !Array.isArray(body)
                    ? body as Record<string, unknown>
                    : null;
                const messageRecord = bodyRecord?.message && typeof bodyRecord.message === 'object' && !Array.isArray(bodyRecord.message)
                    ? bodyRecord.message as Record<string, unknown>
                    : null;
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
                    serverId: deps.getServerIdentityId(),
                    sessionId: deps.sessionId,
                    ...(deps.mode === 'plain'
                        ? { mode: 'plain' as const, ctx: null }
                        : { mode: 'e2ee' as const, ctx: deps.ctx }),
                    receivedMessageIds,
                    lastObservedMessageSeq,
                    lastObservedUserMessageSeq,
                    onConnectedServiceTurnLifecycleEvent: (event) => deps.onConnectedServiceTurnLifecycleEvent?.(event),
                    emit: (event, payload) => deps.emit(event, payload),
                    observeCommittedUserMessageSeq: (params) => deps.observeCommittedUserMessageSeq?.(params),
                    consumeLocallyAuthoredTranscriptObservationLocalId: (localId) =>
                        deps.consumeLocallyAuthoredTranscriptObservationLocalId?.(localId) === true,
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
                    if (ownAckedSeqsAhead.size > 0) advanceThroughOwnAcks();
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
                    metadataLayoutVersion: deps.getMetadataLayoutVersion?.() ?? 0,
                    ...(deps.mode === 'plain'
                        ? { mode: 'plain' as const, ctx: null }
                        : { mode: 'e2ee' as const, ctx: deps.ctx }),
                    metadata: deps.getMetadata(),
                    metadataVersion: deps.getMetadataVersion(),
                    agentState: deps.getAgentState(),
                    agentStateVersion: deps.getAgentStateVersion(),
                    pendingWakeSeq,
                    onMetadataUpdated: () => {
                        shouldEmitMetadataUpdated = true;
                    },
                    onMetadataEnvelopeTupleInvalidated: () => {
                        const refresh = deps.syncMetadataEnvelopeTupleFromServer;
                        if (!refresh) return;
                        void refresh().catch((error) => {
                            logger.debug('[SOCKET] Failed to refresh invalidated owner metadata tuple', {
                                error,
                            });
                        });
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
                    if (body.t === 'update-session' && body.id === deps.sessionId && body.archivedAt !== undefined) {
                        deps.onArchivedAtFromServer?.(body.archivedAt);
                    }
                    pendingWakeSeq = stateUpdateResult.pendingWakeSeq;
                    if (stateUpdateResult.pendingQueueState) {
                        shouldEmitMetadataUpdated = deps.applyPendingQueueState(stateUpdateResult.pendingQueueState) || shouldEmitMetadataUpdated;
                    }
                    if (pendingChangedDrainTrigger) {
                        const canonicalPendingQueueState = deps.getPendingQueueState?.()
                            ?? stateUpdateResult.pendingQueueState;
                        if (canonicalPendingQueueState?.known) {
                            const recipient = ParticipantExecutionRunRecipientRoutingIdentityV1Schema
                                .safeParse(bodyRecord?.recipient);
                            if (recipient.success) {
                                const observedPendingVersion = typeof bodyRecord?.pendingVersion === 'number'
                                    && Number.isInteger(bodyRecord.pendingVersion)
                                    && bodyRecord.pendingVersion >= 0
                                    ? bodyRecord.pendingVersion
                                    : canonicalPendingQueueState.pendingVersion;
                                const previousVersion = latestExecutionRunPendingWakeVersion.get(recipient.data.runId);
                                if (previousVersion === undefined || observedPendingVersion > previousVersion) {
                                    latestExecutionRunPendingWakeVersion.set(recipient.data.runId, observedPendingVersion);
                                    deps.onPendingChangedDrainTrigger?.(
                                        canonicalPendingQueueState,
                                        recipient.data,
                                        observedPendingVersion,
                                    );
                                }
                            } else {
                                deps.onPendingChangedDrainTrigger?.(canonicalPendingQueueState);
                            }
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

                if (body.t === 'update-session' && body.id === deps.sessionId && body.archivedAt !== undefined) {
                    deps.onArchivedAtFromServer?.(body.archivedAt);
                }
                deps.emit('message', data.body);
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error });
            }
        },

        observeCommittedAck(params) {
            if (Number.isSafeInteger(params.seq) && params.seq > lastObservedMessageSeq) {
                ownAckedSeqsAhead.add(params.seq);
                advanceThroughOwnAcks();
            }
            if (params.markAsUserMessage === true) {
                if (
                    params.refreshAgentQueueEchoSuppression === true
                    && typeof params.localId === 'string'
                    && params.localId.length > 0
                ) {
                    deps.markAgentQueueEchoSuppressedLocalId(params.localId);
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
            if (ownAckedSeqsAhead.size > 0) advanceThroughOwnAcks();
        },

        getLastObservedUserMessageSeq() {
            return lastObservedUserMessageSeq;
        },

        getPendingWakeSeq() {
            return pendingWakeSeq;
        },
    };
}
