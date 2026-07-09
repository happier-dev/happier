import { decodeBase64, decrypt } from '../encryption';
import type {
    Update,
    UserMessage,
} from '../types';
import { SessionMessageContentSchema, UserMessageSchema } from '../types';
import { coerceSessionUserPromptV1, RuntimeEventV1Schema } from '@happier-dev/protocol';
import { summarizeValueShapeForLog } from '@/diagnostics/eventShapeForLog';
import { detectSessionTurnLifecycleEvent } from '@/session/shared/sessionTurnLifecycle';

type ConnectedServiceTurnLifecycleEvent = 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';
type UserPromptCandidateDeliveryResult = Readonly<{ resolved: boolean }>;

function readCommittedUserMessageSeq(value: unknown): number | null {
    return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function readCommittedUserMessageLocalId(message: UserMessage, transportLocalId: string | null): string | null {
    if (transportLocalId) return transportLocalId;
    return typeof message.localId === 'string' && message.localId.trim().length > 0 ? message.localId : null;
}

function observeCommittedUserMessageSeq(params: Readonly<{
    message: UserMessage;
    transportLocalId: string | null;
    msgSeq: unknown;
    observe?: (params: { localId: string | null | undefined; seq: number }) => void;
}>): void {
    const seq = readCommittedUserMessageSeq(params.msgSeq);
    if (seq === null) return;
    params.observe?.({
        localId: readCommittedUserMessageLocalId(params.message, params.transportLocalId),
        seq,
    });
}

function deliverUserMessageToAgentQueue(params: Readonly<{
    message: UserMessage;
    pendingMessageCallback: ((message: UserMessage) => boolean | void) | null;
    pendingMessages: UserMessage[];
}>): boolean {
    if (params.pendingMessageCallback) {
        return params.pendingMessageCallback(params.message) !== false;
    }
    params.pendingMessages.push(params.message);
    return true;
}

function deliverUserPromptCandidate(params: Readonly<{
    message: UserMessage;
    update: Update;
    localId: string | null;
    msgSeq: unknown;
    isSelfEchoSuppressedLocalId: boolean;
    isAgentQueueEchoSuppressedLocalId: boolean;
    isAgentQueueDeliveredLocalId: boolean;
    isPendingQueueMaterializedLocalId: boolean;
    pendingMessageCallback: ((message: UserMessage) => boolean | void) | null;
    pendingMessages: UserMessage[];
    shouldDeliverUserMessageToAgentQueue?: (message: UserMessage, update: Update) => boolean;
    shouldResolveSkippedUserMessage?: (message: UserMessage, update: Update) => boolean;
    markMessageIdAsReceived: () => void;
    unmarkMessageIdAsReceived: () => void;
    markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    markAgentQueueDeliveredLocalId: (localId: string) => void;
    clearAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    clearAgentQueueDeliveredLocalId: (localId: string) => void;
    onUserMessageDeliveredToAgentQueue?: (seq: number) => void;
    onUserMessageDeliveryProvenByLocalEcho?: (seq: number) => void;
    debug: (message: string, data?: unknown) => void;
    skippedDebugMessage: string;
}>): UserPromptCandidateDeliveryResult {
    const sentFrom = params.message.meta?.sentFrom;
    const source = params.message.meta?.source;
    const finiteMsgSeq = typeof params.msgSeq === 'number' && Number.isFinite(params.msgSeq)
        ? params.msgSeq
        : null;
    const isSelfEchoSuppressedCliWrite =
        params.isSelfEchoSuppressedLocalId && source === 'cli';
    const isUncommittedPendingQueueMaterialization =
        params.isPendingQueueMaterializedLocalId && finiteMsgSeq === null;
    const shouldRespectAgentQueueEchoSuppression =
        params.isAgentQueueDeliveredLocalId && !isUncommittedPendingQueueMaterialization;
    const isEffectivelyAgentQueueEchoSuppressedLocalId =
        shouldRespectAgentQueueEchoSuppression && params.isAgentQueueEchoSuppressedLocalId;
    const shouldDeliverToAgentQueue =
        (!params.isAgentQueueDeliveredLocalId || isUncommittedPendingQueueMaterialization)
        && !isEffectivelyAgentQueueEchoSuppressedLocalId
        && !isSelfEchoSuppressedCliWrite
        && (params.shouldDeliverUserMessageToAgentQueue?.(params.message, params.update) ?? true);
    const isResolvedBySkippedDelivery =
        !shouldDeliverToAgentQueue
        && finiteMsgSeq !== null
        && (params.shouldResolveSkippedUserMessage?.(params.message, params.update) ?? false);

    if (shouldDeliverToAgentQueue) {
        const hasAgentQueueCallback = params.pendingMessageCallback !== null;
        params.markMessageIdAsReceived();
        const markedLocalId = params.localId;
        if (markedLocalId) {
            params.markAgentQueueEchoSuppressedLocalId(markedLocalId);
            params.markAgentQueueDeliveredLocalId(markedLocalId);
        }
        let deliveredToAgentQueue: boolean;
        try {
            deliveredToAgentQueue = deliverUserMessageToAgentQueue({
                message: params.message,
                pendingMessageCallback: params.pendingMessageCallback,
                pendingMessages: params.pendingMessages,
            });
        } catch (error) {
            if (markedLocalId) {
                params.clearAgentQueueEchoSuppressedLocalId(markedLocalId);
                params.clearAgentQueueDeliveredLocalId(markedLocalId);
            }
            params.unmarkMessageIdAsReceived();
            throw error;
        }
        if (!deliveredToAgentQueue) {
            if (markedLocalId) {
                params.clearAgentQueueEchoSuppressedLocalId(markedLocalId);
                params.clearAgentQueueDeliveredLocalId(markedLocalId);
            }
            params.unmarkMessageIdAsReceived();
            return { resolved: false };
        }
        if (hasAgentQueueCallback && finiteMsgSeq !== null) {
            params.onUserMessageDeliveredToAgentQueue?.(finiteMsgSeq);
        }
        return { resolved: true };
    }

    // A provider-native CLI self echo proves local provider delivery; an agent-queue echo
    // only proves server commit, so keep it on the queue hook for deferred launchers.
    const isResolvedEchoSuppressedPrompt =
        finiteMsgSeq !== null
        && (isSelfEchoSuppressedCliWrite || isEffectivelyAgentQueueEchoSuppressedLocalId);
    if (isResolvedBySkippedDelivery) {
        params.markMessageIdAsReceived();
    }
    if (isSelfEchoSuppressedCliWrite && finiteMsgSeq !== null) {
        (params.onUserMessageDeliveryProvenByLocalEcho ?? params.onUserMessageDeliveredToAgentQueue)?.(finiteMsgSeq);
    } else if (isEffectivelyAgentQueueEchoSuppressedLocalId && finiteMsgSeq !== null) {
        params.onUserMessageDeliveredToAgentQueue?.(finiteMsgSeq);
    }
    if (isResolvedEchoSuppressedPrompt) {
        params.markMessageIdAsReceived();
    }
    params.debug(params.skippedDebugMessage, {
        source: source ?? null,
        sentFrom: sentFrom ?? null,
        localId: params.localId,
        isSelfEchoSuppressedLocalId: params.isSelfEchoSuppressedLocalId,
        isAgentQueueEchoSuppressedLocalId: params.isAgentQueueEchoSuppressedLocalId,
        isAgentQueueDeliveredLocalId: params.isAgentQueueDeliveredLocalId,
        isPendingQueueMaterializedLocalId: params.isPendingQueueMaterializedLocalId,
        isUncommittedPendingQueueMaterialization,
        isSelfEchoSuppressedCliWrite,
        shouldRespectAgentQueueEchoSuppression,
        isResolvedBySkippedDelivery,
    });
    return { resolved: isResolvedEchoSuppressedPrompt || isResolvedBySkippedDelivery };
}

function mapSessionTurnLifecycleToConnectedServiceEvent(value: unknown): ConnectedServiceTurnLifecycleEvent | null {
    const event = detectSessionTurnLifecycleEvent(value);
    if (event === 'task_started') return 'task_started';
    if (event === 'turn_cancelled') return 'turn_cancelled';
    if (event === 'task_complete' || event === 'turn_aborted' || event === 'turn_failed' || event === 'ready') {
        return 'assistant_message_end';
    }
    const runtimeEvent = RuntimeEventV1Schema.safeParse(value);
    if (runtimeEvent.success) {
        if (runtimeEvent.data.kind === 'turn-start') return 'prompt_or_steer';
        if (runtimeEvent.data.kind === 'turn-cancelled') return 'turn_cancelled';
        if (runtimeEvent.data.kind === 'turn-complete' || runtimeEvent.data.kind === 'turn-failed' || runtimeEvent.data.kind === 'session-ended') {
            return 'assistant_message_end';
        }
    }
    return null;
}

export function handleSessionNewMessageUpdate(params: {
    update: Update;
    sessionId: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    receivedMessageIds: Set<string>;
    lastObservedMessageSeq: number;
    lastObservedUserMessageSeq: number;
    hasSelfEchoSuppressedLocalId: (localId: string) => boolean;
    hasAgentQueueEchoSuppressedLocalId: (localId: string) => boolean;
    hasAgentQueueDeliveredLocalId?: (localId: string) => boolean;
    markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    markAgentQueueDeliveredLocalId?: (localId: string) => void;
    clearAgentQueueEchoSuppressedLocalId?: (localId: string) => void;
    clearAgentQueueDeliveredLocalId?: (localId: string) => void;
    hasPendingQueueMaterializedLocalId: (localId: string) => boolean;
    deleteMaterializedLocalId: (localId: string) => void;
    pendingMessageCallback: ((message: UserMessage) => boolean | void) | null;
    pendingMessages: UserMessage[];
    shouldDeliverUserMessageToAgentQueue?: (message: UserMessage, update: Update) => boolean;
    shouldResolveSkippedUserMessage?: (message: UserMessage, update: Update) => boolean;
    /**
     * Owed-delivery watermark hook: fired with the user row's seq when the row is handed to the
     * agent queue, or when a later agent-queue echo proves a locally handed prompt is committed.
     * Launchers with a provider-acceptance seam may defer persisting this leg until the provider
     * proves acceptance (HF-1).
     */
    onUserMessageDeliveredToAgentQueue?: (seq: number) => void;
    /**
     * Echo leg (HF-1 split): a local echo proves a provider-native terminal transcript row is no
     * longer owed to the runner without handing it through the queue in this update. Falls back to
     * the queue-handoff hook when unset (legacy single-hook callers).
     */
    onUserMessageDeliveryProvenByLocalEcho?: (seq: number) => void;
    onConnectedServiceTurnLifecycleEvent?: (event: ConnectedServiceTurnLifecycleEvent) => void;
    emit: (event: 'user-message' | 'message', payload: unknown) => void;
    observeMessage?: (message: unknown, seq: number | null) => void;
    observeCommittedUserMessageSeq?: (params: { localId: string | null | undefined; seq: number }) => void;
    debug: (message: string, data?: unknown) => void;
    debugLargeJson: (message: string, data: unknown) => void;
}): {
    handled: boolean;
    lastObservedMessageSeq: number;
    lastObservedUserMessageSeq: number;
} {
    if (params.update.body?.t !== 'new-message') {
        return {
            handled: false,
            lastObservedMessageSeq: params.lastObservedMessageSeq,
            lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
        };
    }
    if (params.update.body.sid !== params.sessionId) {
        return {
            handled: true,
            lastObservedMessageSeq: params.lastObservedMessageSeq,
            lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
        };
    }

    const messageId = params.update.body.message.id;
    const hasMessageId = typeof messageId === 'string' && messageId.length > 0;
    const markMessageIdAsReceived = () => {
        if (hasMessageId) {
            params.receivedMessageIds.add(messageId);
        }
    };
    const unmarkMessageIdAsReceived = () => {
        if (hasMessageId) {
            params.receivedMessageIds.delete(messageId);
        }
    };
    if (hasMessageId && params.receivedMessageIds.has(messageId)) {
        return {
            handled: true,
            lastObservedMessageSeq: params.lastObservedMessageSeq,
            lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
        };
    }

    const parsedContent = SessionMessageContentSchema.safeParse((params.update.body as any).message?.content);
    if (!parsedContent.success) {
        const rawContent = (params.update.body as any).message?.content;
        params.debug('[SOCKET] [UPDATE] Ignoring new-message with invalid content envelope', {
            issues: parsedContent.error.issues.map((i) => ({
                code: i.code,
                path: i.path,
                expected: 'expected' in i ? (i as any).expected : undefined,
                received: 'received' in i ? (i as any).received : undefined,
            })),
            contentShape: summarizeValueShapeForLog(rawContent),
        });
        markMessageIdAsReceived();
        return {
            handled: true,
            lastObservedMessageSeq: params.lastObservedMessageSeq,
            lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
        };
    }

    let nextLastObservedMessageSeq = params.lastObservedMessageSeq;
    let nextLastObservedUserMessageSeq = params.lastObservedUserMessageSeq;
    const msgSeq = params.update.body.message.seq;
    if (typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
        nextLastObservedMessageSeq = Math.max(nextLastObservedMessageSeq, msgSeq);
    }

    const localId = params.update.body.message.localId ?? null;
    const isSelfEchoSuppressedLocalId = Boolean(localId && params.hasSelfEchoSuppressedLocalId(localId));
    const isAgentQueueEchoSuppressedLocalId = Boolean(localId && params.hasAgentQueueEchoSuppressedLocalId(localId));
    const isAgentQueueDeliveredLocalId = Boolean(localId && (params.hasAgentQueueDeliveredLocalId?.(localId) ?? false));
    const isPendingQueueMaterializedLocalId = Boolean(localId && params.hasPendingQueueMaterializedLocalId(localId));
    if (localId && isSelfEchoSuppressedLocalId && !isPendingQueueMaterializedLocalId) {
        // We observed the broadcast for a message we wrote locally; cancel commit recovery. Pending-queue
        // materialized messages keep their marker until provider acceptance proves runtime custody.
        params.deleteMaterializedLocalId(localId);
    }

    let body: unknown;
    if (parsedContent.data.t === 'plain') {
        body = parsedContent.data.v;
    } else {
        try {
            body = decrypt(params.encryptionKey, params.encryptionVariant, decodeBase64(parsedContent.data.c));
        } catch (error) {
            params.debug('[SOCKET] [UPDATE] Failed to decrypt new-message payload', {
                error,
                messageId: typeof messageId === 'string' ? messageId : null,
                localId,
                msgSeq: typeof msgSeq === 'number' && Number.isFinite(msgSeq) ? msgSeq : null,
            });
            return {
                handled: true,
                lastObservedMessageSeq: nextLastObservedMessageSeq,
                lastObservedUserMessageSeq: nextLastObservedUserMessageSeq,
            };
        }
    }
    const bodyWithLocalId =
        params.update.body.message.localId === undefined
            ? body
            : {
                ...(body as any),
                localId: params.update.body.message.localId,
            };
    const transportCreatedAt =
        typeof params.update.createdAt === 'number' && Number.isFinite(params.update.createdAt)
            ? params.update.createdAt
            : undefined;
    const bodyWithTransportFields = {
        ...(bodyWithLocalId as any),
        // Attach server timestamps so downstream consumers can make clock-safe decisions.
        ...(transportCreatedAt === undefined ? {} : { createdAt: transportCreatedAt }),
    };
    params.observeMessage?.(
        bodyWithTransportFields,
        typeof msgSeq === 'number' && Number.isFinite(msgSeq) ? msgSeq : null,
    );
    const connectedServiceTurnLifecycleEvent = mapSessionTurnLifecycleToConnectedServiceEvent(bodyWithTransportFields);
    if (connectedServiceTurnLifecycleEvent) {
        params.onConnectedServiceTurnLifecycleEvent?.(connectedServiceTurnLifecycleEvent);
    }

    params.debugLargeJson('[SOCKET] [UPDATE] Received update:', bodyWithTransportFields);
    let shouldMarkReceivedMessageId = !hasMessageId;

    // Try to parse as user message first.
    const userResult = UserMessageSchema.safeParse(bodyWithTransportFields);
    if (userResult.success) {
        shouldMarkReceivedMessageId = false;
        observeCommittedUserMessageSeq({
            message: userResult.data,
            transportLocalId: localId,
            msgSeq,
            observe: params.observeCommittedUserMessageSeq,
        });
        const deliveryResult = deliverUserPromptCandidate({
            message: userResult.data,
            update: params.update,
            localId,
            msgSeq,
            isSelfEchoSuppressedLocalId,
            isAgentQueueEchoSuppressedLocalId,
            isAgentQueueDeliveredLocalId,
            isPendingQueueMaterializedLocalId,
            pendingMessageCallback: params.pendingMessageCallback,
            pendingMessages: params.pendingMessages,
            shouldDeliverUserMessageToAgentQueue: params.shouldDeliverUserMessageToAgentQueue,
            shouldResolveSkippedUserMessage: params.shouldResolveSkippedUserMessage,
            markMessageIdAsReceived,
            unmarkMessageIdAsReceived,
            markAgentQueueEchoSuppressedLocalId: params.markAgentQueueEchoSuppressedLocalId,
            markAgentQueueDeliveredLocalId: params.markAgentQueueDeliveredLocalId ?? (() => undefined),
            clearAgentQueueEchoSuppressedLocalId: params.clearAgentQueueEchoSuppressedLocalId ?? (() => undefined),
            clearAgentQueueDeliveredLocalId: params.clearAgentQueueDeliveredLocalId ?? (() => undefined),
            onUserMessageDeliveredToAgentQueue: params.onUserMessageDeliveredToAgentQueue,
            onUserMessageDeliveryProvenByLocalEcho: params.onUserMessageDeliveryProvenByLocalEcho,
            debug: params.debug,
            skippedDebugMessage: '[SOCKET] [UPDATE] Skipped user-message delivery to agent queue',
        });
        if (!deliveryResult.resolved) {
            nextLastObservedMessageSeq = params.lastObservedMessageSeq;
        }
        if (deliveryResult.resolved && typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
            nextLastObservedUserMessageSeq = Math.max(nextLastObservedUserMessageSeq, msgSeq);
        }
        params.emit('user-message', userResult.data);
    } else {
        const coerced = coerceSessionUserPromptV1(bodyWithTransportFields);
        if (coerced) {
            const candidate = {
                role: 'user' as const,
                content: { type: 'text' as const, text: coerced.text },
                createdAt: (bodyWithTransportFields as any).createdAt,
                localId: (bodyWithTransportFields as any).localId,
                localKey: (bodyWithTransportFields as any).localKey,
                meta: (bodyWithTransportFields as any).meta,
            };
            const parsedCandidate = UserMessageSchema.safeParse(candidate);
            if (parsedCandidate.success) {
                shouldMarkReceivedMessageId = false;
                observeCommittedUserMessageSeq({
                    message: parsedCandidate.data,
                    transportLocalId: localId,
                    msgSeq,
                    observe: params.observeCommittedUserMessageSeq,
                });
                const deliveryResult = deliverUserPromptCandidate({
                    message: parsedCandidate.data,
                    update: params.update,
                    localId,
                    msgSeq,
                    isSelfEchoSuppressedLocalId,
                    isAgentQueueEchoSuppressedLocalId,
                    isAgentQueueDeliveredLocalId,
                    isPendingQueueMaterializedLocalId,
                    pendingMessageCallback: params.pendingMessageCallback,
                    pendingMessages: params.pendingMessages,
                    shouldDeliverUserMessageToAgentQueue: params.shouldDeliverUserMessageToAgentQueue,
                    shouldResolveSkippedUserMessage: params.shouldResolveSkippedUserMessage,
                    markMessageIdAsReceived,
                    unmarkMessageIdAsReceived,
                    markAgentQueueEchoSuppressedLocalId: params.markAgentQueueEchoSuppressedLocalId,
                    markAgentQueueDeliveredLocalId: params.markAgentQueueDeliveredLocalId ?? (() => undefined),
                    clearAgentQueueEchoSuppressedLocalId: params.clearAgentQueueEchoSuppressedLocalId ?? (() => undefined),
                    clearAgentQueueDeliveredLocalId: params.clearAgentQueueDeliveredLocalId ?? (() => undefined),
                    onUserMessageDeliveredToAgentQueue: params.onUserMessageDeliveredToAgentQueue,
                    onUserMessageDeliveryProvenByLocalEcho: params.onUserMessageDeliveryProvenByLocalEcho,
                    debug: params.debug,
                    skippedDebugMessage: '[SOCKET] [UPDATE] Skipped coerced user-message delivery to agent queue',
                });
                if (!deliveryResult.resolved) {
                    nextLastObservedMessageSeq = params.lastObservedMessageSeq;
                }
                if (deliveryResult.resolved && typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
                    nextLastObservedUserMessageSeq = Math.max(nextLastObservedUserMessageSeq, msgSeq);
                }
                params.emit('user-message', parsedCandidate.data);
                return {
                    handled: true,
                    lastObservedMessageSeq: nextLastObservedMessageSeq,
                    lastObservedUserMessageSeq: nextLastObservedUserMessageSeq,
                };
            }
        }

        const rawRole = (bodyWithTransportFields as any)?.role;
        if (rawRole === 'user') {
            params.debug('[SOCKET] [UPDATE] Dropping user prompt delivery: unable to coerce into a UserMessage', {
                issues: userResult.error.issues.map((i) => ({
                    code: i.code,
                    path: i.path,
                    expected: 'expected' in i ? (i as any).expected : undefined,
                    received: 'received' in i ? (i as any).received : undefined,
                })),
                bodyShape: summarizeValueShapeForLog(bodyWithTransportFields),
            });
        }
        params.emit('message', bodyWithTransportFields);
    }

    if (shouldMarkReceivedMessageId) {
        markMessageIdAsReceived();
    }

    return {
        handled: true,
        lastObservedMessageSeq: nextLastObservedMessageSeq,
        lastObservedUserMessageSeq: nextLastObservedUserMessageSeq,
    };
}
