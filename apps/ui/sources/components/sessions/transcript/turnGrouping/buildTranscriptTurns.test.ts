import { describe, expect, it } from 'vitest';

import type { AgentTextMessage, Message, ToolCallMessage, UserTextMessage } from '@/sync/domains/messages/messageTypes';

import { buildTranscriptTurns, buildTranscriptTurnsCached } from './buildTranscriptTurns';

function userMessage(id: string, createdAt: number): UserTextMessage {
    return {
        kind: 'user-text',
        id,
        localId: null,
        createdAt,
        text: `user:${id}`,
    };
}

function agentMessage(id: string, createdAt: number): AgentTextMessage {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt,
        text: `agent:${id}`,
    };
}

function toolMessage(opts: {
    id: string;
    createdAt: number;
    state: 'running' | 'completed' | 'error';
    name?: string;
}): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: opts.id,
        localId: null,
        createdAt: opts.createdAt,
        tool: {
            id: `call:${opts.id}`,
            name: opts.name ?? 'tool',
            state: opts.state,
            input: {},
            createdAt: opts.createdAt,
            startedAt: opts.createdAt,
            completedAt: opts.state === 'running' ? null : opts.createdAt + 1,
            description: null,
            result: opts.state === 'completed' ? {} : undefined,
        },
        children: [],
    };
}

describe('buildTranscriptTurns', () => {
    it('groups messages into user/assistant turns (chronological turns, chronological content)', () => {
        // Chronological:
        // u1 -> a1 -> t1 -> t2 -> a2 -> u2 -> a3
        const chronological: Message[] = [
            userMessage('u1', 1),
            agentMessage('a1', 2),
            toolMessage({ id: 't1', createdAt: 3, state: 'completed' }),
            toolMessage({ id: 't2', createdAt: 4, state: 'completed' }),
            agentMessage('a2', 5),
            userMessage('u2', 6),
            agentMessage('a3', 7),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));
        const messageIdsOldestFirst = chronological.map((m) => m.id);

        const turns = buildTranscriptTurns({
            messageIdsOldestFirst,
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        expect(turns.map((t) => t.userMessageId)).toEqual(['u1', 'u2']);

        const [turn1, turn2] = turns;
        expect(turn1?.content.map((c) => c.kind)).toEqual(['message', 'tool_calls', 'message']);
        if (turn1?.content[0]?.kind === 'message') {
            expect(turn1.content[0].messageId).toBe('a1');
        }
        if (turn1?.content[1]?.kind === 'tool_calls') {
            expect(turn1.content[1].toolMessageIds).toEqual(['t1', 't2']);
        }
        if (turn1?.content[2]?.kind === 'message') {
            expect(turn1.content[2].messageId).toBe('a2');
        }

        expect(turn2?.content.map((c) => c.kind)).toEqual(['message']);
        expect(turn2?.content[0]?.kind).toBe('message');
        if (turn2?.content[0]?.kind === 'message') {
            expect(turn2.content[0].messageId).toBe('a3');
        }
    });

    it('creates an orphan turn for assistant/tool messages before the first user message', () => {
        // Chronological: a0 -> u1 -> a1
        const chronological: Message[] = [agentMessage('a0', 1), userMessage('u1', 2), agentMessage('a1', 3)];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));
        const messageIdsOldestFirst = chronological.map((m) => m.id);

        const turns = buildTranscriptTurns({
            messageIdsOldestFirst,
            messagesById,
            groupToolCalls: false,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        expect(turns.map((t) => t.userMessageId)).toEqual([null, 'u1']);

        const orphan = turns[0]!;
        expect(orphan.userMessageId).toBeNull();
        expect(orphan.content).toHaveLength(1);
        expect(orphan.content[0]?.kind).toBe('message');
        if (orphan.content[0]?.kind === 'message') {
            expect(orphan.content[0].messageId).toBe('a0');
        }
    });

    it('groups all tools in a turn into a single Activity section at the first tool position', () => {
        // Chronological:
        // u1 -> a1 -> t1 -> a2 -> t2 -> a3
        const chronological: Message[] = [
            userMessage('u1', 1),
            agentMessage('a1', 2),
            toolMessage({ id: 't1', createdAt: 3, state: 'completed' }),
            agentMessage('a2', 4),
            toolMessage({ id: 't2', createdAt: 5, state: 'error' }),
            agentMessage('a3', 6),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));
        const messageIdsOldestFirst = chronological.map((m) => m.id);

        const turns = buildTranscriptTurns({
            messageIdsOldestFirst,
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'all_tools_in_turn',
        });

        expect(turns).toHaveLength(1);
        const turn = turns[0]!;
        expect(turn.content.map((c) => c.kind)).toEqual(['message', 'tool_calls', 'message', 'message']);
        if (turn.content[1]?.kind === 'tool_calls') {
            expect(turn.content[1].toolMessageIds).toEqual(['t1', 't2']);
        }
    });

    it('flushes consecutive tool ids into an Activity section in consecutive_tools mode', () => {
        const chronological: Message[] = [
            userMessage('u1', 1),
            agentMessage('a1', 2),
            toolMessage({ id: 't1', createdAt: 3, state: 'completed' }),
            toolMessage({ id: 't2', createdAt: 4, state: 'running' }),
            agentMessage('a2', 5),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));
        const messageIdsOldestFirst = chronological.map((m) => m.id);

        const turns = buildTranscriptTurns({
            messageIdsOldestFirst,
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        expect(turns).toHaveLength(1);
        const toolCalls = turns[0]!.content.find((c) => c.kind === 'tool_calls');
        expect(toolCalls?.kind).toBe('tool_calls');
        if (toolCalls?.kind === 'tool_calls') {
            expect(toolCalls.toolMessageIds).toEqual(['t1', 't2']);
        }
    });
});

describe('buildTranscriptTurnsCached', () => {
    it('reuses prior turn objects when ids are appended (only last turn changes)', () => {
        const chronological: Message[] = [
            userMessage('u1', 1),
            agentMessage('a1', 2),
            userMessage('u2', 3),
            agentMessage('a2', 4),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));

        const cache1 = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: ['u1', 'a1', 'u2', 'a2'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        const a3 = agentMessage('a3', 5);
        messagesById[a3.id] = a3;
        const cache2 = buildTranscriptTurnsCached({
            cache: cache1,
            messageIdsOldestFirst: ['u1', 'a1', 'u2', 'a2', 'a3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        expect(cache1.turns).toHaveLength(2);
        expect(cache2.turns).toHaveLength(2);
        expect(cache2.turns[0]).toBe(cache1.turns[0]);
        expect(cache2.turns[1]).not.toBe(cache1.turns[1]);
        expect(cache2.turns[1]!.content.map((c) => c.kind)).toEqual(['message', 'message']);
    });

    it('falls back to a full rebuild when ids are not an append-only extension', () => {
        const chronological: Message[] = [
            agentMessage('a0', 1),
            userMessage('u1', 2),
            agentMessage('a1', 3),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));

        const cache1 = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: ['u1', 'a1'],
            messagesById,
            groupToolCalls: false,
            toolCallsGroupStrategy: 'consecutive_tools',
        });
        const cache2 = buildTranscriptTurnsCached({
            cache: cache1,
            messageIdsOldestFirst: ['a0', 'u1', 'a1'],
            messagesById,
            groupToolCalls: false,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        expect(cache2.turns.map((t) => t.userMessageId)).toEqual([null, 'u1']);
        expect(cache2.turns[0]?.content[0]?.kind).toBe('message');
    });
});
