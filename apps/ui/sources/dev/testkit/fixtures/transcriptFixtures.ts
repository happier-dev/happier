import type { Message, ToolCall, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';
import { createReducer } from '@/sync/reducer/reducer';
import type { SessionMessages } from '@/sync/store/domains/messages';

export function createPendingMessageFixture(overrides: Partial<PendingMessage> = {}): PendingMessage {
    const createdAt = overrides.createdAt ?? 1;
    const updatedAt = overrides.updatedAt ?? createdAt;

    return {
        id: 'pending-1',
        localId: 'local-pending-1',
        createdAt,
        updatedAt,
        text: 'pending message',
        rawRecord: {},
        ...overrides,
    };
}

export function createDiscardedPendingMessageFixture(
    overrides: Partial<DiscardedPendingMessage> = {},
): DiscardedPendingMessage {
    const base = createPendingMessageFixture(overrides);
    return {
        ...base,
        discardedAt: overrides.discardedAt ?? base.updatedAt,
        discardedReason: overrides.discardedReason ?? 'manual',
    };
}

export function createSessionMessagesFixture(overrides: Partial<SessionMessages> = {}): SessionMessages {
    const messagesById = overrides.messagesById ?? {};

    return {
        messageIdsOldestFirst: [],
        messagesById,
        messagesMap: overrides.messagesMap ?? messagesById,
        draftsByLocalId: {},
        reducerState: createReducer(),
        reducerVersion: 0,
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        messagesVersion: 0,
        isLoaded: false,
        ...overrides,
    };
}

export function createToolCallMessageFixture(overrides: Partial<ToolCallMessage> = {}): ToolCallMessage {
    const createdAt = overrides.createdAt ?? 1;
    const toolOverrides = overrides.tool ?? {};
    const defaultTool: ToolCall = {
        name: 'edit',
        state: 'running',
        input: {},
        createdAt,
        startedAt: createdAt,
        completedAt: null,
        description: null,
    };

    return {
        kind: 'tool-call',
        id: overrides.id ?? 'tool-call-1',
        localId: overrides.localId ?? null,
        createdAt,
        tool: {
            ...defaultTool,
            ...toolOverrides,
        },
        children: (overrides.children ?? []) as Message[],
        ...overrides,
    };
}
