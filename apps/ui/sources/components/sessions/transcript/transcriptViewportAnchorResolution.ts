import type { SessionViewportAnchorSnapshot } from '@/sync/sync';

type TranscriptViewportAnchorMessageContent = Readonly<
    | {
        kind: 'message';
        messageId?: unknown;
    }
    | {
        kind: 'tool_calls';
        toolMessageIds?: unknown;
    }
>;

type TranscriptViewportAnchorTurn = Readonly<{
    userMessageId?: unknown;
    content?: unknown;
}>;

export type TranscriptViewportAnchorResolvableItem = Readonly<{
    id?: unknown;
    kind?: unknown;
    messageId?: unknown;
    toolMessageIds?: unknown;
    turn?: TranscriptViewportAnchorTurn;
}>;

export function resolveTranscriptViewportAnchorFocusOffsetPx(viewportHeightPx: number): number {
    const preferred = Math.round(viewportHeightPx * 0.18);
    return Math.max(64, Math.min(128, preferred));
}

function itemContainsMessageId(item: TranscriptViewportAnchorResolvableItem, messageId: string): boolean {
    if (item.kind === 'message') {
        return item.messageId === messageId;
    }
    if (item.kind === 'tool-calls-group') {
        return Array.isArray(item.toolMessageIds) && item.toolMessageIds.includes(messageId);
    }
    if (item.kind !== 'turn') return false;

    const turn = item.turn;
    if (turn?.userMessageId === messageId) return true;
    const content = Array.isArray(turn?.content) ? turn.content : [];
    return content.some((entry: TranscriptViewportAnchorMessageContent) => {
        if (entry.kind === 'message') {
            return entry.messageId === messageId;
        }
        if (entry.kind === 'tool_calls') {
            return Array.isArray(entry.toolMessageIds) && entry.toolMessageIds.includes(messageId);
        }
        return false;
    });
}

export function resolveTranscriptViewportAnchorIndex(params: Readonly<{
    anchor: Pick<SessionViewportAnchorSnapshot, 'messageId' | 'itemId'>;
    items: readonly TranscriptViewportAnchorResolvableItem[];
}>): number | null {
    const messageId = typeof params.anchor.messageId === 'string' && params.anchor.messageId.length > 0
        ? params.anchor.messageId
        : null;
    if (messageId) {
        const messageIndex = params.items.findIndex((item) => itemContainsMessageId(item, messageId));
        if (messageIndex >= 0) return messageIndex;
    }

    const itemIndex = params.items.findIndex((item) => item.id === params.anchor.itemId);
    return itemIndex >= 0 ? itemIndex : null;
}

export function resolveTranscriptViewportAnchorDescriptor(
    item: TranscriptViewportAnchorResolvableItem,
): Pick<SessionViewportAnchorSnapshot, 'kind' | 'messageId' | 'itemId'> | null {
    if (typeof item.id !== 'string' || item.id.length === 0) return null;

    if (item.kind === 'message' && typeof item.messageId === 'string' && item.messageId.length > 0) {
        return {
            kind: 'message',
            itemId: item.id,
            messageId: item.messageId,
        };
    }

    if (item.kind === 'tool-calls-group') {
        const messageId = Array.isArray(item.toolMessageIds) && typeof item.toolMessageIds[0] === 'string'
            ? item.toolMessageIds[0]
            : null;
        return {
            kind: 'toolGroup',
            itemId: item.id,
            messageId,
        };
    }

    if (item.kind === 'turn') {
        const turn = item.turn;
        if (typeof turn?.userMessageId === 'string' && turn.userMessageId.length > 0) {
            return {
                kind: 'message',
                itemId: item.id,
                messageId: turn.userMessageId,
            };
        }
        const content = Array.isArray(turn?.content) ? turn.content : [];
        for (const entry of content as TranscriptViewportAnchorMessageContent[]) {
            if (entry.kind === 'message' && typeof entry.messageId === 'string' && entry.messageId.length > 0) {
                return {
                    kind: 'message',
                    itemId: item.id,
                    messageId: entry.messageId,
                };
            }
            if (entry.kind === 'tool_calls' && Array.isArray(entry.toolMessageIds) && typeof entry.toolMessageIds[0] === 'string') {
                return {
                    kind: 'toolGroup',
                    itemId: item.id,
                    messageId: entry.toolMessageIds[0],
                };
            }
        }
    }

    return {
        kind: 'item',
        itemId: item.id,
        messageId: null,
    };
}
