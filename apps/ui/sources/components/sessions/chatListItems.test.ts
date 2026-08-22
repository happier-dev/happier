import { describe, expect, it } from 'vitest';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { AgentTextMessage, Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import { buildChatListItems, buildChatListItemsCached } from './chatListItems';

function buildPending(params: {
    id: string;
    localId: string | null;
    createdAt: number;
    text?: string;
    source?: PendingMessage['source'];
    pendingDeliveryStatus?: PendingMessage['pendingDeliveryStatus'];
}): PendingMessage {
    return {
        id: params.id,
        localId: params.localId,
        createdAt: params.createdAt,
        updatedAt: params.createdAt,
        ...(params.source ? { source: params.source } : {}),
        ...(params.pendingDeliveryStatus ? { pendingDeliveryStatus: params.pendingDeliveryStatus } : {}),
        text: params.text ?? params.id,
        rawRecord: {},
    };
}

function buildToolCallMessage(params: {
    id: string;
    localId: string | null;
    createdAt: number;
    state?: 'running' | 'completed' | 'error';
    name?: string;
    input?: Record<string, unknown>;
    requestKind?: 'permission' | 'user_action';
}): Message {
    const state = params.state ?? 'completed';
    const tool: ToolCall = {
        name: params.name ?? 'read',
        state,
        input: params.input ?? {},
        createdAt: params.createdAt,
        startedAt: params.createdAt,
        completedAt: state === 'running' ? null : params.createdAt + 1,
        description: null,
        result: {},
        permission: params.requestKind
            ? {
                id: `perm:${params.id}`,
                status: state === 'running' ? 'pending' : 'approved',
                kind: params.requestKind,
            }
            : undefined,
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

    it('appends pending user-action requests as transcript rows when no transcript tool call exists', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'user' },
            { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, text: 'agent' },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));

        const items = buildChatListItems({
            messageIdsOldestFirst: messages.map((m) => m.id),
            messagesById,
            pendingMessages: [],
            pendingUserActionRequests: [
                {
                    id: 'resume_choice',
                    tool: 'AskUserQuestion',
                    kind: 'user_action',
                    arguments: { question: 'How should Claude resume this session?' },
                    createdAt: 3,
                },
            ],
        });

        expect(items.map((item) => item.kind)).toEqual(['message', 'message', 'pending-user-action']);
        expect(items[2]).toEqual(expect.objectContaining({
            id: 'pending-user-action:resume_choice',
            kind: 'pending-user-action',
            createdAt: 3,
        }));
    });

    it('does not duplicate a pending user-action request that already has a transcript tool row', () => {
        const messages: Message[] = [
            buildToolCallMessage({
                id: 'ask',
                localId: null,
                createdAt: 3,
                state: 'running',
                name: 'AskUserQuestion',
                requestKind: 'user_action',
            }),
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));

        const items = buildChatListItems({
            messageIdsOldestFirst: messages.map((m) => m.id),
            messagesById,
            pendingMessages: [],
            pendingUserActionRequests: [
                {
                    id: 'perm:ask',
                    tool: 'AskUserQuestion',
                    kind: 'user_action',
                    arguments: { question: 'Continue?' },
                    createdAt: 3,
                },
            ],
        });

        expect(items.map((item) => item.kind)).toEqual(['message']);
    });

    it('reuses cached committed transcript items when only pending user-action requests are appended', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'user' },
            { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, text: 'agent' },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));
        const base = buildChatListItemsCached({
            cache: null,
            messageIdsOldestFirst: messages.map((m) => m.id),
            messagesById,
            pendingMessages: [],
        });

        const next = buildChatListItemsCached({
            cache: base.cache,
            messageIdsOldestFirst: messages.map((m) => m.id),
            messagesById,
            pendingMessages: [],
            pendingUserActionRequests: [
                {
                    id: 'resume_choice',
                    tool: 'AskUserQuestion',
                    kind: 'user_action',
                    arguments: { question: 'How should Claude resume this session?' },
                    createdAt: 3,
                },
            ],
        });

        expect(next.items.map((item) => item.kind)).toEqual(['message', 'message', 'pending-user-action']);
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
            { kind: 'agent-event', localId: null, id: 'm-event', createdAt: 22, event: { type: 'message', message: 'event' } },
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
                case 'pending-user-action':
                    return item.request.id;
                case 'message':
                    return item.messageId;
                case 'action-draft':
                    return item.draft.id;
                case 'fork-divider':
                    return item.id;
                case 'tool-calls-group':
                    return item.toolMessageIds;
                case 'external-session-operation':
                    return item.id;
                case 'plugin-transcript-activity':
                    return item.id;
                default: {
                    const _exhaustive: never = item;
                    return _exhaustive;
                }
            }
        });
        expect(ids).toEqual(['m-user', 'm-tool', 'm-event', 'p3']);
    });

    it('hides started compaction event rows after a terminal event with the same lifecycle id is present', () => {
        const messages: Message[] = [
            {
                kind: 'agent-event',
                localId: null,
                id: 'm-compact-started',
                createdAt: 20,
                event: {
                    type: 'context-compaction',
                    phase: 'started',
                    lifecycleId: 'compact_1',
                    provider: 'codex',
                },
            },
            {
                kind: 'agent-event',
                localId: null,
                id: 'm-other-started',
                createdAt: 21,
                event: {
                    type: 'message',
                    message: 'Preparing workspace',
                    lifecycleId: 'workspace_1',
                },
            },
            {
                kind: 'agent-event',
                localId: null,
                id: 'm-compact-completed',
                createdAt: 22,
                event: {
                    type: 'context-compaction',
                    phase: 'completed',
                    lifecycleId: 'compact_1',
                    provider: 'codex',
                },
            },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));

        const items = buildChatListItems({
            messageIdsOldestFirst: messages.map((m) => m.id),
            messagesById,
            pendingMessages: [],
        });

        expect(items.flatMap((item) => item.kind === 'message' ? item.messageId : [])).toEqual([
            'm-other-started',
            'm-compact-completed',
        ]);
    });

    it('keeps compaction lifecycle rows independent when lifecycle ids differ', () => {
        const messages: Message[] = [
            {
                kind: 'agent-event',
                localId: null,
                id: 'm-compact-started',
                createdAt: 20,
                event: {
                    type: 'context-compaction',
                    phase: 'started',
                    lifecycleId: 'compact-start',
                    provider: 'claude',
                },
            },
            {
                kind: 'agent-event',
                localId: null,
                id: 'm-compact-completed',
                createdAt: 22,
                event: {
                    type: 'context-compaction',
                    phase: 'completed',
                    lifecycleId: 'compact-complete',
                    provider: 'claude',
                },
            },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));

        const items = buildChatListItems({
            messageIdsOldestFirst: messages.map((m) => m.id),
            messagesById,
            pendingMessages: [],
        });

        expect(items.flatMap((item) => item.kind === 'message' ? item.messageId : [])).toEqual([
            'm-compact-started',
            'm-compact-completed',
        ]);
    });

    it('keeps compaction lifecycle rows without lifecycle ids independent', () => {
        const messages: Message[] = [
            {
                kind: 'agent-event',
                localId: null,
                id: 'm-compact-started',
                createdAt: 20,
                event: {
                    type: 'context-compaction',
                    phase: 'started',
                    provider: 'claude',
                },
            },
            {
                kind: 'agent-event',
                localId: null,
                id: 'm-compact-completed',
                createdAt: 22,
                event: {
                    type: 'context-compaction',
                    phase: 'completed',
                    provider: 'claude',
                },
            },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));

        const items = buildChatListItems({
            messageIdsOldestFirst: messages.map((m) => m.id),
            messagesById,
            pendingMessages: [],
        });

        expect(items.flatMap((item) => item.kind === 'message' ? item.messageId : [])).toEqual([
            'm-compact-started',
            'm-compact-completed',
        ]);
    });

    it('renders only the latest compaction row for a lifecycle id', () => {
        const messages: Message[] = [
            {
                kind: 'agent-event',
                localId: null,
                id: 'm-compact-started',
                createdAt: 20,
                event: {
                    type: 'context-compaction',
                    phase: 'started',
                    lifecycleId: 'compact_1',
                    provider: 'claude',
                },
            },
            {
                kind: 'agent-event',
                localId: null,
                id: 'm-compact-progress',
                createdAt: 21,
                event: {
                    type: 'context-compaction',
                    phase: 'progress',
                    lifecycleId: 'compact_1',
                    provider: 'claude',
                },
            },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));

        const items = buildChatListItems({
            messageIdsOldestFirst: messages.map((m) => m.id),
            messagesById,
            pendingMessages: [],
        });

        expect(items.flatMap((item) => item.kind === 'message' ? item.messageId : [])).toEqual([
            'm-compact-progress',
        ]);
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
    it('starts a new tool-call group before a fork boundary message', () => {
        const messages: Message[] = [
            buildToolCallMessage({ id: 'parent-tool', localId: null, createdAt: 1 }),
            buildToolCallMessage({ id: 'child-tool', localId: null, createdAt: 2 }),
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));
        const buildWithForkBoundaries = buildChatListItemsCached as (
            opts: Parameters<typeof buildChatListItemsCached>[0] & {
                forkBoundaryBeforeMessageIds?: ReadonlySet<string>;
                forkBoundarySignature?: string;
            }
        ) => ReturnType<typeof buildChatListItemsCached>;

        const result = buildWithForkBoundaries({
            cache: null,
            messageIdsOldestFirst: ['parent-tool', 'child-tool'],
            messagesById,
            pendingMessages: [],
            groupConsecutiveToolCalls: true,
            forkBoundaryBeforeMessageIds: new Set(['child-tool']),
            forkBoundarySignature: 'child-tool',
        });

        expect(result.items.map((item) => item.kind)).toEqual(['tool-calls-group', 'tool-calls-group']);
        expect(result.items[0]?.kind === 'tool-calls-group' && result.items[0].toolMessageIds).toEqual(['parent-tool']);
        expect(result.items[1]?.kind === 'tool-calls-group' && result.items[1].toolMessageIds).toEqual(['child-tool']);
    });

    it('annotates grouped tool calls with homogeneous fork origin metadata', () => {
        const messages: Message[] = [
            buildToolCallMessage({ id: 'parent-tool-1', localId: null, createdAt: 1 }),
            buildToolCallMessage({ id: 'parent-tool-2', localId: null, createdAt: 2 }),
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));
        const buildWithForkMetadata = buildChatListItemsCached as (
            opts: Parameters<typeof buildChatListItemsCached>[0] & {
                forkMetadataByMessageId?: Readonly<Record<string, { originSessionId: string; isReadOnlyContext: boolean }>>;
            }
        ) => ReturnType<typeof buildChatListItemsCached>;

        const result = buildWithForkMetadata({
            cache: null,
            messageIdsOldestFirst: ['parent-tool-1', 'parent-tool-2'],
            messagesById,
            pendingMessages: [],
            groupConsecutiveToolCalls: true,
            forkMetadataByMessageId: {
                'parent-tool-1': { originSessionId: 'parent', isReadOnlyContext: true },
                'parent-tool-2': { originSessionId: 'parent', isReadOnlyContext: true },
            },
        });

        expect(result.items[0]).toMatchObject({
            kind: 'tool-calls-group',
            originSessionId: 'parent',
            isReadOnlyContext: true,
        });
    });

    it('starts a new appended tool-call group before a fork boundary message', () => {
        const messages: Message[] = [
            buildToolCallMessage({ id: 'parent-tool', localId: null, createdAt: 1 }),
            buildToolCallMessage({ id: 'child-tool', localId: null, createdAt: 2 }),
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));
        const buildWithForkBoundaries = buildChatListItemsCached as (
            opts: Parameters<typeof buildChatListItemsCached>[0] & {
                forkBoundaryBeforeMessageIds?: ReadonlySet<string>;
                forkBoundarySignature?: string;
            }
        ) => ReturnType<typeof buildChatListItemsCached>;

        const before = buildWithForkBoundaries({
            cache: null,
            messageIdsOldestFirst: ['parent-tool'],
            messagesById,
            pendingMessages: [],
            groupConsecutiveToolCalls: true,
            forkBoundaryBeforeMessageIds: new Set(['child-tool']),
            forkBoundarySignature: 'child-tool',
        });

        const after = buildWithForkBoundaries({
            cache: before.cache,
            messageIdsOldestFirst: ['parent-tool', 'child-tool'],
            messagesById,
            pendingMessages: [],
            groupConsecutiveToolCalls: true,
            forkBoundaryBeforeMessageIds: new Set(['child-tool']),
            forkBoundarySignature: 'child-tool',
        });

        expect(after.items.map((item) => item.kind)).toEqual(['tool-calls-group', 'tool-calls-group']);
        expect(after.items[0]).toBe(before.items[0]);
        expect(after.items[1]?.kind === 'tool-calls-group' && after.items[1].toolMessageIds).toEqual(['child-tool']);
    });

    it('reuses the item array when only an existing message body streams', () => {
        const agentMessage: AgentTextMessage = { kind: 'agent-text', id: 'm-2', localId: null, createdAt: 2, text: 'hello' };
        const initialMessagesById: Record<string, Message> = {
            'm-1': { kind: 'user-text', id: 'm-1', localId: 'u1', createdAt: 1, text: 'user' },
            'm-2': agentMessage,
        };

        const before = buildChatListItemsCached({
            cache: null,
            messageIdsOldestFirst: ['m-1', 'm-2'],
            messagesById: initialMessagesById,
            pendingMessages: [],
        });
        const after = buildChatListItemsCached({
            cache: before.cache,
            messageIdsOldestFirst: ['m-1', 'm-2'],
            messagesById: {
                ...initialMessagesById,
                'm-2': { ...agentMessage, text: 'hello streaming update' },
            },
            pendingMessages: [],
        });

        expect(after.items).toBe(before.items);
    });

    it('rebuilds cached items when an existing message changes structure in the same source map', () => {
        const messagesById: Record<string, Message> = {
            'm-1': { kind: 'user-text', id: 'm-1', localId: 'u1', createdAt: 1, text: 'user' },
            'm-2': { kind: 'agent-text', id: 'm-2', localId: null, createdAt: 2, text: 'agent' },
        };
        const messageIdsOldestFirst = ['m-1', 'm-2'];
        const before = buildChatListItemsCached({
            cache: null,
            messageIdsOldestFirst,
            messagesById,
            pendingMessages: [],
            groupConsecutiveToolCalls: true,
        });

        messagesById['m-2'] = buildToolCallMessage({ id: 'm-2', localId: null, createdAt: 2 });
        const after = buildChatListItemsCached({
            cache: before.cache,
            messageIdsOldestFirst,
            messagesById,
            pendingMessages: [],
            groupConsecutiveToolCalls: true,
        });

        expect(after.items).not.toBe(before.items);
        expect(after.items[1]?.kind).toBe('tool-calls-group');
    });

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

    it('hides cached started compaction event rows after appending a terminal event with the same lifecycle id', () => {
        const messages: Message[] = [
            {
                kind: 'agent-event',
                localId: null,
                id: 'm-compact-started',
                createdAt: 20,
                event: {
                    type: 'context-compaction',
                    phase: 'started',
                    lifecycleId: 'compact_1',
                    provider: 'codex',
                },
            },
            {
                kind: 'agent-event',
                localId: null,
                id: 'm-compact-completed',
                createdAt: 22,
                event: {
                    type: 'context-compaction',
                    phase: 'completed',
                    lifecycleId: 'compact_1',
                    provider: 'codex',
                },
            },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));

        const before = buildChatListItemsCached({
            cache: null,
            messageIdsOldestFirst: ['m-compact-started'],
            messagesById,
            pendingMessages: [],
        });
        const after = buildChatListItemsCached({
            cache: before.cache,
            messageIdsOldestFirst: ['m-compact-started', 'm-compact-completed'],
            messagesById,
            pendingMessages: [],
        });

        expect(before.items.flatMap((item) => item.kind === 'message' ? item.messageId : [])).toEqual(['m-compact-started']);
        expect(after.items.flatMap((item) => item.kind === 'message' ? item.messageId : [])).toEqual(['m-compact-completed']);
    });

    it('keeps cached compaction lifecycle rows independent when lifecycle ids differ', () => {
        const messages: Message[] = [
            {
                kind: 'agent-event',
                localId: null,
                id: 'm-compact-started',
                createdAt: 20,
                event: {
                    type: 'context-compaction',
                    phase: 'started',
                    lifecycleId: 'compact-start',
                    provider: 'claude',
                },
            },
            {
                kind: 'agent-event',
                localId: null,
                id: 'm-compact-completed',
                createdAt: 22,
                event: {
                    type: 'context-compaction',
                    phase: 'completed',
                    lifecycleId: 'compact-complete',
                    provider: 'claude',
                },
            },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));

        const before = buildChatListItemsCached({
            cache: null,
            messageIdsOldestFirst: ['m-compact-started'],
            messagesById,
            pendingMessages: [],
        });
        const after = buildChatListItemsCached({
            cache: before.cache,
            messageIdsOldestFirst: ['m-compact-started', 'm-compact-completed'],
            messagesById,
            pendingMessages: [],
        });

        expect(before.items.flatMap((item) => item.kind === 'message' ? item.messageId : [])).toEqual(['m-compact-started']);
        expect(after.items.flatMap((item) => item.kind === 'message' ? item.messageId : [])).toEqual([
            'm-compact-started',
            'm-compact-completed',
        ]);
    });

    it('groups consecutive tool-call messages into a tool-calls-group item when enabled', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'user' },
            buildToolCallMessage({ id: 't1', localId: null, createdAt: 2 }),
            buildToolCallMessage({ id: 't2', localId: null, createdAt: 3 }),
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 4, text: 'agent' },
            buildToolCallMessage({ id: 't3', localId: null, createdAt: 5 }),
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));

        const r1 = buildChatListItemsCached({
            cache: null,
            messageIdsOldestFirst: ['u1', 't1', 't2', 'a1', 't3'],
            messagesById,
            pendingMessages: [],
            groupConsecutiveToolCalls: true,
        });

        expect(r1.items.map((item) => item.kind)).toEqual(['message', 'tool-calls-group', 'message', 'tool-calls-group']);
        expect(r1.items[0]?.kind === 'message' && r1.items[0].messageId).toBe('u1');
        expect(r1.items[1]?.kind === 'tool-calls-group' && r1.items[1].toolMessageIds).toEqual(['t1', 't2']);
        expect(r1.items[2]?.kind === 'message' && r1.items[2].messageId).toBe('a1');
        expect(r1.items[3]?.kind === 'tool-calls-group' && r1.items[3].toolMessageIds).toEqual(['t3']);
    });

    it('does not group pending user-action tool-call messages when grouping is enabled', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'user' },
            buildToolCallMessage({ id: 't1', localId: null, createdAt: 2 }),
            buildToolCallMessage({ id: 'ask', localId: null, createdAt: 3, state: 'running', requestKind: 'user_action' }),
            buildToolCallMessage({ id: 't2', localId: null, createdAt: 4 }),
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));

        const r1 = buildChatListItemsCached({
            cache: null,
            messageIdsOldestFirst: ['u1', 't1', 'ask', 't2'],
            messagesById,
            pendingMessages: [],
            groupConsecutiveToolCalls: true,
        });

        expect(r1.items.map((item) => item.kind)).toEqual(['message', 'tool-calls-group', 'message', 'tool-calls-group']);
        expect(r1.items[1]?.kind === 'tool-calls-group' && r1.items[1].toolMessageIds).toEqual(['t1']);
        expect(r1.items[2]?.kind === 'message' && r1.items[2].messageId).toBe('ask');
        expect(r1.items[3]?.kind === 'tool-calls-group' && r1.items[3].toolMessageIds).toEqual(['t2']);
    });

    it('keeps canonical turn-diff recap tools outside consecutive tool-call groups', () => {
        const messages: Message[] = [
            buildToolCallMessage({ id: 't1', localId: null, createdAt: 1 }),
            buildToolCallMessage({
                id: 'diff-1',
                localId: null,
                createdAt: 2,
                name: 'Diff',
                input: {
                    unified_diff: [
                        'diff --git a/apps/ui/a.ts b/apps/ui/a.ts',
                        '--- a/apps/ui/a.ts',
                        '+++ b/apps/ui/a.ts',
                        '@@ -1,1 +1,1 @@',
                        '-old',
                        '+new',
                    ].join('\n'),
                    _happier: {
                        sessionChangeScope: 'turn',
                        turnId: 'turn-1',
                        sessionId: 'session-1',
                        provider: 'codex',
                        source: 'canonical_diff_tool',
                        confidence: 'exact',
                        turnStatus: 'completed',
                        seqRange: {
                            startSeqInclusive: 1,
                            endSeqInclusive: 2,
                        },
                    },
                },
            }),
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));

        const r1 = buildChatListItemsCached({
            cache: null,
            messageIdsOldestFirst: ['t1', 'diff-1'],
            messagesById,
            pendingMessages: [],
            groupConsecutiveToolCalls: true,
        });

        expect(r1.items.map((item) => item.kind)).toEqual(['tool-calls-group', 'message']);
        expect(r1.items[0]?.kind === 'tool-calls-group' && r1.items[0].toolMessageIds).toEqual(['t1']);
        expect(r1.items[1]?.kind === 'message' && r1.items[1].messageId).toBe('diff-1');
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
                case 'pending-user-action':
                    return item.request.id;
                case 'message':
                    return item.messageId;
                case 'action-draft':
                    return item.draft.id;
                case 'fork-divider':
                    return item.id;
                case 'tool-calls-group':
                    return item.toolMessageIds;
                case 'external-session-operation':
                    return item.id;
                case 'plugin-transcript-activity':
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
                case 'pending-user-action':
                    return item.request.id;
                case 'message':
                    return item.messageId;
                case 'action-draft':
                    return item.draft.id;
                case 'fork-divider':
                    return item.id;
                case 'tool-calls-group':
                    return item.toolMessageIds;
                case 'external-session-operation':
                    return item.id;
                case 'plugin-transcript-activity':
                    return item.id;
                default: {
                    const _exhaustive: never = item;
                    return _exhaustive;
                }
            }
        });
        expect(ids2).toEqual(['m-user', 'm2']);
    });

    it('keeps unresolved server pending rows visible when their committed transcript row exists', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'm-user', localId: 'p1', createdAt: 20, text: 'materialized user' },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));
        const pending: PendingMessage[] = [
            buildPending({
                id: 'p1-server',
                localId: 'p1',
                createdAt: 10,
                source: 'server_pending',
                pendingDeliveryStatus: 'server_delivering',
            }),
            buildPending({
                id: 'p1-local',
                localId: 'p1',
                createdAt: 11,
                source: 'local_outbound',
            }),
        ];

        const items = buildChatListItems({
            messageIdsOldestFirst: ['m-user'],
            messagesById,
            pendingMessages: pending,
        });

        expect(items.map((item) => item.kind)).toEqual(['pending-queue']);
        expect(items[0]?.kind === 'pending-queue' && items[0].pendingMessages.map((message) => message.id))
            .toEqual(['p1-server']);
    });

    it('keeps discarded server pending rows authoritative over their provisional committed transcript row', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'm-user', localId: 'p1', createdAt: 20, text: 'materialized user' },
        ];
        const messagesById = Object.fromEntries(messages.map((m) => [m.id, m]));
        const discarded = [{
            ...buildPending({
                id: 'p1-server',
                localId: 'p1',
                createdAt: 10,
                source: 'server_pending',
            }),
            discardedAt: 30,
            discardedReason: 'manual' as const,
        }];

        const items = buildChatListItems({
            messageIdsOldestFirst: ['m-user'],
            messagesById,
            pendingMessages: [],
            discardedMessages: discarded,
        });

        expect(items.map((item) => item.kind)).toEqual(['pending-queue']);
        expect(items[0]?.kind === 'pending-queue' && items[0].discardedMessages.map((message) => message.id))
            .toEqual(['p1-server']);
    });
});
