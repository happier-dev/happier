import type { Message } from '@/sync/domains/messages/messageTypes';

export function resolveLatestCommittedMessageId(messages: readonly Message[]): string | null {
    if (messages.length === 0) return null;
    return messages[messages.length - 1]?.id ?? null;
}
