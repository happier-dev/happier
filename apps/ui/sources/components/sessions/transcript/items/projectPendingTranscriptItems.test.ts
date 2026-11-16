import { describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { buildTranscriptTurnsCached } from '../turnGrouping/buildTranscriptTurns';
import { buildTranscriptTurnUnits } from '../turnGrouping/buildTranscriptTurnUnits';
import { projectPendingTranscriptItems } from './projectPendingTranscriptItems';

const blocked: PendingMessage = {
    id: 'retry', localId: 'retry-local', createdAt: 3, updatedAt: 4, text: 'Please continue',
    rawRecord: {}, source: 'server_pending', pendingDeliveryStatus: 'blocked',
};

describe('Pending presentation: one section docked at the tail', () => {
    it.each([false, true])('docks retry custody in the one tail section after its failure and preserves preceding turns (follow-up: %s)', (followUp) => {
        const messages: Message[] = [
            ...(followUp ? [
                { kind: 'user-text' as const, id: 'previous-user', localId: null, createdAt: 1, seq: 1, text: 'Previous question' },
                { kind: 'agent-text' as const, id: 'previous-answer', localId: null, createdAt: 2, seq: 2, text: 'Previous answer' },
            ] : []),
            { kind: 'user-text', id: 'failed-user', localId: 'retry-local', createdAt: 3, seq: 3, text: 'Please continue' },
            { kind: 'agent-text', id: 'failure', localId: null, createdAt: 4, seq: 4, text: 'Agent could not start' },
        ];
        const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
        const input = { messageIdsOldestFirst: messages.map((message) => message.id), messagesById, pendingMessages: [blocked] };
        const cache = buildTranscriptTurnsCached({ ...input, cache: null, groupToolCalls: true, toolCallsGroupStrategy: 'consecutive_tools' });
        const sourceItems = cache.turns.map((turn) => ({ kind: 'turn' as const, id: turn.id, turn }));
        const items = projectPendingTranscriptItems({ ...input, items: sourceItems });
        expect(items.map((item) => item.kind)).toEqual(followUp ? ['turn', 'turn', 'pending-queue'] : ['turn', 'pending-queue']);
        expect(items.at(-2)).toMatchObject({ kind: 'turn', id: sourceItems.at(-1)?.id, turn: { userMessageId: null, content: [{ kind: 'message', messageId: 'failure' }] } });
        expect(items.at(-1)).toMatchObject({ kind: 'pending-queue', id: 'pending-queue', pendingMessages: [blocked] });
        if (followUp) expect(items[0]).toBe(sourceItems[0]);

        // Both transcript hosts decompose these projected turns through this real builder.
        const rows = buildTranscriptTurnUnits({ items, getMessageById: (id) => messagesById[id] ?? null, collapsedPreviewCount: 0, isGroupExpanded: () => false });
        expect(rows.map((row) => row.kind === 'message' ? row.messageId : row.kind)).toEqual(
            followUp ? ['previous-user', 'previous-answer', 'failure', 'pending-queue'] : ['failure', 'pending-queue'],
        );

        const delivering = projectPendingTranscriptItems({ ...input, items: sourceItems, pendingMessages: [{ ...blocked, pendingDeliveryStatus: 'server_delivering' }] });
        expect(delivering).toEqual(sourceItems);
    });

    it('holds every pending message in one section even when several retries were committed between failures', () => {
        const second: PendingMessage = { ...blocked, id: 'retry-2', localId: 'retry-2-local', createdAt: 7, updatedAt: 8 };
        const queued: PendingMessage = { id: 'next', localId: 'next-local', createdAt: 9, updatedAt: 9, text: 'And then this',
            rawRecord: {}, source: 'server_pending' };
        const messages: Message[] = [
            { kind: 'user-text', id: 'u1', localId: 'retry-local', createdAt: 3, seq: 1, text: 'Please continue' },
            { kind: 'agent-text', id: 'f1', localId: null, createdAt: 4, seq: 2, text: 'Usage limit reached' },
            { kind: 'user-text', id: 'u2', localId: 'retry-2-local', createdAt: 7, seq: 3, text: 'Please continue' },
            { kind: 'agent-text', id: 'f2', localId: null, createdAt: 8, seq: 4, text: 'Provider session failed' },
        ];
        const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
        const items = projectPendingTranscriptItems({
            items: messages.map((message) => ({ kind: 'message' as const, id: `msg:${message.id}`, messageId: message.id, createdAt: message.createdAt, seq: message.seq })),
            messageIdsOldestFirst: messages.map((message) => message.id), messagesById, pendingMessages: [blocked, second, queued],
        });
        expect(items.map((item) => item.kind === 'message' ? item.messageId : item.kind)).toEqual(['f1', 'f2', 'pending-queue']);
        expect(items.at(-1)).toMatchObject({ kind: 'pending-queue', pendingMessages: [blocked, second, queued] });
    });

    it('docks discarded recovery controls in the tail section without an empty turn or duplicate tail', () => {
        const message: Message = { kind: 'user-text', id: 'user', localId: 'retry-local', createdAt: 3, seq: 1, text: 'Please continue' };
        const discarded = { ...blocked, discardedAt: 5, discardedReason: 'manual' as const };
        const items = projectPendingTranscriptItems({
            items: [{ kind: 'turn', id: 'turn:user', turn: { id: 'turn:user', userMessageId: 'user', content: [] } }],
            messageIdsOldestFirst: ['user'], messagesById: { user: message }, pendingMessages: [], discardedMessages: [discarded],
        });
        expect(items).toMatchObject([{ kind: 'pending-queue', pendingMessages: [], discardedMessages: [discarded] }]);
    });

    it('yields a non-durable discarded twin to its committed message through the canonical crossover', () => {
        const message: Message = { kind: 'user-text', id: 'user', localId: 'retry-local', createdAt: 3, seq: 1, text: 'Please continue' };
        const committed = { kind: 'message' as const, id: 'msg:user', messageId: 'user', createdAt: 3, seq: 1 };
        const items = projectPendingTranscriptItems({ items: [committed], messageIdsOldestFirst: ['user'],
            messagesById: { user: message }, pendingMessages: [],
            discardedMessages: [{ ...blocked, source: 'local_outbound', discardedAt: 5, discardedReason: 'manual' }],
        });
        expect(items).toEqual([committed]);
    });
});
