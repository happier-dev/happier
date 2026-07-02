import { describe, expect, it } from 'vitest';

import type { AgentTextMessage, Message, ToolCallMessage, UserTextMessage } from '@/sync/domains/messages/messageTypes';

import { buildTranscriptTurns, buildTranscriptTurnsCached, type TranscriptTurnsBuildCache } from './buildTranscriptTurns';

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
        // Two previously-emitted turns can merge into ONE rebuilt turn. dev cannot reach that
        // shape through grouping alone today (turns split only at user messages), so the previous
        // build is constructed directly from the exported cache contract — the collision rule must
        // hold for any future producer (rollbacks, fork-context regrouping): the bottom-most
        // previously-rendered id wins, because that is the key FlashList has on screen at the
        // pagination anchor, and remapped ids must stay unique.
        const chronological: Message[] = [
            userMessage('u1', 1),
            agentMessage('a1', 2),
            agentMessage('a2', 3),
            toolMessage({ id: 't2', createdAt: 4, state: 'completed' }),
        ];
        const messagesById = Object.fromEntries(chronological.map((m) => [m.id, m]));

        const previousCache: TranscriptTurnsBuildCache = {
            messageIdsOldestFirst: ['u1', 'a1', 'a2', 't2'],
            // Mismatched grouping keys force the full-rebuild path (no incremental reuse).
            messageGroupingKeysOldestFirst: ['user', 'message:agent-text', 'user', 'tool:groupable'],
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
            turns: [
                {
                    id: 'turn:u1',
                    userMessageId: 'u1',
                    content: [{ kind: 'message', messageId: 'a1' }],
                },
                {
                    id: 'turn:a2',
                    userMessageId: null,
                    content: [
                        { kind: 'message', messageId: 'a2' },
                        { kind: 'tool_calls', id: 'toolCalls:turn:a2:t2', toolMessageIds: ['t2'] },
                    ],
                },
            ],
            lastTurnState: { kind: 'consecutive_tools', openActivityIndex: null },
        };

        const mergedCache = buildTranscriptTurnsCached({
            cache: previousCache,
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
});
