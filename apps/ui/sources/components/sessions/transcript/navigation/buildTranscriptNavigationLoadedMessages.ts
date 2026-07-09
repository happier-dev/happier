import { buildMessageRouteId } from '@/sync/domains/messages/messageRouteIds';
import type { Message } from '@/sync/domains/messages/messageTypes';

import { deriveTranscriptNavigationEntries } from './deriveTranscriptNavigationEntries';
import { normalizeTranscriptNavigationTextPreview } from './transcriptNavigationTextPreview';
import type {
    DeriveTranscriptNavigationEntriesParams,
    TranscriptNavigationEntry,
    TranscriptNavigationLoadedMessage,
    TranscriptNavigationLoadedMessageDerivationFacts,
    TranscriptNavigationRole,
} from './transcriptNavigationTypes';

function roleForMessage(message: Message): TranscriptNavigationRole {
    if (message.kind === 'user-text') return 'user';
    if (message.kind === 'agent-text') return 'assistant';
    if (message.kind === 'tool-call') return 'tool';
    if (message.kind === 'agent-event') return 'system';
    return 'unknown';
}

function textForMessage(message: Message): string | null {
    if (message.kind === 'user-text') {
        return message.displayText ?? message.text;
    }
    if (message.kind === 'agent-text') {
        return message.text;
    }
    if (message.kind === 'tool-call') {
        return message.tool.description ?? message.tool.name;
    }
    return null;
}

function normalizeFiniteInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.trunc(value);
}

function normalizeSessionId(value: string): string {
    return value.trim();
}

function buildDerivationFacts(
    sessionId: string,
    row: Readonly<{
        routeMessageId: string | null;
        seq: number | null;
        transcriptBlockIndex: number | null;
        role: TranscriptNavigationRole;
        text: string | null;
        createdAtMs: number | null;
    }>,
): TranscriptNavigationLoadedMessageDerivationFacts {
    return {
        sessionId: normalizeSessionId(sessionId),
        routeMessageId: normalizeTranscriptNavigationTextPreview(row.routeMessageId),
        seq: row.seq,
        transcriptBlockIndex: row.transcriptBlockIndex,
        role: row.role,
        textPreview: normalizeTranscriptNavigationTextPreview(row.text),
        createdAtMs: row.createdAtMs,
    };
}

function buildLoadedMessageRow(sessionId: string, message: Message): TranscriptNavigationLoadedMessage {
    const routeMessageId = buildMessageRouteId(message);
    const row = {
        sessionId,
        messageId: message.id,
        routeMessageId,
        seq: normalizeFiniteInteger(message.seq),
        transcriptBlockIndex: normalizeFiniteInteger(message.transcriptBlockIndex),
        role: roleForMessage(message),
        text: textForMessage(message),
        createdAtMs: normalizeFiniteInteger(message.createdAt),
        loaded: true,
    };
    return {
        ...row,
        derivationFacts: buildDerivationFacts(sessionId, row),
    };
}

export type TranscriptNavigationLoadedMessagesCache = {
    readonly rowsByMessage: WeakMap<Message, TranscriptNavigationLoadedMessage>;
    lastBuild: {
        readonly sessionId: string;
        readonly messageIdsOldestFirst: readonly string[];
        readonly messagesById: Readonly<Record<string, Message>>;
        readonly loadedMessages: TranscriptNavigationLoadedMessage[];
    } | null;
    previousEntries: readonly TranscriptNavigationEntry[] | null;
    lastDerivation: {
        readonly sessionId: string;
        readonly mode: DeriveTranscriptNavigationEntriesParams['mode'];
        readonly loadedMessages: readonly TranscriptNavigationLoadedMessage[];
        readonly remoteUserTurns: DeriveTranscriptNavigationEntriesParams['remoteUserTurns'];
        readonly pins: DeriveTranscriptNavigationEntriesParams['pins'];
        readonly entries: TranscriptNavigationEntry[];
    } | null;
};

export function createTranscriptNavigationLoadedMessagesCache(): TranscriptNavigationLoadedMessagesCache {
    return {
        rowsByMessage: new WeakMap<Message, TranscriptNavigationLoadedMessage>(),
        lastBuild: null,
        previousEntries: null,
        lastDerivation: null,
    };
}

export function buildTranscriptNavigationLoadedMessages(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    sessionId: string;
    cache?: TranscriptNavigationLoadedMessagesCache;
}>): TranscriptNavigationLoadedMessage[] {
    const cachedBuild = params.cache?.lastBuild;
    if (
        cachedBuild
        && cachedBuild.sessionId === params.sessionId
        && cachedBuild.messageIdsOldestFirst === params.messageIdsOldestFirst
        && cachedBuild.messagesById === params.messagesById
    ) {
        return cachedBuild.loadedMessages;
    }

    const loadedMessages: TranscriptNavigationLoadedMessage[] = [];
    for (const messageId of params.messageIdsOldestFirst) {
        const message = params.messagesById[messageId];
        if (!message) continue;
        const cachedRow = params.cache?.rowsByMessage.get(message);
        if (cachedRow && cachedRow.sessionId === params.sessionId) {
            loadedMessages.push(cachedRow);
            continue;
        }

        const row = buildLoadedMessageRow(params.sessionId, message);
        params.cache?.rowsByMessage.set(message, row);
        loadedMessages.push(row);
    }

    if (
        cachedBuild
        && cachedBuild.loadedMessages.length === loadedMessages.length
        && cachedBuild.loadedMessages.every((message, index) => message === loadedMessages[index])
    ) {
        return cachedBuild.loadedMessages;
    }

    if (params.cache) {
        params.cache.lastBuild = {
            sessionId: params.sessionId,
            messageIdsOldestFirst: params.messageIdsOldestFirst,
            messagesById: params.messagesById,
            loadedMessages,
        };
    }

    return loadedMessages;
}

export function deriveTranscriptNavigationEntriesWithLoadedMessageCache(
    params: DeriveTranscriptNavigationEntriesParams & Readonly<{
        cache: TranscriptNavigationLoadedMessagesCache;
    }>,
): TranscriptNavigationEntry[] {
    const cachedDerivation = params.cache.lastDerivation;
    if (
        cachedDerivation
        && cachedDerivation.sessionId === params.sessionId
        && cachedDerivation.mode === params.mode
        && cachedDerivation.loadedMessages === params.loadedMessages
        && cachedDerivation.remoteUserTurns === params.remoteUserTurns
        && cachedDerivation.pins === params.pins
    ) {
        return cachedDerivation.entries;
    }

    const appendEntries = deriveSingleAppendedUserTurnEntries(params, cachedDerivation);
    if (appendEntries) {
        params.cache.previousEntries = appendEntries;
        params.cache.lastDerivation = {
            sessionId: params.sessionId,
            mode: params.mode,
            loadedMessages: params.loadedMessages,
            remoteUserTurns: params.remoteUserTurns,
            pins: params.pins,
            entries: appendEntries,
        };
        return appendEntries;
    }

    const entries = deriveTranscriptNavigationEntries({
        sessionId: params.sessionId,
        mode: params.mode,
        loadedMessages: params.loadedMessages,
        remoteUserTurns: params.remoteUserTurns,
        pins: params.pins,
        previousEntries: params.cache.previousEntries,
    });
    params.cache.previousEntries = entries;
    params.cache.lastDerivation = {
        sessionId: params.sessionId,
        mode: params.mode,
        loadedMessages: params.loadedMessages,
        remoteUserTurns: params.remoteUserTurns,
        pins: params.pins,
        entries,
    };
    return entries;
}

function loadedMessagePrefixMatches(
    previousMessages: readonly TranscriptNavigationLoadedMessage[],
    nextMessages: readonly TranscriptNavigationLoadedMessage[],
): boolean {
    if (nextMessages.length !== previousMessages.length + 1) return false;
    for (let index = 0; index < previousMessages.length; index += 1) {
        if (previousMessages[index] !== nextMessages[index]) return false;
    }
    return true;
}

function deriveSingleAppendedUserTurnEntries(
    params: DeriveTranscriptNavigationEntriesParams & Readonly<{
        cache: TranscriptNavigationLoadedMessagesCache;
    }>,
    cachedDerivation: TranscriptNavigationLoadedMessagesCache['lastDerivation'],
): TranscriptNavigationEntry[] | null {
    if (!cachedDerivation) return null;
    if (cachedDerivation.sessionId !== params.sessionId) return null;
    if (cachedDerivation.mode !== 'all' || params.mode !== 'all') return null;
    if (cachedDerivation.remoteUserTurns !== params.remoteUserTurns) return null;
    if (cachedDerivation.pins !== params.pins) return null;
    if (params.remoteUserTurns.length > 0) return null;
    if (!loadedMessagePrefixMatches(cachedDerivation.loadedMessages, params.loadedMessages)) return null;

    const appendedMessage = params.loadedMessages[params.loadedMessages.length - 1];
    if (!appendedMessage || appendedMessage.role !== 'user') return null;
    const facts = appendedMessage.derivationFacts;
    const sessionId = params.sessionId.trim();
    const seq = facts?.seq ?? normalizeFiniteInteger(appendedMessage.seq);
    const promptPreview = facts?.textPreview ?? normalizeTranscriptNavigationTextPreview(appendedMessage.text);
    if (!sessionId || seq === null || !promptPreview) return null;
    if (params.pins.some((pin) => {
        const pinSeq = normalizeFiniteInteger(pin.seq);
        return pinSeq !== null && pinSeq >= seq;
    })) return null;

    const previousEntries = cachedDerivation.entries;
    const previousMaxSeq = previousEntries.reduce<number | null>((maxSeq, entry) => {
        if (entry.seq === null) return maxSeq;
        return maxSeq === null ? entry.seq : Math.max(maxSeq, entry.seq);
    }, null);
    if (previousMaxSeq !== null && seq < previousMaxSeq) return null;

    return [
        ...previousEntries,
        {
            id: `${sessionId}:user-turn:${seq}`,
            sessionId,
            seq,
            routeMessageId: facts?.routeMessageId ?? normalizeTranscriptNavigationTextPreview(appendedMessage.routeMessageId),
            transcriptBlockIndex: facts?.transcriptBlockIndex ?? normalizeFiniteInteger(appendedMessage.transcriptBlockIndex),
            kind: 'user-turn',
            role: 'user',
            label: promptPreview,
            promptPreview,
            responsePreview: null,
            createdAtMs: facts?.createdAtMs ?? normalizeFiniteInteger(appendedMessage.createdAtMs),
            pinned: false,
            pinnedAtMs: null,
            loaded: appendedMessage.loaded !== false,
        },
    ];
}
