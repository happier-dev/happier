import { describe, expect, it } from 'vitest';

import { splitOversizedTranscriptTurnItems } from './splitOversizedTranscriptTurnItems';

function message(id: string, createdAt: number) {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt,
        text: id,
    } as any;
}

function toolMessage(id: string, createdAt: number) {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        tool: {
            id: `call:${id}`,
            name: 'tool',
            state: 'completed',
            input: {},
            createdAt,
            startedAt: createdAt,
            completedAt: createdAt + 1,
        },
        children: [],
    } as any;
}

describe('splitOversizedTranscriptTurnItems', () => {
    it('preserves one semantic tool-call group when projecting an oversized turn into list rows', () => {
        const toolIds = Array.from({ length: 10 }, (_, index) => `tool-${index + 1}`);
        const messagesById = Object.fromEntries(toolIds.map((id, index) => [id, toolMessage(id, index + 1)]));

        const result = splitOversizedTranscriptTurnItems({
            items: [
                {
                    kind: 'turn',
                    id: 'turn:user-1',
                    turn: {
                        id: 'turn:user-1',
                        userMessageId: null,
                        content: [
                            {
                                kind: 'tool_calls',
                                id: 'tools:user-1',
                                toolMessageIds: toolIds,
                            },
                        ],
                    },
                },
            ],
            maxTurnEntriesPerListItem: 4,
            messagesById,
        });

        expect(result.map((item) => item.kind)).toEqual(['tool-calls-group']);
        const groups = result.filter((item) => item.kind === 'tool-calls-group');
        expect(groups).toHaveLength(1);
        expect(groups[0]?.toolMessageIds).toEqual(toolIds);
        expect(groups[0]?.id).toBe('tools:user-1');
        expect(result.some((item) => String(item.id).includes(':chunk:'))).toBe(false);
    });

    it('preserves small tool-call groups as a single turn row', () => {
        const messagesById = {
            'agent-1': message('agent-1', 1),
            'tool-1': toolMessage('tool-1', 2),
            'tool-2': toolMessage('tool-2', 3),
        };
        const input = [
            {
                kind: 'turn' as const,
                id: 'turn:user-1',
                turn: {
                    id: 'turn:user-1',
                    userMessageId: null,
                    content: [
                        { kind: 'message' as const, messageId: 'agent-1' },
                        {
                            kind: 'tool_calls' as const,
                            id: 'tools:user-1',
                            toolMessageIds: ['tool-1', 'tool-2'],
                        },
                    ],
                },
            },
        ];

        expect(splitOversizedTranscriptTurnItems({
            items: input,
            maxTurnEntriesPerListItem: 4,
            messagesById,
        })).toBe(input);
    });
});
