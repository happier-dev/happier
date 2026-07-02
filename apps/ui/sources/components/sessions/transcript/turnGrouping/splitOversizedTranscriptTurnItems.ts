import type { ChatListItem } from '@/components/sessions/chatListItems';
import type { Message } from '@/sync/domains/messages/messageTypes';

import type { TranscriptTurn } from './buildTranscriptTurns';

type ForkMessageMetadata = Readonly<{
    originSessionId: string;
    isReadOnlyContext: boolean;
}>;

export type SplittableTranscriptTurnItem =
    | ChatListItem
    | {
        kind: 'turn';
        id: string;
        turn: TranscriptTurn;
    };

function normalizeMaxTurnEntries(value: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function readMessageMetadata(
    metadataByMessageId: Readonly<Record<string, ForkMessageMetadata>> | undefined,
    messageId: string,
): ForkMessageMetadata | null {
    return metadataByMessageId?.[messageId] ?? null;
}

function withOrigin<T extends Extract<ChatListItem, { kind: 'message' | 'tool-calls-group' }>>(
    item: T,
    metadata: ForkMessageMetadata | null,
): T {
    if (!metadata) return item;
    return {
        ...item,
        originSessionId: metadata.originSessionId,
        isReadOnlyContext: metadata.isReadOnlyContext,
    };
}

function buildMessageItem(params: Readonly<{
    messageId: string;
    messagesById: Readonly<Record<string, Message>>;
    metadataByMessageId?: Readonly<Record<string, ForkMessageMetadata>>;
}>): Extract<ChatListItem, { kind: 'message' }> {
    const message = params.messagesById[params.messageId];
    const seq = typeof message?.seq === 'number' && Number.isFinite(message.seq) ? Math.trunc(message.seq) : null;
    return withOrigin({
        kind: 'message',
        id: `msg:${params.messageId}`,
        messageId: params.messageId,
        createdAt: typeof message?.createdAt === 'number' && Number.isFinite(message.createdAt) ? message.createdAt : 0,
        seq,
    }, readMessageMetadata(params.metadataByMessageId, params.messageId));
}

function buildToolCallsGroupItem(params: Readonly<{
    id: string;
    toolMessageIds: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    metadataByMessageId?: Readonly<Record<string, ForkMessageMetadata>>;
}>): Extract<ChatListItem, { kind: 'tool-calls-group' }> {
    const firstMessageId = params.toolMessageIds[0] ?? '';
    const firstMessage = params.messagesById[firstMessageId];
    return withOrigin({
        kind: 'tool-calls-group',
        id: params.id,
        toolMessageIds: [...params.toolMessageIds],
        createdAt: typeof firstMessage?.createdAt === 'number' && Number.isFinite(firstMessage.createdAt)
            ? firstMessage.createdAt
            : 0,
    }, readMessageMetadata(params.metadataByMessageId, firstMessageId));
}

function countTurnEntries(turn: TranscriptTurn): number {
    return (turn.userMessageId ? 1 : 0) + turn.content.reduce((count, content) => {
        if (content.kind === 'message') return count + 1;
        return count + Math.max(1, content.toolMessageIds.length);
    }, 0);
}

function splitTurn(params: Readonly<{
    turn: TranscriptTurn;
    messagesById: Readonly<Record<string, Message>>;
    metadataByMessageId?: Readonly<Record<string, ForkMessageMetadata>>;
}>): ChatListItem[] {
    const output: ChatListItem[] = [];
    if (params.turn.userMessageId) {
        output.push(buildMessageItem({
            messageId: params.turn.userMessageId,
            messagesById: params.messagesById,
            metadataByMessageId: params.metadataByMessageId,
        }));
    }

    for (const content of params.turn.content) {
        if (content.kind === 'message') {
            output.push(buildMessageItem({
                messageId: content.messageId,
                messagesById: params.messagesById,
                metadataByMessageId: params.metadataByMessageId,
            }));
            continue;
        }

        output.push(buildToolCallsGroupItem({
            id: content.id,
            toolMessageIds: content.toolMessageIds,
            messagesById: params.messagesById,
            metadataByMessageId: params.metadataByMessageId,
        }));
    }
    return output;
}

export function splitOversizedTranscriptTurnItems(params: Readonly<{
    items: readonly SplittableTranscriptTurnItem[];
    maxTurnEntriesPerListItem: number;
    messagesById: Readonly<Record<string, Message>>;
    metadataByMessageId?: Readonly<Record<string, ForkMessageMetadata>>;
}>): SplittableTranscriptTurnItem[] {
    const maxTurnEntries = normalizeMaxTurnEntries(params.maxTurnEntriesPerListItem);
    if (maxTurnEntries <= 0) return params.items as SplittableTranscriptTurnItem[];

    let output: SplittableTranscriptTurnItem[] | null = null;
    params.items.forEach((item, index) => {
        if (item.kind !== 'turn' || countTurnEntries(item.turn) <= maxTurnEntries) {
            output?.push(item);
            return;
        }

        if (!output) {
            output = params.items.slice(0, index) as SplittableTranscriptTurnItem[];
        }
        output.push(...splitTurn({
            turn: item.turn,
            messagesById: params.messagesById,
            metadataByMessageId: params.metadataByMessageId,
        }));
    });

    return output ?? (params.items as SplittableTranscriptTurnItem[]);
}
