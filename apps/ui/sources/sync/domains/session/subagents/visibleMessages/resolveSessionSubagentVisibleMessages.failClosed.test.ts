import { describe, expect, it, vi } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

vi.mock('@/agents/registry/generatedBundledPluginEntries.visibleMessageResolvers', () => ({
    BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_DESCRIPTORS: [],
    BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_REGISTRY: [
        {
            agentId: 'claude',
            resolveVisibleMessages: () => {
                throw new Error('broken generated descriptor adapter');
            },
        },
    ],
}));

function createToolMessage(): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 1,
        children: [],
        tool: {
            name: 'Agent',
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
        },
    };
}

function createMessage(id: string): Message {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: 1,
        text: 'keep',
        meta: undefined,
    };
}

describe('resolveSessionSubagentVisibleMessages fail-closed handling', () => {
    it('keeps focused messages when a generated resolver throws', async () => {
        const { resolveSessionSubagentVisibleMessages } = await import('./resolveSessionSubagentVisibleMessages');
        const focusedMessages = [createMessage('m1')];

        expect(resolveSessionSubagentVisibleMessages({
            session: { metadata: { flavor: 'claude' } } as any,
            tool: createToolMessage().tool,
            messages: [],
            focusedMessages,
        })).toEqual(focusedMessages);
    });
});
