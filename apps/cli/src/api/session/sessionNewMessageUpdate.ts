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
    markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    hasPendingQueueMaterializedLocalId: (localId: string) => boolean;
    deleteMaterializedLocalId: (localId: string) => void;
    pendingMessageCallback: ((message: UserMessage) => void) | null;
    pendingMessages: UserMessage[];
    shouldDeliverUserMessageToAgentQueue?: (message: UserMessage, update: Update) => boolean;
    onConnectedServiceTurnLifecycleEvent?: (event: ConnectedServiceTurnLifecycleEvent) => void;
    emit: (event: 'user-message' | 'message', payload: unknown) => void;
    observeMessage?: (message: unknown, seq: number | null) => void;
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
    const isPendingQueueMaterializedLocalId = Boolean(localId && params.hasPendingQueueMaterializedLocalId(localId));
    if (localId && (isSelfEchoSuppressedLocalId || isPendingQueueMaterializedLocalId)) {
        // We observed the broadcast for a message we materialized; cancel any recovery path.
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
        const sentFrom = userResult.data.meta?.sentFrom;
        const source = userResult.data.meta?.source;
        const isSelfEchoSuppressedCliWrite =
            isSelfEchoSuppressedLocalId && source === 'cli';
        const shouldRespectAgentQueueEchoSuppression = Boolean(params.pendingMessageCallback);
        const isEffectivelyAgentQueueEchoSuppressedLocalId =
            shouldRespectAgentQueueEchoSuppression && isAgentQueueEchoSuppressedLocalId;
        const shouldDeliverToAgentQueue =
            !isEffectivelyAgentQueueEchoSuppressedLocalId
            && !isSelfEchoSuppressedCliWrite
            && (params.shouldDeliverUserMessageToAgentQueue?.(userResult.data, params.update) ?? true);
        if (shouldDeliverToAgentQueue) {
            markMessageIdAsReceived();
            shouldMarkReceivedMessageId = false;
            if (params.pendingMessageCallback) {
                params.pendingMessageCallback(userResult.data);
            } else {
                params.pendingMessages.push(userResult.data);
            }
            if (localId) {
                params.markAgentQueueEchoSuppressedLocalId(localId);
            }
        } else {
            shouldMarkReceivedMessageId = false;
            params.debug('[SOCKET] [UPDATE] Skipped user-message delivery to agent queue', {
                source: source ?? null,
                sentFrom: sentFrom ?? null,
                localId,
                isSelfEchoSuppressedLocalId,
                isAgentQueueEchoSuppressedLocalId,
                isPendingQueueMaterializedLocalId,
                isSelfEchoSuppressedCliWrite,
                shouldRespectAgentQueueEchoSuppression,
            });
        }
        if (typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
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
                const shouldDeliverToAgentQueue =
                    params.shouldDeliverUserMessageToAgentQueue?.(parsedCandidate.data, params.update) ?? true;
                if (shouldDeliverToAgentQueue) {
                    markMessageIdAsReceived();
                    shouldMarkReceivedMessageId = false;
                    if (params.pendingMessageCallback) {
                        params.pendingMessageCallback(parsedCandidate.data);
                    } else {
                        params.pendingMessages.push(parsedCandidate.data);
                    }
                    if (localId) {
                        params.markAgentQueueEchoSuppressedLocalId(localId);
                    }
                } else {
                    shouldMarkReceivedMessageId = false;
                    params.debug('[SOCKET] [UPDATE] Skipped coerced user-message delivery to agent queue', {
                        localId,
                        source: parsedCandidate.data.meta?.source ?? null,
                        sentFrom: parsedCandidate.data.meta?.sentFrom ?? null,
                    });
                }
                if (typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
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
