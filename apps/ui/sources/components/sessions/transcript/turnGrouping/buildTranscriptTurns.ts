import type { Message, ToolCallMessage, UserTextMessage } from '@/sync/domains/messages/messageTypes';
import { isToolCallMessageGroupableInTranscript } from '@/components/sessions/transcript/toolCalls/isToolCallMessageGroupableInTranscript';

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
    messageGroupingKeysOldestFirst: readonly string[];
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

function isGroupableToolMessage(m: Message): m is ToolCallMessage {
    if (!isToolMessage(m)) return false;
    return isToolCallMessageGroupableInTranscript(m);
}

function getMessageGroupingKey(message: Message | undefined): string {
    if (!message) return 'missing';
    if (isUserMessage(message)) return 'user';
    if (isToolMessage(message)) {
        return isToolCallMessageGroupableInTranscript(message) ? 'tool:groupable' : 'tool:standalone';
    }
    return `message:${message.kind}`;
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
        if (isGroupableToolMessage(params.message)) {
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

    if (isGroupableToolMessage(params.message)) {
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

function collectTurnMessageIds(turn: TranscriptTurn): string[] {
    const messageIds: string[] = [];
    if (turn.userMessageId) messageIds.push(turn.userMessageId);
    for (const content of turn.content) {
        if (content.kind === 'message') {
            messageIds.push(content.messageId);
            continue;
        }
        for (const toolMessageId of content.toolMessageIds) {
            messageIds.push(toolMessageId);
        }
    }
    return messageIds;
}

function withTurnId(turn: TranscriptTurn, id: string): TranscriptTurn {
    if (turn.id === id) return turn;
    return {
        id,
        userMessageId: turn.userMessageId,
        content: turn.content.map((content) => {
            if (content.kind !== 'tool_calls') return content;
            return { ...content, id: `toolCalls:${id}:${content.toolMessageIds[0] ?? ''}` };
        }),
    };
}

/**
 * Keeps previously-assigned turn ids sticky across full rebuilds within one build-cache lineage
 * (per mounted session). When an older-page prepend lands mid-turn, the previously-rendered
 * headless first turn is absorbed into the older turn; without remapping, the merged turn would
 * derive a NEW id from its new first message, re-keying the on-screen FlashList row exactly at
 * the pagination anchor and breaking MVCP key-based offset correction (plan C3).
 *
 * Rule: a rebuilt turn that fully contains the messages of a previously-emitted turn keeps that
 * turn's id; embedded tool-group child ids follow. When several previous turns merge into one
 * rebuilt turn, the bottom-most previously-rendered id wins — that is the key FlashList has on
 * screen. Fresh turns (no contained predecessor) keep `turn:<firstMessageId>` derivation.
 */
function applyStickyTurnIdsFromPreviousBuild(params: Readonly<{
    previousTurns: readonly TranscriptTurn[];
    turns: readonly TranscriptTurn[];
}>): TranscriptTurn[] {
    const turns = [...params.turns];
    if (params.previousTurns.length === 0 || turns.length === 0) return turns;

    const previousTurnIndexByMessageId = new Map<string, number>();
    const previousTurnMessageCounts: number[] = [];
    params.previousTurns.forEach((previousTurn, previousIndex) => {
        const messageIds = collectTurnMessageIds(previousTurn);
        previousTurnMessageCounts.push(messageIds.length);
        for (const messageId of messageIds) {
            previousTurnIndexByMessageId.set(messageId, previousIndex);
        }
    });

    return turns.map((turn) => {
        const containedMessageCountByPreviousIndex = new Map<number, number>();
        for (const messageId of collectTurnMessageIds(turn)) {
            const previousIndex = previousTurnIndexByMessageId.get(messageId);
            if (previousIndex == null) continue;
            containedMessageCountByPreviousIndex.set(
                previousIndex,
                (containedMessageCountByPreviousIndex.get(previousIndex) ?? 0) + 1,
            );
        }

        let stickyPreviousIndex: number | null = null;
        for (const [previousIndex, containedMessageCount] of containedMessageCountByPreviousIndex) {
            if (containedMessageCount !== previousTurnMessageCounts[previousIndex]) continue;
            if (stickyPreviousIndex == null || previousIndex > stickyPreviousIndex) {
                stickyPreviousIndex = previousIndex;
            }
        }
        if (stickyPreviousIndex == null) return turn;
        return withTurnId(turn, params.previousTurns[stickyPreviousIndex]!.id);
    });
}

export function buildTranscriptTurnsCached(opts: {
    cache: TranscriptTurnsBuildCache | null;
    messageIdsOldestFirst: string[];
    messagesById: Readonly<Record<string, Message>>;
    groupToolCalls: boolean;
    toolCallsGroupStrategy: TranscriptTurnToolCallsGroupStrategy;
}): TranscriptTurnsBuildCache {
    const nextMessageGroupingKeysOldestFirst = opts.messageIdsOldestFirst.map((id) => getMessageGroupingKey(opts.messagesById[id]));
    const canReuse =
        opts.cache != null &&
        opts.cache.groupToolCalls === opts.groupToolCalls &&
        opts.cache.toolCallsGroupStrategy === opts.toolCallsGroupStrategy &&
        isPrefix({ prefix: opts.cache.messageIdsOldestFirst, full: opts.messageIdsOldestFirst }) &&
        isPrefix({ prefix: opts.cache.messageGroupingKeysOldestFirst, full: nextMessageGroupingKeysOldestFirst });

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
            messageGroupingKeysOldestFirst: nextMessageGroupingKeysOldestFirst,
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

    const stickyTurns = opts.cache
        ? applyStickyTurnIdsFromPreviousBuild({ previousTurns: opts.cache.turns, turns })
        : turns;

    return {
        messageIdsOldestFirst: opts.messageIdsOldestFirst,
        messageGroupingKeysOldestFirst: nextMessageGroupingKeysOldestFirst,
        groupToolCalls: opts.groupToolCalls,
        toolCallsGroupStrategy: opts.toolCallsGroupStrategy,
        turns: stickyTurns,
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
