import type { ToolCall } from '@/sync/domains/messages/messageTypes';

export function makeTool(overrides: Partial<ToolCall>): ToolCall {
    return {
        name: 'unknown' as const,
        state: 'completed',
        input: {},
        result: '',
        createdAt: 0,
        startedAt: 0,
        completedAt: 1,
        description: null,
        ...overrides,
    };
}
