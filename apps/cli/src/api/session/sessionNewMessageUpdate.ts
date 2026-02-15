import { decodeBase64, decrypt } from '../encryption';
import type {
    Update,
    UserMessage,
} from '../types';
import { SessionMessageContentSchema, UserMessageSchema } from '../types';

export function handleSessionNewMessageUpdate(params: {
    update: Update;
    sessionId: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    receivedMessageIds: Set<string>;
    lastObservedMessageSeq: number;
    hasMaterializedLocalId: (localId: string) => boolean;
    deleteMaterializedLocalId: (localId: string) => void;
    pendingMessageCallback: ((message: UserMessage) => void) | null;
    pendingMessages: UserMessage[];
    emit: (event: 'user-message' | 'message', payload: unknown) => void;
    debug: (message: string, data?: unknown) => void;
    debugLargeJson: (message: string, data: unknown) => void;
}): {
    handled: boolean;
    lastObservedMessageSeq: number;
} {
    if (params.update.body?.t !== 'new-message') {
        return { handled: false, lastObservedMessageSeq: params.lastObservedMessageSeq };
    }
    if (params.update.body.sid !== params.sessionId) {
        return { handled: true, lastObservedMessageSeq: params.lastObservedMessageSeq };
    }

    const parsedContent = SessionMessageContentSchema.safeParse((params.update.body as any).message?.content);
    if (!parsedContent.success) {
        params.debug('[SOCKET] [UPDATE] Ignoring new-message with invalid encrypted content envelope');
        return { handled: true, lastObservedMessageSeq: params.lastObservedMessageSeq };
    }

    const messageId = params.update.body.message.id;
    if (typeof messageId === 'string' && messageId.length > 0) {
        if (params.receivedMessageIds.has(messageId)) {
            return { handled: true, lastObservedMessageSeq: params.lastObservedMessageSeq };
        }
        params.receivedMessageIds.add(messageId);
    }

    let nextLastObservedMessageSeq = params.lastObservedMessageSeq;
    const msgSeq = params.update.body.message.seq;
    if (typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
        nextLastObservedMessageSeq = Math.max(nextLastObservedMessageSeq, msgSeq);
    }

    const localId = params.update.body.message.localId ?? null;
    if (localId && params.hasMaterializedLocalId(localId)) {
        // We observed the broadcast for a message we materialized; cancel any recovery path.
        params.deleteMaterializedLocalId(localId);
    }

    let body: unknown;
    try {
        body = decrypt(params.encryptionKey, params.encryptionVariant, decodeBase64(parsedContent.data.c));
    } catch (error) {
        params.debug('[SOCKET] [UPDATE] Failed to decrypt new-message payload', {
            error,
            messageId: typeof messageId === 'string' ? messageId : null,
            localId,
            msgSeq: typeof msgSeq === 'number' && Number.isFinite(msgSeq) ? msgSeq : null,
        });
        return { handled: true, lastObservedMessageSeq: nextLastObservedMessageSeq };
    }
    const bodyWithLocalId =
        params.update.body.message.localId === undefined
            ? body
            : {
                ...(body as any),
                localId: params.update.body.message.localId,
            };
    const bodyWithTransportFields = {
        ...(bodyWithLocalId as any),
        // Attach server timestamps so downstream consumers can make clock-safe decisions.
        createdAt: typeof params.update.createdAt === 'number' ? params.update.createdAt : undefined,
    };

    params.debugLargeJson('[SOCKET] [UPDATE] Received update:', bodyWithTransportFields);

    // Try to parse as user message first.
    const userResult = UserMessageSchema.safeParse(bodyWithTransportFields);
    if (userResult.success) {
        const sentFrom = userResult.data.meta?.sentFrom;
        const source = userResult.data.meta?.source;
        const shouldDeliverToAgent = source !== 'cli' && sentFrom !== 'cli';
        if (shouldDeliverToAgent) {
            if (params.pendingMessageCallback) {
                params.pendingMessageCallback(userResult.data);
            } else {
                params.pendingMessages.push(userResult.data);
            }
        } else {
            params.debug('[SOCKET] [UPDATE] Skipped user-message delivery to agent queue (self echo suppression)', {
                source: source ?? null,
                sentFrom: sentFrom ?? null,
                localId,
            });
        }
        params.emit('user-message', userResult.data);
    } else {
        // If not a user message, it might be a permission response or other message type.
        params.debug('[SOCKET] [UPDATE] Decrypted new-message is not a UserMessage payload; forwarding generic event');
        params.emit('message', body);
    }

    return { handled: true, lastObservedMessageSeq: nextLastObservedMessageSeq };
}
