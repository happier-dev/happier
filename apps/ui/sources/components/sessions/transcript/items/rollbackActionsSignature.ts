import type { Message } from '@/sync/domains/messages/messageTypes';

export function buildRollbackActionsInputSignature(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}>): string {
    let signature = '';
    for (const messageId of params.messageIdsOldestFirst) {
        const message = params.messagesById[messageId];
        if (!message) {
            signature += `${messageId}:missing|`;
            continue;
        }
        const seq = typeof message.seq === 'number' && Number.isFinite(message.seq) ? Math.trunc(message.seq) : '';
        signature += `${message.id}:${message.kind}:${seq}`;
        if (message.kind === 'user-text') {
            signature += `:${message.text}`;
        }
        signature += '|';
    }
    return signature;
}
