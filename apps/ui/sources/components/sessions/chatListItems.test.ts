import { describe, expect, it } from 'vitest';
import type { PendingMessage } from '@/sync/storageTypes';
import type { Message, ToolCall } from '@/sync/typesMessage';
import { buildChatListItems } from './chatListItems';

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
    it('prepends pending messages before transcript messages', () => {
        const messages: Message[] = [
            { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, text: 'agent' },
            { kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'user' },
        ];
        const pending: PendingMessage[] = [
            buildPending({ id: 'p1', localId: 'p1', createdAt: 10, text: 'pending 1' }),
            buildPending({ id: 'p2', localId: 'p2', createdAt: 11, text: 'pending 2' }),
        ];

        const items = buildChatListItems({ messages, pendingMessages: pending });

        expect(items.map((item) => item.kind)).toEqual(['pending-user-text', 'pending-user-text', 'message', 'message']);
        expect(items[0]?.kind === 'pending-user-text' && items[0].pending.localId).toBe('p1');
        expect(items[1]?.kind === 'pending-user-text' && items[1].pending.localId).toBe('p2');
        expect(items[2]?.kind === 'message' && items[2].message.id).toBe('m2');
        expect(items[3]?.kind === 'message' && items[3].message.id).toBe('m1');
    });

    it('drops pending messages that are already materialized in transcript user/tool messages', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'm-user', localId: 'p1', createdAt: 20, text: 'materialized user' },
            buildToolCallMessage({ id: 'm-tool', localId: 'p2', createdAt: 21 }),
            { kind: 'agent-event', id: 'm-event', createdAt: 22, event: { type: 'message', message: 'event' } },
        ];
        const pending: PendingMessage[] = [
            buildPending({ id: 'p1-a', localId: 'p1', createdAt: 10 }),
            buildPending({ id: 'p2-a', localId: 'p2', createdAt: 11 }),
            buildPending({ id: 'p3-a', localId: 'p3', createdAt: 12 }),
        ];

        const items = buildChatListItems({ messages, pendingMessages: pending });
        const ids = items.map((item) => (item.kind === 'pending-user-text' ? item.pending.localId : item.message.id));
        expect(ids).toEqual(['p3', 'm-user', 'm-tool', 'm-event']);
    });

    it('uses fallback ids for pending messages without localId', () => {
        const pending: PendingMessage[] = [
            buildPending({ id: 'p-null', localId: null, createdAt: 1 }),
            buildPending({ id: 'p-empty', localId: '', createdAt: 2 }),
        ];

        const items = buildChatListItems({ messages: [], pendingMessages: pending });
        const pendingIds = items.filter((item) => item.kind === 'pending-user-text').map((item) => item.id);

        expect(pendingIds).toEqual(['pending:fallback-0', 'pending:fallback-1']);
    });

    it('sets otherPendingCount from the filtered pending list', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'm1', localId: 'drop-me', createdAt: 1, text: 'materialized' },
        ];
        const pending: PendingMessage[] = [
            buildPending({ id: 'p-drop', localId: 'drop-me', createdAt: 10 }),
            buildPending({ id: 'p-keep-1', localId: 'keep-1', createdAt: 11 }),
            buildPending({ id: 'p-keep-2', localId: 'keep-2', createdAt: 12 }),
        ];

        const items = buildChatListItems({ messages, pendingMessages: pending });
        const pendingItems = items.filter((item) => item.kind === 'pending-user-text');

        expect(pendingItems).toHaveLength(2);
        expect(pendingItems[0]?.otherPendingCount).toBe(1);
        expect(pendingItems[1]?.otherPendingCount).toBe(0);
    });
});
