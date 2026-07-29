import type { Message } from '@/sync/domains/messages/messageTypes';
import { messageAttentionImpact } from '@/sync/domains/messages/messageUserAttention';

/**
 * Canonical per-message fold for session-list readable activity.
 *
 * Shared by the full-walk summaries in `sessionListRenderable.ts` and by the
 * incremental transcript aggregate in `transcriptRenderableAggregate.ts`, so
 * both derive the exact same unread/meaningful-activity watermarks.
 */
export type MessageReadableActivityFields = Readonly<
    Pick<Message, 'seq' | 'createdAt'>
    & Partial<Pick<Message, 'kind'>>
    & Partial<Pick<Extract<Message, { kind: 'agent-event' }>, 'event'>>
>;

export type SessionListReadableActivityAccumulator = {
    latestCommittedMessageSeq: number | null;
    latestCommittedMessageCreatedAt: number | null;
};

export function createSessionListReadableActivityAccumulator(): SessionListReadableActivityAccumulator {
    return {
        latestCommittedMessageSeq: null,
        latestCommittedMessageCreatedAt: null,
    };
}

export function foldSessionListReadableActivityMessage(
    accumulator: SessionListReadableActivityAccumulator,
    message: MessageReadableActivityFields,
): void {
    const attentionImpact = messageAttentionImpact(message);
    if (attentionImpact.affectsUnread) {
        accumulator.latestCommittedMessageSeq = maxReadSeq(accumulator.latestCommittedMessageSeq, normalizeReadSeq(message.seq));
    }
    if (attentionImpact.affectsMeaningfulActivity) {
        accumulator.latestCommittedMessageCreatedAt = maxReadSeq(accumulator.latestCommittedMessageCreatedAt, normalizeReadSeq(message.createdAt));
    }
}

export function normalizeReadSeq(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

export function maxReadSeq(left: number | null, right: number | null): number | null {
    if (left === null) return right;
    if (right === null) return left;
    return Math.max(left, right);
}
