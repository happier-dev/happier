import { describe, expect, it } from 'vitest';

import type { AgentTextMessage, Message, ModeSwitchMessage, ToolCallMessage, UserTextMessage } from '@/sync/domains/messages/messageTypes';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';

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

function contextCompactionEventMessage(
    id: string,
    createdAt: number,
    opts: {
        phase: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';
        lifecycleId?: string;
    },
): ModeSwitchMessage {
    return {
        kind: 'agent-event',
        localId: null,
        id,
        createdAt,
        event: {
            type: 'context-compaction',
            phase: opts.phase,
            lifecycleId: opts.lifecycleId,
            source: 'agent-event',
        },
    };
}

function toolMessage(opts: {
    id: string;
    createdAt: number;
    state: 'running' | 'completed' | 'error';
    name?: string;
    input?: unknown;
    result?: unknown;
    requestKind?: 'permission' | 'user_action';
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
            input: opts.input ?? {},
            createdAt: opts.createdAt,
            startedAt: opts.createdAt,
            completedAt: opts.state === 'running' ? null : opts.createdAt + 1,
            description: null,
            result: opts.state === 'completed' ? (opts.result ?? {}) : undefined,
            permission: opts.requestKind
                ? {
                    id: `perm:${opts.id}`,
                    status: opts.state === 'running' ? 'pending' : 'approved',
                    kind: opts.requestKind,
                }
                : undefined,
        },
        children: [],
    };
}

function pendingMessage(opts: {
    id: string;
    localId: string | null;
    createdAt: number;
    source: 'local_outbound' | 'server_pending';
}): PendingMessage {
    return {
        id: opts.id,
        localId: opts.localId,
        createdAt: opts.createdAt,
        updatedAt: opts.createdAt,
        text: `pending:${opts.id}`,
        source: opts.source,
        rawRecord: {},
    };
}

describe('buildTranscriptTurns', () => {
    it('hides committed user rows that are still owned by unresolved server pending state', () => {
        const committedUser = {
            ...userMessage('m-user', 20),
            localId: 'pending-1',
            text: 'committed but not accepted',
        };
        const chronological: Message[] = [committedUser];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));

        const turns = buildTranscriptTurns({
            messageIdsOldestFirst: chronological.map((m) => m.id),
            messagesById,
            pendingMessages: [
                pendingMessage({
                    id: 'pending-row',
                    localId: 'pending-1',
                    createdAt: 10,
                    source: 'server_pending',
                }),
            ],
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        expect(turns).toEqual([]);
    });

    it('starts a null-user turn before a fork boundary tool message', () => {
        const chronological: Message[] = [
            userMessage('u1', 1),
            toolMessage({ id: 'parent-tool', createdAt: 2, state: 'completed' }),
            toolMessage({ id: 'child-tool', createdAt: 3, state: 'completed' }),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));
        const buildWithForkBoundaries = buildTranscriptTurns as (
            opts: Parameters<typeof buildTranscriptTurns>[0] & {
                forkBoundaryBeforeMessageIds?: ReadonlySet<string>;
                forkBoundarySignature?: string;
            }
        ) => ReturnType<typeof buildTranscriptTurns>;

        const turns = buildWithForkBoundaries({
            messageIdsOldestFirst: chronological.map((m) => m.id),
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
            forkBoundaryBeforeMessageIds: new Set(['child-tool']),
            forkBoundarySignature: 'child-tool',
        });

        expect(turns.map((turn) => turn.userMessageId)).toEqual(['u1', null]);
        expect(turns[0]?.content[0]?.kind === 'tool_calls' && turns[0].content[0].toolMessageIds).toEqual(['parent-tool']);
        expect(turns[1]?.content[0]?.kind === 'tool_calls' && turns[1].content[0].toolMessageIds).toEqual(['child-tool']);
    });

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

    it('keeps one consecutive Activity section when a long tool run is appended in small batches', () => {
        const user = userMessage('u1', 1);
        const allTools = Array.from({ length: 200 }, (_, index) => (
            toolMessage({ id: `tool-${index + 1}`, createdAt: index + 2, state: 'completed' })
        ));

        let cache = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: ['u1'],
            messagesById: { u1: user },
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        for (let end = 8; end <= allTools.length; end += 8) {
            const visible = allTools.slice(0, end);
            const chronological: Message[] = [user, ...visible];
            const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));
            cache = buildTranscriptTurnsCached({
                cache,
                messageIdsOldestFirst: chronological.map((m) => m.id),
                messagesById,
                groupToolCalls: true,
                toolCallsGroupStrategy: 'consecutive_tools',
            });
        }

        expect(cache.turns).toHaveLength(1);
        const toolGroups = cache.turns[0]!.content.filter((content) => content.kind === 'tool_calls');
        expect(toolGroups).toHaveLength(1);
        expect(toolGroups[0]?.kind === 'tool_calls' && toolGroups[0].toolMessageIds).toEqual(
            allTools.map((tool) => tool.id),
        );
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

    it('keeps pending user-action tool calls as standalone rows in consecutive_tools mode', () => {
        const chronological: Message[] = [
            userMessage('u1', 1),
            toolMessage({ id: 't1', createdAt: 2, state: 'completed' }),
            toolMessage({ id: 'ask', createdAt: 3, state: 'running', requestKind: 'user_action', name: 'AskUserQuestion' }),
            toolMessage({ id: 't2', createdAt: 4, state: 'completed' }),
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
        expect(turns[0]!.content.map((c) => c.kind)).toEqual(['tool_calls', 'message', 'tool_calls']);
        if (turns[0]!.content[0]?.kind === 'tool_calls') {
            expect(turns[0]!.content[0].toolMessageIds).toEqual(['t1']);
        }
        if (turns[0]!.content[1]?.kind === 'message') {
            expect(turns[0]!.content[1].messageId).toBe('ask');
        }
        if (turns[0]!.content[2]?.kind === 'tool_calls') {
            expect(turns[0]!.content[2].toolMessageIds).toEqual(['t2']);
        }
    });

    it('keeps canonical turn-diff recap tools outside grouped tool-call sections', () => {
        const chronological: Message[] = [
            userMessage('u1', 1),
            toolMessage({ id: 't1', createdAt: 2, state: 'completed' }),
            toolMessage({
                id: 'diff-1',
                createdAt: 3,
                state: 'completed',
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
                            endSeqInclusive: 3,
                        },
                    },
                },
            }),
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
        expect(turns[0]!.content.map((c) => c.kind)).toEqual(['tool_calls', 'message']);
        if (turns[0]!.content[0]?.kind === 'tool_calls') {
            expect(turns[0]!.content[0].toolMessageIds).toEqual(['t1']);
        }
        if (turns[0]!.content[1]?.kind === 'message') {
            expect(turns[0]!.content[1].messageId).toBe('diff-1');
        }
    });

    it('keeps canonical turn-diff recap tools outside grouped tool-call sections when tool input is a JSON string', () => {
        const diffInput = {
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
                    endSeqInclusive: 3,
                },
            },
        };
        const chronological: Message[] = [
            userMessage('u1', 1),
            toolMessage({ id: 't1', createdAt: 2, state: 'completed' }),
            toolMessage({
                id: 'diff-1',
                createdAt: 3,
                state: 'completed',
                name: 'Diff',
                input: JSON.stringify(diffInput),
            }),
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
        expect(turns[0]!.content.map((c) => c.kind)).toEqual(['tool_calls', 'message']);
        if (turns[0]!.content[0]?.kind === 'tool_calls') {
            expect(turns[0]!.content[0].toolMessageIds).toEqual(['t1']);
        }
        if (turns[0]!.content[1]?.kind === 'message') {
            expect(turns[0]!.content[1].messageId).toBe('diff-1');
        }
    });

    it('keeps turn-diff recap tools outside grouped tool-call sections when metadata is attached to tool results', () => {
        const chronological: Message[] = [
            userMessage('u1', 1),
            toolMessage({ id: 't1', createdAt: 2, state: 'completed' }),
            toolMessage({
                id: 'diff-1',
                createdAt: 3,
                state: 'completed',
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
                },
                result: {
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
                            endSeqInclusive: 3,
                        },
                    },
                },
            }),
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
        expect(turns[0]!.content.map((c) => c.kind)).toEqual(['tool_calls', 'message']);
        if (turns[0]!.content[0]?.kind === 'tool_calls') {
            expect(turns[0]!.content[0].toolMessageIds).toEqual(['t1']);
        }
        if (turns[0]!.content[1]?.kind === 'message') {
            expect(turns[0]!.content[1].messageId).toBe('diff-1');
        }
    });

    it('hides superseded context compaction lifecycle rows inside grouped turns', () => {
        const chronological: Message[] = [
            userMessage('u1', 1),
            contextCompactionEventMessage('compact-start', 2, {
                phase: 'started',
                lifecycleId: 'compact-1',
            }),
            contextCompactionEventMessage('other-compact-start', 3, {
                phase: 'started',
                lifecycleId: 'compact-2',
            }),
            contextCompactionEventMessage('compact-completed', 4, {
                phase: 'completed',
                lifecycleId: 'compact-1',
            }),
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
        expect(turns[0]!.content.flatMap((content) => content.kind === 'message' ? [content.messageId] : [])).toEqual([
            'other-compact-start',
            'compact-completed',
        ]);
    });
});

describe('buildTranscriptTurnsCached', () => {
    it('rebuilds cached turns when unresolved server pending state starts owning a committed localId', () => {
        const committedUser = {
            ...userMessage('m-user', 20),
            localId: 'pending-1',
            text: 'committed but not accepted',
        };
        const chronological: Message[] = [committedUser];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));
        let cache = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: chronological.map((m) => m.id),
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });
        expect(cache.turns.map((turn) => turn.userMessageId)).toEqual(['m-user']);

        cache = buildTranscriptTurnsCached({
            cache,
            messageIdsOldestFirst: chronological.map((m) => m.id),
            messagesById,
            pendingMessages: [
                pendingMessage({
                    id: 'pending-row',
                    localId: 'pending-1',
                    createdAt: 10,
                    source: 'server_pending',
                }),
            ],
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        expect(cache.turns).toEqual([]);
    });

    it('resets turn grouping state when an appended fork boundary starts with a tool message', () => {
        const chronological: Message[] = [
            userMessage('u1', 1),
            agentMessage('a1', 2),
            toolMessage({ id: 'parent-tool', createdAt: 3, state: 'completed' }),
            toolMessage({ id: 'child-tool', createdAt: 4, state: 'completed' }),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));
        const buildWithForkBoundaries = buildTranscriptTurnsCached as (
            opts: Parameters<typeof buildTranscriptTurnsCached>[0] & {
                forkBoundaryBeforeMessageIds?: ReadonlySet<string>;
                forkBoundarySignature?: string;
            }
        ) => ReturnType<typeof buildTranscriptTurnsCached>;

        const cache1 = buildWithForkBoundaries({
            cache: null,
            messageIdsOldestFirst: ['u1', 'a1', 'parent-tool'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
            forkBoundaryBeforeMessageIds: new Set(['child-tool']),
            forkBoundarySignature: 'child-tool',
        });

        const cache2 = buildWithForkBoundaries({
            cache: cache1,
            messageIdsOldestFirst: ['u1', 'a1', 'parent-tool', 'child-tool'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
            forkBoundaryBeforeMessageIds: new Set(['child-tool']),
            forkBoundarySignature: 'child-tool',
        });

        expect(cache2.turns.map((turn) => turn.userMessageId)).toEqual(['u1', null]);
        expect(cache2.turns[0]).toBe(cache1.turns[0]);
        expect(cache2.turns[0]?.content.map((content) => content.kind)).toEqual(['message', 'tool_calls']);
        expect(cache2.turns[0]?.content[1]?.kind === 'tool_calls' && cache2.turns[0].content[1].toolMessageIds).toEqual(['parent-tool']);
        expect(cache2.turns[1]?.content[0]?.kind === 'tool_calls' && cache2.turns[1].content[0].toolMessageIds).toEqual(['child-tool']);
    });

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

    it('rebuilds cached turns when an existing tool message becomes a turn-diff recap', () => {
        const diffToolInitial = toolMessage({
            id: 'diff-1',
            createdAt: 3,
            state: 'completed',
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
            },
        });
        const messagesById = {
            u1: userMessage('u1', 1),
            t1: toolMessage({ id: 't1', createdAt: 2, state: 'completed' }),
            'diff-1': diffToolInitial,
        } satisfies Record<string, Message>;

        const cache1 = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: ['u1', 't1', 'diff-1'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'all_tools_in_turn',
        });

        expect(cache1.turns).toHaveLength(1);
        expect(cache1.turns[0]!.content).toHaveLength(1);
        expect(cache1.turns[0]!.content[0]?.kind).toBe('tool_calls');

        messagesById['diff-1'] = toolMessage({
            id: 'diff-1',
            createdAt: 3,
            state: 'completed',
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
                    provider: 'claude',
                    source: 'canonical_diff_tool',
                    confidence: 'exact',
                    turnStatus: 'completed',
                    seqRange: {
                        startSeqInclusive: 1,
                        endSeqInclusive: 3,
                    },
                },
            },
        });

        const cache2 = buildTranscriptTurnsCached({
            cache: cache1,
            messageIdsOldestFirst: ['u1', 't1', 'diff-1'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'all_tools_in_turn',
        });

        expect(cache2.turns).toHaveLength(1);
        expect(cache2.turns[0]!.content.map((c) => c.kind)).toEqual(['tool_calls', 'message']);
        if (cache2.turns[0]!.content[0]?.kind === 'tool_calls') {
            expect(cache2.turns[0]!.content[0].toolMessageIds).toEqual(['t1']);
        }
        if (cache2.turns[0]!.content[1]?.kind === 'message') {
            expect(cache2.turns[0]!.content[1].messageId).toBe('diff-1');
        }
    });

    it('keeps previously-built turn ids stable when prepended older messages end at a turn boundary', () => {
        // MVCP key-anchoring precondition (plan C3): ids of already-rendered turn items must
        // survive an older-page prepend so FlashList's key-based offset correction can hold position.
        const chronological: Message[] = [
            userMessage('u1', 1),
            agentMessage('a1', 2),
            userMessage('u2', 3),
            agentMessage('a2', 4),
            userMessage('u3', 5),
            agentMessage('a3', 6),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));

        const windowCache = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: ['u2', 'a2', 'u3', 'a3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });
        const prependedCache = buildTranscriptTurnsCached({
            cache: windowCache,
            messageIdsOldestFirst: ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        const windowTurnIds = windowCache.turns.map((turn) => turn.id);
        const prependedTurnIds = prependedCache.turns.map((turn) => turn.id);
        expect(windowTurnIds).toEqual(['turn:u2', 'turn:u3']);
        for (const previousTurnId of windowTurnIds) {
            expect(prependedTurnIds).toContain(previousTurnId);
        }
        expect(prependedCache.turns.find((turn) => turn.id === 'turn:u2')?.content)
            .toEqual(windowCache.turns.find((turn) => turn.id === 'turn:u2')?.content);
    });

    it('keeps the previously-built headless turn id sticky when prepended older messages join it (plan C3)', () => {
        // Page boundary fell mid-turn: the loaded window starts with a non-user message, so the
        // first turn is headless (`turn:a2`). Prepending the rest of that logical turn absorbs the
        // headless turn into the older turn — the merged turn must KEEP the previously-assigned id
        // (`turn:a2`), and embedded tool-group child ids keyed off the turn id must follow
        // (`toolCalls:turn:a2:t2`), so FlashList MVCP key anchoring holds at the prepend boundary.
        const chronological: Message[] = [
            userMessage('u1', 1),
            agentMessage('a1', 2),
            agentMessage('a2', 3),
            toolMessage({ id: 't2', createdAt: 4, state: 'completed' }),
            userMessage('u3', 5),
            agentMessage('a3', 6),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));

        const windowCache = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: ['a2', 't2', 'u3', 'a3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });
        const prependedCache = buildTranscriptTurnsCached({
            cache: windowCache,
            messageIdsOldestFirst: ['u1', 'a1', 'a2', 't2', 'u3', 'a3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        expect(windowCache.turns.map((turn) => turn.id)).toEqual(['turn:a2', 'turn:u3']);
        // The previously-rendered headless turn id survives the prepend; the merged turn gains the
        // prepended messages while keeping the on-screen key.
        expect(prependedCache.turns.map((turn) => turn.id)).toEqual(['turn:a2', 'turn:u3']);
        const mergedTurn = prependedCache.turns[0]!;
        expect(mergedTurn.userMessageId).toBe('u1');
        expect(mergedTurn.content.flatMap((content) => content.kind === 'message' ? [content.messageId] : []))
            .toEqual(['a1', 'a2']);
        expect(mergedTurn.content.flatMap((content) => content.kind === 'tool_calls' ? [content.id] : []))
            .toEqual(['toolCalls:turn:a2:t2']);
        // Turns whose boundary was not crossed by the prepend stay stable.
        expect(prependedCache.turns.find((turn) => turn.id === 'turn:u3')?.content)
            .toEqual(windowCache.turns.find((turn) => turn.id === 'turn:u3')?.content);
        // A cache-less build of the same window still derives fresh ids from the first message —
        // sticky continuity is scoped to the per-session build cache, never global.
        const cacheFreeTurns = buildTranscriptTurns({
            messageIdsOldestFirst: ['u1', 'a1', 'a2', 't2', 'u3', 'a3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });
        expect(cacheFreeTurns.map((turn) => turn.id)).toEqual(['turn:u1', 'turn:u3']);
    });

    it('keeps the sticky headless turn id across multiple successive prepends', () => {
        const chronological: Message[] = [
            userMessage('u1', 1),
            agentMessage('a1', 2),
            agentMessage('a2', 3),
            toolMessage({ id: 't2', createdAt: 4, state: 'completed' }),
            userMessage('u3', 5),
            agentMessage('a3', 6),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));

        const cache1 = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: ['a2', 't2', 'u3', 'a3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });
        const cache2 = buildTranscriptTurnsCached({
            cache: cache1,
            messageIdsOldestFirst: ['a1', 'a2', 't2', 'u3', 'a3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });
        const cache3 = buildTranscriptTurnsCached({
            cache: cache2,
            messageIdsOldestFirst: ['u1', 'a1', 'a2', 't2', 'u3', 'a3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        expect(cache1.turns.map((turn) => turn.id)).toEqual(['turn:a2', 'turn:u3']);
        expect(cache2.turns.map((turn) => turn.id)).toEqual(['turn:a2', 'turn:u3']);
        expect(cache3.turns.map((turn) => turn.id)).toEqual(['turn:a2', 'turn:u3']);
        expect(cache3.turns[0]?.userMessageId).toBe('u1');
        expect(cache3.turns[0]?.content.flatMap((content) => content.kind === 'tool_calls' ? [content.id] : []))
            .toEqual(['toolCalls:turn:a2:t2']);
    });

    it('resolves sticky-id collisions to the previously-rendered bottom-most turn id', () => {
        // Two previously-emitted turns can merge into ONE rebuilt turn (e.g. a fork boundary that
        // separated them disappears). Both old ids are candidates; the bottom-most previously
        // rendered id wins — that is the key FlashList has on screen at the pagination anchor.
        const chronological: Message[] = [
            userMessage('u1', 1),
            agentMessage('a1', 2),
            agentMessage('a2', 3),
            toolMessage({ id: 't2', createdAt: 4, state: 'completed' }),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));

        const boundaryCache = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: ['u1', 'a1', 'a2', 't2'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
            forkBoundaryBeforeMessageIds: new Set(['a2']),
            forkBoundarySignature: 'fork-a2',
        });
        expect(boundaryCache.turns.map((turn) => turn.id)).toEqual(['turn:u1', 'turn:a2']);

        const mergedCache = buildTranscriptTurnsCached({
            cache: boundaryCache,
            messageIdsOldestFirst: ['u1', 'a1', 'a2', 't2'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        expect(mergedCache.turns).toHaveLength(1);
        const mergedTurn = mergedCache.turns[0]!;
        expect(mergedTurn.id).toBe('turn:a2');
        expect(mergedTurn.userMessageId).toBe('u1');
        expect(mergedTurn.content.flatMap((content) => content.kind === 'tool_calls' ? [content.id] : []))
            .toEqual(['toolCalls:turn:a2:t2']);
        // Ids stay unique after remapping.
        expect(new Set(mergedCache.turns.map((turn) => turn.id)).size).toBe(mergedCache.turns.length);
    });

    it('keeps the previously-built tool-group id sticky when a prepend extends the group upward (plan N2c)', () => {
        // Page boundary fell inside a consecutive tool run: the loaded window starts at t2, so the
        // headless turn is `turn:t2` and its group id embeds the first loaded tool
        // (`toolCalls:turn:t2:t2`). Prepending the rest of the run extends the group upward —
        // the merged group must KEEP the previously-assigned group id even though its first tool
        // is now t1, so per-tool virtualization-unit keys derived from the group id stay stable.
        const chronological: Message[] = [
            userMessage('u1', 1),
            agentMessage('a1', 2),
            toolMessage({ id: 't1', createdAt: 3, state: 'completed' }),
            toolMessage({ id: 't2', createdAt: 4, state: 'completed' }),
            toolMessage({ id: 't3', createdAt: 5, state: 'completed' }),
            userMessage('u3', 6),
            agentMessage('a3', 7),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));

        const windowCache = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: ['t2', 't3', 'u3', 'a3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });
        expect(windowCache.turns.map((turn) => turn.id)).toEqual(['turn:t2', 'turn:u3']);
        expect(windowCache.turns[0]?.content.flatMap((content) => content.kind === 'tool_calls' ? [content.id] : []))
            .toEqual(['toolCalls:turn:t2:t2']);

        const prependedCache = buildTranscriptTurnsCached({
            cache: windowCache,
            messageIdsOldestFirst: ['u1', 'a1', 't1', 't2', 't3', 'u3', 'a3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        expect(prependedCache.turns.map((turn) => turn.id)).toEqual(['turn:t2', 'turn:u3']);
        const mergedGroup = prependedCache.turns[0]!.content.find((content) => content.kind === 'tool_calls');
        expect(mergedGroup?.kind === 'tool_calls' && mergedGroup.toolMessageIds).toEqual(['t1', 't2', 't3']);
        // The group id survives the upward extension (NOT re-derived from the new first tool).
        expect(mergedGroup?.kind === 'tool_calls' && mergedGroup.id).toBe('toolCalls:turn:t2:t2');
    });

    it('keeps the sticky tool-group id across multiple successive prepends into the same run', () => {
        const chronological: Message[] = [
            toolMessage({ id: 't1', createdAt: 1, state: 'completed' }),
            toolMessage({ id: 't2', createdAt: 2, state: 'completed' }),
            toolMessage({ id: 't3', createdAt: 3, state: 'completed' }),
            userMessage('u3', 4),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));

        const cache1 = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: ['t3', 'u3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });
        const cache2 = buildTranscriptTurnsCached({
            cache: cache1,
            messageIdsOldestFirst: ['t2', 't3', 'u3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });
        const cache3 = buildTranscriptTurnsCached({
            cache: cache2,
            messageIdsOldestFirst: ['t1', 't2', 't3', 'u3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        expect(cache1.turns[0]?.content.flatMap((content) => content.kind === 'tool_calls' ? [content.id] : []))
            .toEqual(['toolCalls:turn:t3:t3']);
        expect(cache2.turns[0]?.content.flatMap((content) => content.kind === 'tool_calls' ? [content.id] : []))
            .toEqual(['toolCalls:turn:t3:t3']);
        expect(cache3.turns[0]?.content.flatMap((content) => content.kind === 'tool_calls' ? [content.id] : []))
            .toEqual(['toolCalls:turn:t3:t3']);
        const finalGroup = cache3.turns[0]!.content.find((content) => content.kind === 'tool_calls');
        expect(finalGroup?.kind === 'tool_calls' && finalGroup.toolMessageIds).toEqual(['t1', 't2', 't3']);
    });

    it('resolves tool-group sticky-id collisions to the previously-rendered bottom-most group id', () => {
        // A fork boundary inside a tool run previously split it into two groups; removing the
        // boundary merges them into one group. The bottom-most previously-rendered group id wins —
        // mirroring the turn-level collision rule.
        const chronological: Message[] = [
            userMessage('u1', 1),
            toolMessage({ id: 't1', createdAt: 2, state: 'completed' }),
            toolMessage({ id: 't2', createdAt: 3, state: 'completed' }),
            toolMessage({ id: 't3', createdAt: 4, state: 'completed' }),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));

        const boundaryCache = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: ['u1', 't1', 't2', 't3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
            forkBoundaryBeforeMessageIds: new Set(['t2']),
            forkBoundarySignature: 'fork-t2',
        });
        expect(boundaryCache.turns.flatMap((turn) => turn.content.flatMap((content) => content.kind === 'tool_calls' ? [content.id] : [])))
            .toEqual(['toolCalls:turn:u1:t1', 'toolCalls:turn:t2:t2']);

        const mergedCache = buildTranscriptTurnsCached({
            cache: boundaryCache,
            messageIdsOldestFirst: ['u1', 't1', 't2', 't3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        expect(mergedCache.turns).toHaveLength(1);
        const mergedGroups = mergedCache.turns[0]!.content.filter((content) => content.kind === 'tool_calls');
        expect(mergedGroups).toHaveLength(1);
        expect(mergedGroups[0]?.kind === 'tool_calls' && mergedGroups[0].toolMessageIds).toEqual(['t1', 't2', 't3']);
        expect(mergedGroups[0]?.kind === 'tool_calls' && mergedGroups[0].id).toBe('toolCalls:turn:t2:t2');
        // Ids stay unique after remapping.
        const allGroupIds = mergedCache.turns.flatMap((turn) => turn.content.flatMap((content) => content.kind === 'tool_calls' ? [content.id] : []));
        expect(new Set(allGroupIds).size).toBe(allGroupIds.length);
    });

    it('does not apply a sticky group id when the rebuilt group no longer contains all previous group tools', () => {
        // Containment is the sticky precondition at the group level too: when the window dropped
        // part of the old group (rollback/fork switch), derive a fresh id from the first tool.
        const chronological: Message[] = [
            toolMessage({ id: 't1', createdAt: 1, state: 'completed' }),
            toolMessage({ id: 't2', createdAt: 2, state: 'completed' }),
            userMessage('u2', 3),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));

        const windowCache = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: ['t1', 't2', 'u2'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });
        expect(windowCache.turns[0]?.content.flatMap((content) => content.kind === 'tool_calls' ? [content.id] : []))
            .toEqual(['toolCalls:turn:t1:t1']);

        const shrunkCache = buildTranscriptTurnsCached({
            cache: windowCache,
            messageIdsOldestFirst: ['t2', 'u2'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });
        expect(shrunkCache.turns[0]?.content.flatMap((content) => content.kind === 'tool_calls' ? [content.id] : []))
            .toEqual(['toolCalls:turn:t2:t2']);
    });

    it('does not apply a sticky id when the rebuilt turn no longer contains all of the previous turn messages', () => {
        // Containment is the sticky precondition: if the window dropped part of the old turn
        // (rollback/fork switch), the on-screen row genuinely changed — derive a fresh id.
        const chronological: Message[] = [
            userMessage('u1', 1),
            agentMessage('a1', 2),
            agentMessage('a2', 3),
            toolMessage({ id: 't2', createdAt: 4, state: 'completed' }),
            userMessage('u3', 5),
            agentMessage('a3', 6),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));

        const windowCache = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: ['a2', 't2', 'u3', 'a3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });
        const rebuiltWithoutT2 = buildTranscriptTurnsCached({
            cache: windowCache,
            messageIdsOldestFirst: ['u1', 'a1', 'a2', 'u3', 'a3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        expect(windowCache.turns.map((turn) => turn.id)).toEqual(['turn:a2', 'turn:u3']);
        expect(rebuiltWithoutT2.turns.map((turn) => turn.id)).toEqual(['turn:u1', 'turn:u3']);
    });

    it('rebuilds cached turns when an appended terminal compaction event supersedes a pending row', () => {
        const messagesById = {
            u1: userMessage('u1', 1),
            'compact-start': contextCompactionEventMessage('compact-start', 2, {
                phase: 'started',
                lifecycleId: 'compact-1',
            }),
            'compact-completed': contextCompactionEventMessage('compact-completed', 3, {
                phase: 'completed',
                lifecycleId: 'compact-1',
            }),
        } satisfies Record<string, Message>;

        const cache1 = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: ['u1', 'compact-start'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        const cache2 = buildTranscriptTurnsCached({
            cache: cache1,
            messageIdsOldestFirst: ['u1', 'compact-start', 'compact-completed'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        expect(cache1.turns[0]!.content.flatMap((content) => content.kind === 'message' ? [content.messageId] : [])).toEqual(['compact-start']);
        expect(cache2.turns[0]!.content.flatMap((content) => content.kind === 'message' ? [content.messageId] : [])).toEqual(['compact-completed']);
    });
});
