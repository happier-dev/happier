import type { Message } from '@/sync/domains/messages/messageTypes';

type ContextCompactionLifecycleProjection = Readonly<{
    latestIndexByLifecycleId: ReadonlyMap<string, number>;
    indexByMessageId: ReadonlyMap<string, number>;
}>;

function readContextCompactionLifecycleId(message: Message): string | null {
    if (message.kind !== 'agent-event') return null;
    if (message.event.type !== 'context-compaction') return null;

    const lifecycleId = message.event.lifecycleId;
    if (typeof lifecycleId !== 'string') return null;

    const trimmed = lifecycleId.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function collectContextCompactionLifecycleProjection(
    messageIdsOldestFirst: readonly string[],
    messagesById: Readonly<Record<string, Message>>,
): ContextCompactionLifecycleProjection {
    const latestIndexByLifecycleId = new Map<string, number>();
    const indexByMessageId = new Map<string, number>();

    for (let index = 0; index < messageIdsOldestFirst.length; index += 1) {
        const messageId = messageIdsOldestFirst[index]!;
        indexByMessageId.set(messageId, index);

        const message = messagesById[messageId];
        if (!message) continue;

        const lifecycleId = readContextCompactionLifecycleId(message);
        if (lifecycleId) {
            latestIndexByLifecycleId.set(lifecycleId, index);
        }
    }

    return {
        latestIndexByLifecycleId,
        indexByMessageId,
    };
}

export function shouldHideSupersededContextCompactionMessage(
    message: Message,
    projection: ContextCompactionLifecycleProjection,
): boolean {
    const lifecycleId = readContextCompactionLifecycleId(message);
    if (lifecycleId === null) return false;

    const messageIndex = projection.indexByMessageId.get(message.id);
    const latestIndex = projection.latestIndexByLifecycleId.get(lifecycleId);
    return typeof messageIndex === 'number' && typeof latestIndex === 'number' && latestIndex > messageIndex;
}

export function filterVisibleContextCompactionLifecycleMessageIds(
    messageIdsOldestFirst: readonly string[],
    messagesById: Readonly<Record<string, Message>>,
): string[] {
    const projection = collectContextCompactionLifecycleProjection(messageIdsOldestFirst, messagesById);
    if (projection.latestIndexByLifecycleId.size === 0) {
        return messageIdsOldestFirst.slice();
    }

    return messageIdsOldestFirst.filter((messageId) => {
        const message = messagesById[messageId];
        return message ? !shouldHideSupersededContextCompactionMessage(message, projection) : true;
    });
}
