import type { Message, ToolCallMessage, UserTextMessage } from '@/sync/domains/messages/messageTypes';
import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';
import { isToolCallMessageGroupableInTranscript } from '@/components/sessions/transcript/toolCalls/isToolCallMessageGroupableInTranscript';
import { filterVisibleContextCompactionLifecycleMessageIds } from '@/components/sessions/transcript/events/contextCompactionLifecycleProjection';
import { filterCommittedTranscriptMessageIdsForPendingState } from '@/sync/domains/pending/pendingTranscriptProjection';

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
    forkBoundarySignature?: string;
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
 * derive a NEW id from its new first message, re-keying the on-screen virtual row exactly at
 * the pagination anchor and breaking MVCP key-based offset correction (plan C3).
 *
 * Rule: a rebuilt turn that fully contains the messages of a previously-emitted turn keeps that
 * turn's id; embedded tool-group child ids follow. When several previous turns merge into one
 * rebuilt turn, the bottom-most previously-rendered id wins — that is the mounted key the renderer has on
 * screen. Fresh turns (no contained predecessor) keep `turn:<firstMessageId>` derivation.
 *
 * The same containment rule applies one level down to tool-group ids (plan N2c): group ids embed
 * the first tool message id, so a prepend that extends a consecutive tool run upward would
 * otherwise re-key the group (and every per-tool virtualization unit derived from it). A rebuilt
 * `tool_calls` content that fully contains a previously-emitted group's tools keeps that group's
 * id; merge collisions resolve to the bottom-most previously-rendered group id.
 */
function applyStickyTurnIdsFromPreviousBuild(params: Readonly<{
    previousTurns: readonly TranscriptTurn[];
    turns: readonly TranscriptTurn[];
}>): TranscriptTurn[] {
    const turns = [...params.turns];
    if (params.previousTurns.length === 0 || turns.length === 0) return turns;

    const previousTurnIndexByMessageId = new Map<string, number>();
    const previousTurnMessageCounts: number[] = [];
    const previousGroupIndexByToolMessageId = new Map<string, number>();
    const previousGroupToolCounts: number[] = [];
    const previousGroupIds: string[] = [];
    params.previousTurns.forEach((previousTurn, previousIndex) => {
        const messageIds = collectTurnMessageIds(previousTurn);
        previousTurnMessageCounts.push(messageIds.length);
        for (const messageId of messageIds) {
            previousTurnIndexByMessageId.set(messageId, previousIndex);
        }
        for (const content of previousTurn.content) {
            if (content.kind !== 'tool_calls' || content.toolMessageIds.length === 0) continue;
            const groupIndex = previousGroupIds.length;
            previousGroupIds.push(content.id);
            previousGroupToolCounts.push(content.toolMessageIds.length);
            for (const toolMessageId of content.toolMessageIds) {
                previousGroupIndexByToolMessageId.set(toolMessageId, groupIndex);
            }
        }
    });

    const withStickyGroupIds = (turn: TranscriptTurn): TranscriptTurn => {
        if (previousGroupIds.length === 0) return turn;
        let didChange = false;
        const content = turn.content.map((entry) => {
            if (entry.kind !== 'tool_calls') return entry;
            const containedToolCountByGroupIndex = new Map<number, number>();
            for (const toolMessageId of entry.toolMessageIds) {
                const groupIndex = previousGroupIndexByToolMessageId.get(toolMessageId);
                if (groupIndex == null) continue;
                containedToolCountByGroupIndex.set(
                    groupIndex,
                    (containedToolCountByGroupIndex.get(groupIndex) ?? 0) + 1,
                );
            }
            let stickyGroupIndex: number | null = null;
            for (const [groupIndex, containedToolCount] of containedToolCountByGroupIndex) {
                if (containedToolCount !== previousGroupToolCounts[groupIndex]) continue;
                if (stickyGroupIndex == null || groupIndex > stickyGroupIndex) {
                    stickyGroupIndex = groupIndex;
                }
            }
            if (stickyGroupIndex == null) return entry;
            const stickyGroupId = previousGroupIds[stickyGroupIndex]!;
            if (entry.id === stickyGroupId) return entry;
            didChange = true;
            return { ...entry, id: stickyGroupId };
        });
        return didChange ? { ...turn, content } : turn;
    };

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
        const stickyTurn = stickyPreviousIndex == null
            ? turn
            : withTurnId(turn, params.previousTurns[stickyPreviousIndex]!.id);
        return withStickyGroupIds(stickyTurn);
    });
}

export function buildTranscriptTurnsCached(opts: {
    cache: TranscriptTurnsBuildCache | null;
    messageIdsOldestFirst: string[];
    messagesById: Readonly<Record<string, Message>>;
    pendingMessages?: readonly PendingMessage[] | null;
    discardedMessages?: readonly DiscardedPendingMessage[] | null;
    groupToolCalls: boolean;
    toolCallsGroupStrategy: TranscriptTurnToolCallsGroupStrategy;
    forkBoundaryBeforeMessageIds?: ReadonlySet<string>;
    forkBoundarySignature?: string;
    forkMetadataByMessageId?: Readonly<Record<string, unknown>>;
}): TranscriptTurnsBuildCache {
    const contextVisibleMessageIdsOldestFirst = filterVisibleContextCompactionLifecycleMessageIds(opts.messageIdsOldestFirst, opts.messagesById);
    const visibleMessageIdsOldestFirst = filterCommittedTranscriptMessageIdsForPendingState({
        messageIdsOldestFirst: contextVisibleMessageIdsOldestFirst,
        messagesById: opts.messagesById,
        pendingMessages: opts.pendingMessages,
        discardedMessages: opts.discardedMessages,
    });
    const nextMessageGroupingKeysOldestFirst = visibleMessageIdsOldestFirst.map((id) => getMessageGroupingKey(opts.messagesById[id]));
    const canReuse =
        opts.cache != null &&
        opts.cache.groupToolCalls === opts.groupToolCalls &&
        opts.cache.toolCallsGroupStrategy === opts.toolCallsGroupStrategy &&
        opts.cache.forkBoundarySignature === opts.forkBoundarySignature &&
        isPrefix({ prefix: opts.cache.messageIdsOldestFirst, full: visibleMessageIdsOldestFirst }) &&
        isPrefix({ prefix: opts.cache.messageGroupingKeysOldestFirst, full: nextMessageGroupingKeysOldestFirst });

    // Append-only incremental path.
    if (canReuse && opts.cache!.messageIdsOldestFirst.length <= visibleMessageIdsOldestFirst.length) {
        const prev = opts.cache!;
        const prevLen = prev.messageIdsOldestFirst.length;
        const nextLen = visibleMessageIdsOldestFirst.length;
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
            const id = visibleMessageIdsOldestFirst[i]!;
            const message = opts.messagesById[id];
            if (!message) continue;

            if (isUserMessage(message)) {
                pushNewTurn(createTurn({ baseId: message.id, userMessageId: message.id }), createEmptyLastTurnState(opts));
                continue;
            }

            if (nextTurns.length === 0 || opts.forkBoundaryBeforeMessageIds?.has(id) === true) {
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
            messageIdsOldestFirst: visibleMessageIdsOldestFirst,
            messageGroupingKeysOldestFirst: nextMessageGroupingKeysOldestFirst,
            groupToolCalls: opts.groupToolCalls,
            toolCallsGroupStrategy: opts.toolCallsGroupStrategy,
            forkBoundarySignature: opts.forkBoundarySignature,
            turns: nextTurns,
            lastTurnState,
        };
    }

    // Full rebuild.
    const turns: TranscriptTurn[] = [];
    let lastTurnState = createEmptyLastTurnState(opts);

    for (const id of visibleMessageIdsOldestFirst) {
        const message = opts.messagesById[id];
        if (!message) continue;

        if (isUserMessage(message)) {
            turns.push(createTurn({ baseId: message.id, userMessageId: message.id }));
            lastTurnState = createEmptyLastTurnState(opts);
            continue;
        }

        if (turns.length === 0 || opts.forkBoundaryBeforeMessageIds?.has(id) === true) {
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
        messageIdsOldestFirst: visibleMessageIdsOldestFirst,
        messageGroupingKeysOldestFirst: nextMessageGroupingKeysOldestFirst,
        groupToolCalls: opts.groupToolCalls,
        toolCallsGroupStrategy: opts.toolCallsGroupStrategy,
        forkBoundarySignature: opts.forkBoundarySignature,
        turns: stickyTurns,
        lastTurnState,
    };
}

export function buildTranscriptTurns(opts: {
    messageIdsOldestFirst: string[];
    messagesById: Readonly<Record<string, Message>>;
    pendingMessages?: readonly PendingMessage[] | null;
    discardedMessages?: readonly DiscardedPendingMessage[] | null;
    groupToolCalls: boolean;
    toolCallsGroupStrategy: TranscriptTurnToolCallsGroupStrategy;
    forkBoundaryBeforeMessageIds?: ReadonlySet<string>;
    forkBoundarySignature?: string;
    forkMetadataByMessageId?: Readonly<Record<string, unknown>>;
}): TranscriptTurn[] {
    return buildTranscriptTurnsCached({
        cache: null,
        messageIdsOldestFirst: opts.messageIdsOldestFirst,
        messagesById: opts.messagesById,
        pendingMessages: opts.pendingMessages,
        discardedMessages: opts.discardedMessages,
        groupToolCalls: opts.groupToolCalls,
        toolCallsGroupStrategy: opts.toolCallsGroupStrategy,
        forkBoundaryBeforeMessageIds: opts.forkBoundaryBeforeMessageIds,
        forkBoundarySignature: opts.forkBoundarySignature,
        forkMetadataByMessageId: opts.forkMetadataByMessageId,
    }).turns;
}
