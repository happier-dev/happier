import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import { evaluateAgentSessionCapabilitySupport, inferAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { readSessionRollbackRangesV1FromMetadata, type SessionRollbackTarget } from '@happier-dev/protocol';

export type TranscriptRollbackAction = Readonly<{
    target: SessionRollbackTarget;
    restoredDraftText: string | null;
}>;

export type SessionRollbackRangeV1 = Readonly<{
    startSeqInclusive: number;
    endSeqInclusive: number;
}>;

function readFiniteSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.trunc(value);
}

export function resolveConversationRollbackSupport(params: Readonly<{
    session: Session | null | undefined;
}>): Readonly<{
    supportsLatestTurnRollback: boolean;
    supportsRollbackToPoint: boolean;
}> {
    const session = params.session ?? null;
    if (!session || session.active !== true) {
        return {
            supportsLatestTurnRollback: false,
            supportsRollbackToPoint: false,
        };
    }
    const agentId = inferAgentIdFromSessionMetadata(session.metadata);
    const conversationSupport = evaluateAgentSessionCapabilitySupport({
        agentId,
        capability: 'sessionRollback.conversation',
        metadata: session.metadata,
    });
    return {
        supportsLatestTurnRollback: conversationSupport === 'supported',
        supportsRollbackToPoint: conversationSupport === 'supported',
    };
}

export function canRollbackConversation(params: Readonly<{
    session: Session | null | undefined;
}>): boolean {
    const support = resolveConversationRollbackSupport(params);
    return support.supportsLatestTurnRollback || support.supportsRollbackToPoint;
}

export function readSessionRollbackRangesV1(metadata: Record<string, unknown> | null | undefined): readonly SessionRollbackRangeV1[] {
    const parsed = readSessionRollbackRangesV1FromMetadata(metadata);
    const raw = parsed?.ranges ?? [];
    const ranges: SessionRollbackRangeV1[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const startSeqInclusive = readFiniteSeq((entry as { startSeqInclusive?: unknown }).startSeqInclusive);
        const endSeqInclusive = readFiniteSeq((entry as { endSeqInclusive?: unknown }).endSeqInclusive);
        if (startSeqInclusive == null || endSeqInclusive == null) continue;
        if (endSeqInclusive < startSeqInclusive) continue;
        ranges.push({ startSeqInclusive, endSeqInclusive });
    }
    return ranges;
}

export function isMessageRolledBack(params: Readonly<{
    message: Message | null | undefined;
    rollbackRanges: readonly SessionRollbackRangeV1[];
}>): boolean {
    const seq = readFiniteSeq((params.message as { seq?: unknown } | null | undefined)?.seq);
    if (seq == null) return false;
    return params.rollbackRanges.some((range) => seq >= range.startSeqInclusive && seq <= range.endSeqInclusive);
}

export function resolveLatestActiveMessageId(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    rollbackRanges: readonly SessionRollbackRangeV1[];
}>): string | null {
    for (let index = params.messageIdsOldestFirst.length - 1; index >= 0; index -= 1) {
        const messageId = params.messageIdsOldestFirst[index];
        if (!messageId) continue;
        const message = params.messagesById[messageId];
        if (!message) continue;

        // Tool-call and agent-event rows do not host the transcript action strip.
        // Anchor rollback on the nearest adjacent user/agent message instead.
        if (message.kind === 'tool-call' || message.kind === 'agent-event') continue;

        if (!isMessageRolledBack({ message, rollbackRanges: params.rollbackRanges })) {
            return messageId;
        }
    }
    return null;
}

export function resolveTranscriptRollbackActions(params: Readonly<{
    session: Session | null | undefined;
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    rollbackRanges: readonly SessionRollbackRangeV1[];
}>): Readonly<Record<string, TranscriptRollbackAction>> {
    const support = resolveConversationRollbackSupport({ session: params.session });
    if (support.supportsRollbackToPoint) {
        const actions: Record<string, TranscriptRollbackAction> = {};
        for (const messageId of params.messageIdsOldestFirst) {
            const message = params.messagesById[messageId];
            if (!message || message.kind !== 'user-text') continue;
            if (isMessageRolledBack({ message, rollbackRanges: params.rollbackRanges })) continue;
            const seq = readFiniteSeq(message.seq);
            if (seq == null) continue;
            actions[messageId] = {
                target: { type: 'before_user_message', userMessageSeq: seq },
                restoredDraftText: message.text,
            };
        }
        return actions;
    }

    if (!support.supportsLatestTurnRollback) return {};
    const latestActiveMessageId = resolveLatestActiveMessageId({
        messageIdsOldestFirst: params.messageIdsOldestFirst,
        messagesById: params.messagesById,
        rollbackRanges: params.rollbackRanges,
    });
    if (!latestActiveMessageId) return {};
    return {
        [latestActiveMessageId]: {
            target: { type: 'latest_turn' },
            restoredDraftText: null,
        },
    };
}
