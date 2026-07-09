import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionViewportAnchorSnapshot } from '@/sync/sync';
import type { TranscriptRowShellItem } from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';
import { collectTranscriptNavigationMessageIdsForItem } from '@/components/sessions/transcript/viewport/lifecycle/transcriptRowClassification';

function normalizeAnchorSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const seq = Math.trunc(value);
    return seq > 0 ? seq : null;
}

function resolveMessageSeq(message: Message | null | undefined): number | null {
    return normalizeAnchorSeq(message?.seq);
}

export function stampViewportAnchorForEmit(params: Readonly<{
    anchor: SessionViewportAnchorSnapshot | null | undefined;
    items: readonly TranscriptRowShellItem[];
    messagesById: Readonly<Record<string, Message | undefined>>;
    stateMessagesById: Readonly<Record<string, Message | undefined>>;
}>): SessionViewportAnchorSnapshot | null | undefined {
    const { anchor } = params;
    if (!anchor) return anchor;
    const candidateMessageIds: string[] = [];
    const seen = new Set<string>();
    const addMessageId = (value: unknown) => {
        if (typeof value !== 'string' || value.length === 0 || seen.has(value)) return;
        seen.add(value);
        candidateMessageIds.push(value);
    };
    const item = params.items.find((candidate) => candidate.id === anchor.itemId);
    if (item) {
        for (const messageId of collectTranscriptNavigationMessageIdsForItem(item)) {
            addMessageId(messageId);
        }
    }
    const toolCallRowIdMatch = anchor.itemId.match(/^toolCalls:(?:linear:([^#]+)|turn:.*:([^:#]+))(?:#.*)?$/);
    addMessageId(toolCallRowIdMatch?.[1] ?? toolCallRowIdMatch?.[2]);
    const toolUnitRowIdMatch = anchor.itemId.match(/#tool:([^#]+)$/);
    addMessageId(toolUnitRowIdMatch?.[1]);
    addMessageId(anchor.messageId);
    for (const messageId of candidateMessageIds) {
        const seq = resolveMessageSeq(params.messagesById[messageId] ?? params.stateMessagesById[messageId] ?? null);
        if (seq != null) return { ...anchor, messageId, seq };
    }
    const stampedSeq = normalizeAnchorSeq(anchor.seq);
    return stampedSeq === null ? anchor : { ...anchor, seq: stampedSeq };
}
