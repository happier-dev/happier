import { decodeBase64, decrypt } from '../encryption';
import type {
    Update,
    UserMessage,
} from '../types';
import { SessionMessageContentSchema, UserMessageSchema } from '../types';
import { AgentSessionRuntimeEventSchema, coerceSessionUserPromptV1, readPendingLocalId } from '@happier-dev/protocol';
import { summarizeValueShapeForLog } from '@/diagnostics/eventShapeForLog';
import {
    detectSessionTurnLifecycleEvent,
    isBareSessionReadyEvent,
} from '@/session/shared/sessionTurnLifecycle';
import { readSessionHistoryReplayProvenance } from './sessionMessageCatchUp';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';

type ConnectedServiceTurnLifecycleEvent = 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';

function readCommittedUserMessageSeq(value: unknown): number | null {
    return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function readCommittedUserMessageLocalId(message: UserMessage, transportLocalId: string | null): string | null {
    return readPendingLocalId(transportLocalId) ?? readPendingLocalId(message.localId);
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

function mapSessionTurnLifecycleToConnectedServiceEvent(value: unknown): ConnectedServiceTurnLifecycleEvent | null {
    const event = detectSessionTurnLifecycleEvent(value);
    if (event === 'task_started') return 'task_started';
    if (event === 'ready') {
        return isBareSessionReadyEvent(value) ? 'turn_cancelled' : 'assistant_message_end';
    }
    if (event === 'turn_cancelled' || event === 'turn_aborted' || event === 'turn_failed') {
        return 'turn_cancelled';
    }
    if (event === 'task_complete') {
        return 'assistant_message_end';
    }
    const runtimeEvent = AgentSessionRuntimeEventSchema.safeParse(value);
    if (runtimeEvent.success) {
        if (runtimeEvent.data.kind === 'turn-start') return 'prompt_or_steer';
        if (runtimeEvent.data.kind === 'turn-cancelled'
            || runtimeEvent.data.kind === 'turn-failed'
            || runtimeEvent.data.kind === 'runtime-ended') {
            return 'turn_cancelled';
        }
        if (runtimeEvent.data.kind === 'turn-complete') {
            return 'assistant_message_end';
        }
    }
    return null;
}

export function handleSessionNewMessageUpdate(params: {
    update: Update;
    sessionId: string;
    receivedMessageIds: Set<string>;
    lastObservedMessageSeq: number;
    lastObservedUserMessageSeq: number;
    emit: (event: 'user-message' | 'message', payload: unknown) => void;
    observeMessage?: (message: unknown, seq: number | null) => void;
    observeCommittedUserMessageSeq?: (params: { localId: string | null | undefined; seq: number }) => void;
    consumeLocallyAuthoredTranscriptObservationLocalId?: (localId: string) => boolean;
    onConnectedServiceTurnLifecycleEvent?: (event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled') => void;
    debug: (message: string, data?: unknown) => void;
    debugLargeJson: (message: string, data: unknown) => void;
} & SessionStoredContentCryptoContext): {
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
    const isStrictlyNewMessageSeq = typeof msgSeq === 'number'
        && Number.isFinite(msgSeq)
        && msgSeq > params.lastObservedMessageSeq;
    if (typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
        nextLastObservedMessageSeq = Math.max(nextLastObservedMessageSeq, msgSeq);
    }

    const localId = params.update.body.message.localId ?? null;
    let body: unknown;
    if (parsedContent.data.t === 'plain') {
        body = parsedContent.data.v;
    } else {
        try {
            if (params.mode !== 'e2ee') {
                return {
                    handled: false,
                    lastObservedMessageSeq: nextLastObservedMessageSeq,
                    lastObservedUserMessageSeq: nextLastObservedUserMessageSeq,
                };
            }
            body = decrypt(
                params.ctx.encryptionKey,
                params.ctx.encryptionVariant,
                decodeBase64(parsedContent.data.c),
            );
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
        typeof params.update.body.message.createdAt === 'number' && Number.isFinite(params.update.body.message.createdAt)
            ? params.update.body.message.createdAt
            : typeof params.update.createdAt === 'number' && Number.isFinite(params.update.createdAt)
                ? params.update.createdAt
                : undefined;
    const historyReplayProvenance = readSessionHistoryReplayProvenance(params.update);
    const isLocallyAuthoredTranscriptObservation = localId !== null
        && params.consumeLocallyAuthoredTranscriptObservationLocalId?.(localId) === true;
    const bodyWithTransportFields = {
        ...(bodyWithLocalId as any),
        // Attach server timestamps so downstream consumers can make clock-safe decisions.
        ...(transportCreatedAt === undefined ? {} : {
            createdAt: historyReplayProvenance?.sourceCreatedAt ?? transportCreatedAt,
            serverCreatedAt: transportCreatedAt,
        }),
    };
    const isTranscriptObservation = historyReplayProvenance !== null || isLocallyAuthoredTranscriptObservation;
    if (!isTranscriptObservation) {
        const messageType = (bodyWithTransportFields as { type?: unknown }).type;
        if (
            messageType === 'task_started'
            || messageType === 'assistant_message_end'
            || messageType === 'turn_cancelled'
        ) {
            params.onConnectedServiceTurnLifecycleEvent?.(messageType);
        }
    }
    if (!isTranscriptObservation) {
        params.observeMessage?.(
            bodyWithTransportFields,
            typeof msgSeq === 'number' && Number.isFinite(msgSeq) ? msgSeq : null,
        );
    }
    const connectedServiceTurnLifecycleEvent = mapSessionTurnLifecycleToConnectedServiceEvent(bodyWithTransportFields);
    // Recovery proof must come from a provider outcome observed after this runtime's
    // initial/catch-up watermark. Replayed socket rows are transcript state, not a new
    // provider outcome for the currently selected credential epoch.
    if (!isTranscriptObservation && connectedServiceTurnLifecycleEvent && isStrictlyNewMessageSeq) {
        params.onConnectedServiceTurnLifecycleEvent?.(connectedServiceTurnLifecycleEvent);
    }

    params.debugLargeJson('[SOCKET] [UPDATE] Received update:', bodyWithTransportFields);
    let shouldMarkReceivedMessageId = !hasMessageId;

    // Try to parse as user message first.
    const userResult = UserMessageSchema.safeParse(bodyWithTransportFields);
    if (userResult.success) {
        if (!isTranscriptObservation) {
            params.onConnectedServiceTurnLifecycleEvent?.('prompt_or_steer');
        }
        shouldMarkReceivedMessageId = true;
        if (!isTranscriptObservation) {
            observeCommittedUserMessageSeq({
                message: userResult.data,
                transportLocalId: localId,
                msgSeq,
                observe: params.observeCommittedUserMessageSeq,
            });
        }
        if (typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
            nextLastObservedUserMessageSeq = Math.max(nextLastObservedUserMessageSeq, msgSeq);
        }
        if (!isTranscriptObservation) {
            params.emit('user-message', userResult.data);
        }
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
                if (!isTranscriptObservation) {
                    params.onConnectedServiceTurnLifecycleEvent?.('prompt_or_steer');
                }
                shouldMarkReceivedMessageId = true;
                if (!isTranscriptObservation) {
                    observeCommittedUserMessageSeq({
                        message: parsedCandidate.data,
                        transportLocalId: localId,
                        msgSeq,
                        observe: params.observeCommittedUserMessageSeq,
                    });
                }
                if (typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
                    nextLastObservedUserMessageSeq = Math.max(nextLastObservedUserMessageSeq, msgSeq);
                }
                if (!isTranscriptObservation) {
                    params.emit('user-message', parsedCandidate.data);
                }
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
