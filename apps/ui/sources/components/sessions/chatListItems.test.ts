import { describe, expect, it } from 'vitest';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import { buildChatListItems, buildChatListItemsCached } from './chatListItems';

function buildPending(params: {
    id: string;
    localId: string | null;
    createdAt: number;
    text?: string;
}): PendingMessage {
    return {
        id: params.id,
        localId: params.localId,
        createdAt: params.createdAt,
        updatedAt: params.createdAt,
        text: params.text ?? params.id,
        rawRecord: {},
    };
}

function buildToolCallMessage(params: {
    id: string;
    localId: string | null;
    createdAt: number;
}): Message {
    const tool: ToolCall = {
        name: 'read',
        state: 'completed',
        input: {},
        createdAt: params.createdAt,
        startedAt: params.createdAt,
        completedAt: params.createdAt + 1,
        description: null,
        result: {},
    };
    return {
        kind: 'tool-call',
        id: params.id,
        localId: params.localId,
        createdAt: params.createdAt,
        tool,
        children: [],
    };
}

describe('buildChatListItems', () => {
    it('can omit committed transcript message items (turns mode) while still including pending/drafts', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'user' },
            { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, text: 'agent' },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));
        const messageIdsOldestFirst = messages.map((m) => m.id);
        const pending: PendingMessage[] = [
            buildPending({ id: 'p1', localId: 'p1', createdAt: 10, text: 'pending 1' }),
        ];
        const drafts = [
            { id: 'd1', sessionId: 's1', actionId: 'review.start', createdAt: 20, status: 'editing', input: {} },
        ] as any[];

        const items = buildChatListItems({
            messageIdsOldestFirst,
            messagesById,
            pendingMessages: pending,
            actionDrafts: drafts as any,
            includeCommittedMessages: false,
        });

        expect(items.map((item) => item.kind)).toEqual(['pending-queue', 'action-draft']);
    });

    it('includes local-only action drafts after transcript messages and pending items', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'user' },
            { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, text: 'agent' },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));
        const messageIdsOldestFirst = messages.map((m) => m.id);
        const pending: PendingMessage[] = [
            buildPending({ id: 'p1', localId: 'p1', createdAt: 10, text: 'pending 1' }),
        ];
        const drafts = [
            { id: 'd1', sessionId: 's1', actionId: 'review.start', createdAt: 20, status: 'editing', input: {} },
        ] as any[];

        const items = buildChatListItems({ messageIdsOldestFirst, messagesById, pendingMessages: pending, actionDrafts: drafts as any });

        expect(items.map((item) => item.kind)).toEqual(['message', 'message', 'pending-queue', 'action-draft']);
        expect(items[3]?.kind === 'action-draft' && items[3].draft.id).toBe('d1');
    });

    it('appends pending messages after transcript messages', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'user' },
            { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, text: 'agent' },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));
        const messageIdsOldestFirst = messages.map((m) => m.id);
        const pending: PendingMessage[] = [
            buildPending({ id: 'p1', localId: 'p1', createdAt: 10, text: 'pending 1' }),
            buildPending({ id: 'p2', localId: 'p2', createdAt: 11, text: 'pending 2' }),
        ];

        const items = buildChatListItems({ messageIdsOldestFirst, messagesById, pendingMessages: pending });

        expect(items.map((item) => item.kind)).toEqual(['message', 'message', 'pending-queue']);
        expect(items[0]?.kind === 'message' && items[0].messageId).toBe('m1');
        expect(items[0]?.kind === 'message' && items[0].id).toBe('msg:m1');
        expect(items[1]?.kind === 'message' && items[1].messageId).toBe('m2');
        expect(items[1]?.kind === 'message' && items[1].id).toBe('msg:m2');
        expect(items[2]?.kind === 'pending-queue' && items[2].pendingMessages.map((p) => p.localId)).toEqual(['p1', 'p2']);
    });

    it('drops pending messages that are already materialized in transcript user/tool messages', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'm-user', localId: 'p1', createdAt: 20, text: 'materialized user' },
            buildToolCallMessage({ id: 'm-tool', localId: 'p2', createdAt: 21 }),
            { kind: 'agent-event', id: 'm-event', createdAt: 22, event: { type: 'message', message: 'event' } },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));
        const messageIdsOldestFirst = messages.map((m) => m.id);
        const pending: PendingMessage[] = [
            buildPending({ id: 'p1-a', localId: 'p1', createdAt: 10 }),
            buildPending({ id: 'p2-a', localId: 'p2', createdAt: 11 }),
            buildPending({ id: 'p3-a', localId: 'p3', createdAt: 12 }),
        ];

        const items = buildChatListItems({ messageIdsOldestFirst, messagesById, pendingMessages: pending });
        const ids = items.flatMap((item) => {
            switch (item.kind) {
                case 'pending-queue':
                    return item.pendingMessages.map((p) => p.localId);
                case 'message':
                    return item.messageId;
                case 'action-draft':
                    return item.draft.id;
                case 'fork-divider':
                    return item.id;
                default: {
                    const _exhaustive: never = item;
                    return _exhaustive;
                }
            }
        });
        expect(ids).toEqual(['m-user', 'm-tool', 'm-event', 'p3']);
    });

    it('keeps pending messages without localId in the pending queue item', () => {
        const pending: PendingMessage[] = [
            buildPending({ id: 'p-null', localId: null, createdAt: 1 }),
            buildPending({ id: 'p-empty', localId: '', createdAt: 2 }),
        ];

        const items = buildChatListItems({ messageIdsOldestFirst: [], messagesById: {}, pendingMessages: pending });
        const pendingQueue = items.find((item) => item.kind === 'pending-queue');
        expect(pendingQueue?.kind).toBe('pending-queue');
        expect(pendingQueue?.kind === 'pending-queue' && pendingQueue.pendingMessages.map((p) => p.localId)).toEqual([null, '']);
    });
});

describe('buildChatListItemsCached', () => {
    it('reuses committed message item objects on append-only id growth', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'user' },
            { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, text: 'agent' },
            { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, text: 'agent 2' },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));

        const r1 = buildChatListItemsCached({
            cache: null,
            messageIdsOldestFirst: ['m1', 'm2'],
            messagesById,
            pendingMessages: [],
        });

        const r2 = buildChatListItemsCached({
            cache: r1.cache,
            messageIdsOldestFirst: ['m1', 'm2', 'm3'],
            messagesById,
            pendingMessages: [],
        });

        expect(r1.items[0]?.kind).toBe('message');
        expect(r1.items[1]?.kind).toBe('message');
        expect(r2.items[0]?.kind).toBe('message');
        expect(r2.items[1]?.kind).toBe('message');
        expect(r2.items[2]?.kind).toBe('message');

        // Object identity stability is the entire point of caching.
        expect(r2.items[0]).toBe(r1.items[0]);
        expect(r2.items[1]).toBe(r1.items[1]);
    });

    it('still drops pending messages that are materialized in committed messages after append', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'm-user', localId: 'p1', createdAt: 20, text: 'materialized user' },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));

        const pending: PendingMessage[] = [
            buildPending({ id: 'p1-a', localId: 'p1', createdAt: 10 }),
            buildPending({ id: 'p2-a', localId: 'p2', createdAt: 11 }),
        ];

        const r1 = buildChatListItemsCached({
            cache: null,
            messageIdsOldestFirst: ['m-user'],
            messagesById,
            pendingMessages: pending,
        });

        const ids1 = r1.items.flatMap((item) => {
            switch (item.kind) {
                case 'pending-queue':
                    return item.pendingMessages.map((p) => p.localId);
                case 'message':
                    return item.messageId;
                case 'action-draft':
                    return item.draft.id;
                case 'fork-divider':
                    return item.id;
                default: {
                    const _exhaustive: never = item;
                    return _exhaustive;
                }
            }
        });
        expect(ids1).toEqual(['m-user', 'p2']);

        // Append a new committed message with localId 'p2' and confirm the pending item disappears.
        const m2: Message = { kind: 'user-text', id: 'm2', localId: 'p2', createdAt: 21, text: 'materialized 2' };
        const nextMessagesById = { ...messagesById, [m2.id]: m2 };

        const r2 = buildChatListItemsCached({
            cache: r1.cache,
            messageIdsOldestFirst: ['m-user', 'm2'],
            messagesById: nextMessagesById,
            pendingMessages: pending,
        });

        const ids2 = r2.items.flatMap((item) => {
            switch (item.kind) {
                case 'pending-queue':
                    return item.pendingMessages.map((p) => p.localId);
                case 'message':
                    return item.messageId;
                case 'action-draft':
                    return item.draft.id;
                case 'fork-divider':
                    return item.id;
                default: {
                    const _exhaustive: never = item;
                    return _exhaustive;
                }
            }
        });
        expect(ids2).toEqual(['m-user', 'm2']);
    });
});
