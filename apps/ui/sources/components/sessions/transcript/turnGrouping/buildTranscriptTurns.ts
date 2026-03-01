import type { Message, ToolCallMessage, UserTextMessage } from '@/sync/domains/messages/messageTypes';

export type TranscriptTurnToolCallsGroupStrategy = 'consecutive_tools' | 'all_tools_in_turn';

export type TranscriptTurnContent =
    | {
        kind: 'message';
        messageId: string;
    }
    | {
        kind: 'tool_calls';
        id: string;
        toolMessageIds: string[];
    };

export type TranscriptTurn = {
    id: string;
    userMessageId: string | null;
    content: TranscriptTurnContent[];
};

export type TranscriptTurnsBuildCache = Readonly<{
    messageIdsOldestFirst: readonly string[];
    groupToolCalls: boolean;
    toolCallsGroupStrategy: TranscriptTurnToolCallsGroupStrategy;
    turns: TranscriptTurn[];
    // Internal: incremental builder state for the current (last) turn.
    lastTurnState: TranscriptTurnsLastTurnState;
}>;

type TranscriptTurnsLastTurnState =
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'consecutive_tools'; openActivityIndex: number | null }>
    | Readonly<{ kind: 'all_tools_in_turn'; activityIndex: number | null }>;

function isUserMessage(m: Message): m is UserTextMessage {
    return m.kind === 'user-text';
}

function isToolMessage(m: Message): m is ToolCallMessage {
    return m.kind === 'tool-call';
}

function createEmptyLastTurnState(opts: Readonly<{
    groupToolCalls: boolean;
    toolCallsGroupStrategy: TranscriptTurnToolCallsGroupStrategy;
}>): TranscriptTurnsLastTurnState {
    if (!opts.groupToolCalls) return { kind: 'none' };
    if (opts.toolCallsGroupStrategy === 'all_tools_in_turn') {
        return { kind: 'all_tools_in_turn', activityIndex: null };
    }
    return { kind: 'consecutive_tools', openActivityIndex: null };
}

function createTurn(params: Readonly<{ baseId: string; userMessageId: string | null }>): TranscriptTurn {
    return {
        id: `turn:${params.baseId}`,
        userMessageId: params.userMessageId,
        content: [],
    };
}

function appendNonUserToTurn(params: Readonly<{
    turn: TranscriptTurn;
    lastTurnState: TranscriptTurnsLastTurnState;
    messageId: string;
    message: Message;
    groupToolCalls: boolean;
    toolCallsGroupStrategy: TranscriptTurnToolCallsGroupStrategy;
}>): { turn: TranscriptTurn; lastTurnState: TranscriptTurnsLastTurnState } {
    const turn = params.turn;
    const content = turn.content.slice();

    if (!params.groupToolCalls) {
        content.push({ kind: 'message', messageId: params.messageId });
        return { turn: { ...turn, content }, lastTurnState: { kind: 'none' } };
    }

    if (params.toolCallsGroupStrategy === 'all_tools_in_turn') {
        if (isToolMessage(params.message)) {
            const state =
                params.lastTurnState.kind === 'all_tools_in_turn'
                    ? params.lastTurnState
                    : ({ kind: 'all_tools_in_turn', activityIndex: null } as const);
            if (state.activityIndex == null) {
                const idx = content.length;
                content.push({
                    kind: 'tool_calls',
                    id: `toolCalls:${turn.id}:${params.messageId}`,
                    toolMessageIds: [params.messageId],
                });
                return { turn: { ...turn, content }, lastTurnState: { kind: 'all_tools_in_turn', activityIndex: idx } };
            }
            const prev = content[state.activityIndex];
            if (prev?.kind !== 'tool_calls') {
                // Defensive: if content shape is unexpected, fall back to inserting a new activity group.
                const idx = content.length;
                content.push({
                    kind: 'tool_calls',
                    id: `toolCalls:${turn.id}:${params.messageId}`,
                    toolMessageIds: [params.messageId],
                });
                return { turn: { ...turn, content }, lastTurnState: { kind: 'all_tools_in_turn', activityIndex: idx } };
            }
            const nextToolMessageIds = [...prev.toolMessageIds, params.messageId];
            content[state.activityIndex] = { ...prev, toolMessageIds: nextToolMessageIds };
            return { turn: { ...turn, content }, lastTurnState: state };
        }

        content.push({ kind: 'message', messageId: params.messageId });
        const nextState: TranscriptTurnsLastTurnState =
            params.lastTurnState.kind === 'all_tools_in_turn'
                ? params.lastTurnState
                : ({ kind: 'all_tools_in_turn', activityIndex: null } as const);
        return { turn: { ...turn, content }, lastTurnState: nextState };
    }

    // consecutive_tools
    const state =
        params.lastTurnState.kind === 'consecutive_tools'
            ? params.lastTurnState
            : ({ kind: 'consecutive_tools', openActivityIndex: null } as const);

    if (isToolMessage(params.message)) {
        if (state.openActivityIndex != null) {
            const prev = content[state.openActivityIndex];
            if (prev?.kind === 'tool_calls') {
                content[state.openActivityIndex] = { ...prev, toolMessageIds: [...prev.toolMessageIds, params.messageId] };
                return { turn: { ...turn, content }, lastTurnState: state };
            }
        }

        const idx = content.length;
        content.push({
            kind: 'tool_calls',
            id: `toolCalls:${turn.id}:${params.messageId}`,
            toolMessageIds: [params.messageId],
        });
        return { turn: { ...turn, content }, lastTurnState: { kind: 'consecutive_tools', openActivityIndex: idx } };
    }

    content.push({ kind: 'message', messageId: params.messageId });
    return { turn: { ...turn, content }, lastTurnState: { kind: 'consecutive_tools', openActivityIndex: null } };
}

function isPrefix(params: Readonly<{ prefix: readonly string[]; full: readonly string[] }>): boolean {
    if (params.prefix.length > params.full.length) return false;
    for (let i = 0; i < params.prefix.length; i += 1) {
        if (params.prefix[i] !== params.full[i]) return false;
    }
    return true;
}

export function buildTranscriptTurnsCached(opts: {
    cache: TranscriptTurnsBuildCache | null;
    messageIdsOldestFirst: string[];
    messagesById: Readonly<Record<string, Message>>;
    groupToolCalls: boolean;
    toolCallsGroupStrategy: TranscriptTurnToolCallsGroupStrategy;
}): TranscriptTurnsBuildCache {
    const canReuse =
        opts.cache != null &&
        opts.cache.groupToolCalls === opts.groupToolCalls &&
        opts.cache.toolCallsGroupStrategy === opts.toolCallsGroupStrategy &&
        isPrefix({ prefix: opts.cache.messageIdsOldestFirst, full: opts.messageIdsOldestFirst });

    // Append-only incremental path.
    if (canReuse && opts.cache!.messageIdsOldestFirst.length <= opts.messageIdsOldestFirst.length) {
        const prev = opts.cache!;
        const prevLen = prev.messageIdsOldestFirst.length;
        const nextLen = opts.messageIdsOldestFirst.length;
        if (prevLen === nextLen) {
            return prev;
        }

        let nextTurns = prev.turns;
        let didCopyTurns = false;
        let lastTurnState = prev.lastTurnState;

        const ensureCopiedTurns = () => {
            if (!didCopyTurns) {
                nextTurns = prev.turns.slice();
                didCopyTurns = true;
            }
        };

        const pushNewTurn = (turn: TranscriptTurn, state: TranscriptTurnsLastTurnState) => {
            ensureCopiedTurns();
            nextTurns.push(turn);
            lastTurnState = state;
        };

        const replaceLastTurn = (turn: TranscriptTurn, state: TranscriptTurnsLastTurnState) => {
            ensureCopiedTurns();
            nextTurns[nextTurns.length - 1] = turn;
            lastTurnState = state;
        };

        for (let i = prevLen; i < nextLen; i += 1) {
            const id = opts.messageIdsOldestFirst[i]!;
            const message = opts.messagesById[id];
            if (!message) continue;

            if (isUserMessage(message)) {
                pushNewTurn(createTurn({ baseId: message.id, userMessageId: message.id }), createEmptyLastTurnState(opts));
                continue;
            }

            if (nextTurns.length === 0) {
                pushNewTurn(createTurn({ baseId: message.id, userMessageId: null }), createEmptyLastTurnState(opts));
            }

            const last = nextTurns[nextTurns.length - 1]!;
            const updated = appendNonUserToTurn({
                turn: last,
                lastTurnState,
                messageId: message.id,
                message,
                groupToolCalls: opts.groupToolCalls,
                toolCallsGroupStrategy: opts.toolCallsGroupStrategy,
            });
            replaceLastTurn(updated.turn, updated.lastTurnState);
        }

        return {
            messageIdsOldestFirst: opts.messageIdsOldestFirst,
            groupToolCalls: opts.groupToolCalls,
            toolCallsGroupStrategy: opts.toolCallsGroupStrategy,
            turns: nextTurns,
            lastTurnState,
        };
    }

    // Full rebuild.
    const turns: TranscriptTurn[] = [];
    let lastTurnState = createEmptyLastTurnState(opts);

    for (const id of opts.messageIdsOldestFirst) {
        const message = opts.messagesById[id];
        if (!message) continue;

        if (isUserMessage(message)) {
            turns.push(createTurn({ baseId: message.id, userMessageId: message.id }));
            lastTurnState = createEmptyLastTurnState(opts);
            continue;
        }

        if (turns.length === 0) {
            turns.push(createTurn({ baseId: message.id, userMessageId: null }));
            lastTurnState = createEmptyLastTurnState(opts);
        }

        const last = turns[turns.length - 1]!;
        const updated = appendNonUserToTurn({
            turn: last,
            lastTurnState,
            messageId: message.id,
            message,
            groupToolCalls: opts.groupToolCalls,
            toolCallsGroupStrategy: opts.toolCallsGroupStrategy,
        });
        turns[turns.length - 1] = updated.turn;
        lastTurnState = updated.lastTurnState;
    }

    return {
        messageIdsOldestFirst: opts.messageIdsOldestFirst,
        groupToolCalls: opts.groupToolCalls,
        toolCallsGroupStrategy: opts.toolCallsGroupStrategy,
        turns,
        lastTurnState,
    };
}

export function buildTranscriptTurns(opts: {
    messageIdsOldestFirst: string[];
    messagesById: Readonly<Record<string, Message>>;
    groupToolCalls: boolean;
    toolCallsGroupStrategy: TranscriptTurnToolCallsGroupStrategy;
}): TranscriptTurn[] {
    return buildTranscriptTurnsCached({
        cache: null,
        messageIdsOldestFirst: opts.messageIdsOldestFirst,
        messagesById: opts.messagesById,
        groupToolCalls: opts.groupToolCalls,
        toolCallsGroupStrategy: opts.toolCallsGroupStrategy,
    }).turns;
}
