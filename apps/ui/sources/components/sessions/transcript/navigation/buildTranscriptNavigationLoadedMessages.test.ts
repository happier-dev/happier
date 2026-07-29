import { describe, expect, it } from 'vitest';

import {
    buildTranscriptNavigationLoadedMessages,
    buildTranscriptNavigationRemoteMessages,
    createTranscriptNavigationLoadedMessagesCache,
    deriveTranscriptNavigationEntriesWithLoadedMessageCache,
    resolveTranscriptNavigationRemoteHistoryBeforeSeq,
} from './buildTranscriptNavigationLoadedMessages';
import type { TranscriptNavigationEntry, TranscriptNavigationLoadedMessage } from './transcriptNavigationTypes';

type TestMessage = Parameters<typeof buildTranscriptNavigationLoadedMessages>[0]['messagesById'][string];

function userMessage(id: string, seq: number, text: string): TestMessage {
    return {
        id,
        kind: 'user-text',
        seq,
        text,
        createdAt: seq * 100,
        transcriptBlockIndex: 0,
    } as TestMessage;
}

function assistantMessage(id: string, seq: number, text: string): TestMessage {
    return {
        id,
        kind: 'agent-text',
        seq,
        text,
        createdAt: seq * 100,
        transcriptBlockIndex: 1,
    } as TestMessage;
}

const NO_REMOTE_MESSAGES: readonly TranscriptNavigationLoadedMessage[] = [];

function deriveEntries(params: Readonly<{
    cache: ReturnType<typeof createTranscriptNavigationLoadedMessagesCache>;
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, TestMessage>>;
    remoteMessages?: readonly TranscriptNavigationLoadedMessage[];
}>): readonly TranscriptNavigationEntry[] {
    const loadedMessages = buildTranscriptNavigationLoadedMessages({
        cache: params.cache,
        sessionId: 'session-1',
        messageIdsOldestFirst: params.messageIdsOldestFirst,
        messagesById: params.messagesById,
    });

    return deriveTranscriptNavigationEntriesWithLoadedMessageCache({
        cache: params.cache,
        sessionId: 'session-1',
        mode: 'all',
        loadedMessages,
        remoteMessages: params.remoteMessages ?? NO_REMOTE_MESSAGES,
        pins: [],
    });
}

describe('buildTranscriptNavigationLoadedMessages', () => {
    it('keeps loaded message facts ordered by transcript ids and normalizes missing optional fields', () => {
        const loaded = buildTranscriptNavigationLoadedMessages({
            sessionId: 'session-1',
            messageIdsOldestFirst: ['user-1', 'missing', 'assistant-1', 'tool-1'],
            messagesById: {
                'user-1': {
                    id: 'user-1',
                    kind: 'user-text',
                    seq: 7,
                    text: 'raw prompt',
                    displayText: 'display prompt',
                    createdAt: 10,
                    transcriptBlockIndex: 0,
                } as any,
                'assistant-1': {
                    id: 'assistant-1',
                    kind: 'agent-text',
                    seq: 8,
                    text: 'answer',
                    createdAt: 11.9,
                    transcriptBlockIndex: 1,
                } as any,
                'tool-1': {
                    id: 'tool-1',
                    kind: 'tool-call',
                    seq: Number.NaN,
                    tool: { name: 'shell', description: 'Run shell' },
                    createdAt: null,
                    transcriptBlockIndex: null,
                } as any,
            },
        });

        expect(loaded.map((message) => ({
            messageId: message.messageId,
            role: message.role,
            seq: message.seq,
            transcriptBlockIndex: message.transcriptBlockIndex,
            text: message.text,
            createdAtMs: message.createdAtMs,
            loaded: message.loaded,
        }))).toEqual([
            {
                messageId: 'user-1',
                role: 'user',
                seq: 7,
                transcriptBlockIndex: 0,
                text: 'display prompt',
                createdAtMs: 10,
                loaded: true,
            },
            {
                messageId: 'assistant-1',
                role: 'assistant',
                seq: 8,
                transcriptBlockIndex: 1,
                text: 'answer',
                createdAtMs: 11,
                loaded: true,
            },
            {
                messageId: 'tool-1',
                role: 'tool',
                seq: null,
                transcriptBlockIndex: null,
                text: 'Run shell',
                createdAtMs: null,
                loaded: true,
            },
        ]);
    });

    it('does not offer agent thinking as a reply preview', () => {
        const entries = deriveEntries({
            cache: createTranscriptNavigationLoadedMessagesCache(),
            messageIdsOldestFirst: ['user-1', 'thinking-1'],
            messagesById: {
                'user-1': userMessage('user-1', 1, 'Why is the build red?'),
                'thinking-1': {
                    id: 'thinking-1',
                    kind: 'agent-text',
                    seq: 2,
                    text: 'Let me consider the failing target',
                    isThinking: true,
                    createdAt: 200,
                    transcriptBlockIndex: 1,
                } as TestMessage,
            },
        });

        expect(entries.map((entry) => [entry.seq, entry.responsePreview])).toEqual([[1, null]]);
    });

    it('maps remote history rows into unloaded navigation rows with clamped previews', () => {
        const remoteMessages = buildTranscriptNavigationRemoteMessages({
            sessionId: 'session-1',
            rows: [
                { messageId: 'r1', routeMessageId: 'server:r1', seq: 3, createdAt: 30, role: 'user', text: '**Bold** prompt' },
                { messageId: 'r2', routeMessageId: 'server:r2', seq: 4, createdAt: 40, role: 'assistant', text: 'y'.repeat(400) },
                { messageId: 'r3', routeMessageId: 'server:r3', seq: 5, createdAt: 50, role: 'tool', text: 'Run the tests' },
                { messageId: 'r4', routeMessageId: 'server:r4', seq: 6, createdAt: 60, role: 'user', text: '   ' },
            ],
        });

        expect(remoteMessages.map((message) => ({
            messageId: message.messageId,
            role: message.role,
            loaded: message.loaded,
            textLength: message.text?.length ?? 0,
        }))).toEqual([
            { messageId: 'r1', role: 'user', loaded: false, textLength: 'Bold prompt'.length },
            { messageId: 'r2', role: 'assistant', loaded: false, textLength: 220 },
            { messageId: 'r3', role: 'tool', loaded: false, textLength: 'Run the tests'.length },
        ]);
    });

    it('uses the oldest loaded seq as the remote history cursor regardless of role', () => {
        const loadedMessages = buildTranscriptNavigationLoadedMessages({
            sessionId: 'session-1',
            messageIdsOldestFirst: ['assistant-1', 'user-1'],
            messagesById: {
                'assistant-1': assistantMessage('assistant-1', 11, 'Answer without its prompt'),
                'user-1': userMessage('user-1', 12, 'Next prompt'),
            },
        });

        expect(resolveTranscriptNavigationRemoteHistoryBeforeSeq(loadedMessages)).toBe(11);
    });

    it('returns the same loaded message and derived entry references for the same host inputs', () => {
        const cache = createTranscriptNavigationLoadedMessagesCache();
        const messageIdsOldestFirst = ['user-1', 'assistant-1'];
        const messagesById = {
            'user-1': userMessage('user-1', 1, 'Explain **memoization**'),
            'assistant-1': assistantMessage('assistant-1', 2, 'Use a row cache'),
        };

        const firstLoaded = buildTranscriptNavigationLoadedMessages({
            cache,
            sessionId: 'session-1',
            messageIdsOldestFirst,
            messagesById,
        });
        const firstEntries = deriveTranscriptNavigationEntriesWithLoadedMessageCache({
            cache,
            sessionId: 'session-1',
            mode: 'all',
            loadedMessages: firstLoaded,
            remoteMessages: [],
            pins: [],
        });

        const secondLoaded = buildTranscriptNavigationLoadedMessages({
            cache,
            sessionId: 'session-1',
            messageIdsOldestFirst,
            messagesById,
        });
        const secondEntries = deriveTranscriptNavigationEntriesWithLoadedMessageCache({
            cache,
            sessionId: 'session-1',
            mode: 'all',
            loadedMessages: secondLoaded,
            remoteMessages: [],
            pins: [],
        });

        expect(secondLoaded).toBe(firstLoaded);
        expect(secondEntries).toBe(firstEntries);
    });

    it('keeps previously derived entry objects stable when appending a message', () => {
        const cache = createTranscriptNavigationLoadedMessagesCache();
        const user1 = userMessage('user-1', 1, 'First prompt');
        const assistant1 = assistantMessage('assistant-1', 2, 'First answer');
        const user2 = userMessage('user-2', 3, 'Second prompt');

        const before = deriveEntries({
            cache,
            messageIdsOldestFirst: ['user-1', 'assistant-1'],
            messagesById: {
                'user-1': user1,
                'assistant-1': assistant1,
            },
        });
        const after = deriveEntries({
            cache,
            messageIdsOldestFirst: ['user-1', 'assistant-1', 'user-2'],
            messagesById: {
                'user-1': user1,
                'assistant-1': assistant1,
                'user-2': user2,
            },
        });

        expect(after).toHaveLength(2);
        expect(after[0]).toBe(before[0]);
        expect(after[1]?.promptPreview).toBe('Second prompt');
    });

    it('keeps entry identity stable on append even when remote history rows are present', () => {
        const cache = createTranscriptNavigationLoadedMessagesCache();
        const remoteMessages = buildTranscriptNavigationRemoteMessages({
            sessionId: 'session-1',
            rows: [
                { messageId: 'r1', routeMessageId: 'server:r1', seq: 1, createdAt: 100, role: 'user', text: 'Remote prompt' },
                { messageId: 'r2', routeMessageId: 'server:r2', seq: 2, createdAt: 200, role: 'assistant', text: 'Remote answer' },
            ],
        });
        const user1 = userMessage('user-1', 5, 'First prompt');
        const assistant1 = assistantMessage('assistant-1', 6, 'First answer');
        const user2 = userMessage('user-2', 7, 'Second prompt');

        const before = deriveEntries({
            cache,
            remoteMessages,
            messageIdsOldestFirst: ['user-1', 'assistant-1'],
            messagesById: { 'user-1': user1, 'assistant-1': assistant1 },
        });
        const after = deriveEntries({
            cache,
            remoteMessages,
            messageIdsOldestFirst: ['user-1', 'assistant-1', 'user-2'],
            messagesById: { 'user-1': user1, 'assistant-1': assistant1, 'user-2': user2 },
        });

        expect(before.map((entry) => [entry.seq, entry.responsePreview])).toEqual([
            [1, 'Remote answer'],
            [5, 'First answer'],
        ]);
        expect(after).toHaveLength(3);
        expect(after[0]).toBe(before[0]);
        expect(after[1]).toBe(before[1]);
        expect(after[2]?.promptPreview).toBe('Second prompt');
    });

    it('replaces only the edited message entry object when message text identity changes', () => {
        const cache = createTranscriptNavigationLoadedMessagesCache();
        const user1 = userMessage('user-1', 1, 'First prompt');
        const assistant1 = assistantMessage('assistant-1', 2, 'First answer');
        const user2 = userMessage('user-2', 3, 'Second prompt');

        const before = deriveEntries({
            cache,
            messageIdsOldestFirst: ['user-1', 'assistant-1', 'user-2'],
            messagesById: {
                'user-1': user1,
                'assistant-1': assistant1,
                'user-2': user2,
            },
        });
        const editedUser2 = userMessage('user-2', 3, 'Second prompt edited');
        const after = deriveEntries({
            cache,
            messageIdsOldestFirst: ['user-1', 'assistant-1', 'user-2'],
            messagesById: {
                'user-1': user1,
                'assistant-1': assistant1,
                'user-2': editedUser2,
            },
        });

        expect(after).toHaveLength(2);
        expect(after[0]).toBe(before[0]);
        expect(after[1]).not.toBe(before[1]);
        expect(after[1]?.promptPreview).toBe('Second prompt edited');
    });
});
