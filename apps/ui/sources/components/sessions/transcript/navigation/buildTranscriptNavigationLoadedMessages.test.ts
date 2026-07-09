import { describe, expect, it } from 'vitest';

import {
    buildTranscriptNavigationLoadedMessages,
    createTranscriptNavigationLoadedMessagesCache,
    deriveTranscriptNavigationEntriesWithLoadedMessageCache,
} from './buildTranscriptNavigationLoadedMessages';
import type { TranscriptNavigationEntry } from './transcriptNavigationTypes';

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

function deriveEntries(params: Readonly<{
    cache: ReturnType<typeof createTranscriptNavigationLoadedMessagesCache>;
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, TestMessage>>;
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
        remoteUserTurns: [],
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
            remoteUserTurns: [],
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
            remoteUserTurns: [],
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
