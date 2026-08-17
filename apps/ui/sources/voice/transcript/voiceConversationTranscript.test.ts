import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installVoiceStorageModuleMocks } from '@/voice/persistence/installVoiceStorageModuleMocks';

const applyMessages = vi.fn();
const applyMessagesLoaded = vi.fn();
const evictSessionMessages = vi.fn();
const persistSessionTranscriptMessage = vi.hoisted(() => vi.fn(async () => undefined));
type MutableSessionMessagesState = Record<string, { messages: unknown[] }>;

vi.mock('@/sync/sync', () => ({
    sync: { persistSessionTranscriptMessage },
}));

const sessionMessages: MutableSessionMessagesState = {};
const storageState = {
    sessionMessages,
    applyMessagesLoaded: (sessionId: string) => {
        applyMessagesLoaded(sessionId);
        const existing = sessionMessages[sessionId]?.messages ?? [];
        sessionMessages[sessionId] = { messages: existing };
    },
    applyMessages: (sessionId: string, messages: unknown[]) => {
        applyMessages(sessionId, messages);
        const existing = sessionMessages[sessionId]?.messages ?? [];
        sessionMessages[sessionId] = { messages: [...existing, ...messages] };
    },
    evictSessionMessages,
};

installVoiceStorageModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => storageState,
            },
        });
    },
});

describe('voiceConversationTranscript', () => {
    beforeEach(() => {
        applyMessages.mockReset();
        applyMessagesLoaded.mockReset();
        evictSessionMessages.mockReset();
        persistSessionTranscriptMessage.mockReset();
        for (const key of Object.keys(sessionMessages)) {
            delete sessionMessages[key];
        }
    });

    it('appends a user-text transcript message', async () => {
        const { appendVoiceConversationUserText } = await import('./voiceConversationTranscript');

        appendVoiceConversationUserText({
            conversationSessionId: 'carrier-s1',
            text: 'hello from voice',
        });

        expect(applyMessagesLoaded).toHaveBeenCalledWith('carrier-s1');
        expect(applyMessages).toHaveBeenCalledWith(
            'carrier-s1',
            expect.arrayContaining([
                expect.objectContaining({
                    role: 'user',
                    content: { type: 'text', text: 'hello from voice' },
                    isSidechain: false,
                }),
            ]),
        );
    });

    it('trims the conversation session id before appending transcript messages', async () => {
        const { appendVoiceConversationUserText } = await import('./voiceConversationTranscript');

        appendVoiceConversationUserText({
            conversationSessionId: '  carrier-s1  ',
            text: 'hello from voice',
        });

        expect(applyMessagesLoaded).toHaveBeenCalledWith('carrier-s1');
        expect(applyMessages).toHaveBeenCalledWith(
            'carrier-s1',
            expect.arrayContaining([
                expect.objectContaining({
                    role: 'user',
                    content: { type: 'text', text: 'hello from voice' },
                    isSidechain: false,
                }),
            ]),
        );
    });

    it('appends assistant text and plain note messages as agent transcript messages', async () => {
        const {
            appendVoiceConversationAssistantText,
            appendVoiceConversationNoteText,
        } = await import('./voiceConversationTranscript');

        appendVoiceConversationAssistantText({
            conversationSessionId: 'carrier-s1',
            text: 'I checked the workspace.',
        });
        appendVoiceConversationNoteText({
            conversationSessionId: 'carrier-s1',
            text: 'Target session changed to s2',
        });

        expect(applyMessages).toHaveBeenNthCalledWith(
            1,
            'carrier-s1',
            expect.arrayContaining([
                expect.objectContaining({
                    role: 'agent',
                    content: expect.arrayContaining([
                        expect.objectContaining({
                            type: 'text',
                            text: 'I checked the workspace.',
                        }),
                    ]),
                }),
            ]),
        );
        expect(applyMessages).toHaveBeenNthCalledWith(
            2,
            'carrier-s1',
            expect.arrayContaining([
                expect.objectContaining({
                    role: 'agent',
                    meta: {
                        happier: {
                            kind: 'voice_note.v1',
                            payload: { v: 1 },
                        },
                    },
                    content: expect.arrayContaining([
                        expect.objectContaining({
                            type: 'text',
                            text: 'Target session changed to s2',
                        }),
                    ]),
                }),
            ]),
        );
    });

    it('keeps canonical partials ephemeral and persists one stable final across reconnect replay', async () => {
        const {
            projectCanonicalVoiceTranscriptEvent,
            readCanonicalVoiceTranscriptSnapshot,
        } = await import('./voiceConversationTranscript');
        const base = {
            v: 1 as const,
            epoch: 8,
            itemId: 'provider-item-1',
            role: 'assistant' as const,
            provenance: 'live' as const,
        };

        projectCanonicalVoiceTranscriptEvent({
            conversationSessionId: 'carrier-canonical',
            event: {
                ...base,
                type: 'voice.transcript.updated',
                sequence: 1,
                revision: 1,
                eventId: 'partial-1',
                text: 'partial',
            },
        });
        expect(applyMessages).not.toHaveBeenCalled();

        projectCanonicalVoiceTranscriptEvent({
            conversationSessionId: 'carrier-canonical',
            event: {
                ...base,
                type: 'voice.transcript.final',
                sequence: 2,
                revision: 2,
                eventId: 'final-live',
                text: 'final answer',
            },
        });
        projectCanonicalVoiceTranscriptEvent({
            conversationSessionId: 'carrier-canonical',
            event: {
                ...base,
                type: 'voice.transcript.final',
                sequence: 2,
                revision: 2,
                eventId: 'final-replay',
                text: 'final answer',
                provenance: 'replay',
            },
        });

        expect(applyMessages).not.toHaveBeenCalled();
        await expect.poll(() => persistSessionTranscriptMessage.mock.calls.length).toBe(1);
        expect(persistSessionTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'carrier-canonical',
            localId: expect.stringMatching(/^voice-realtime:[^:]+:assistant:provider-item-1$/),
            messageRole: 'agent',
            rawRecord: expect.objectContaining({
                role: 'agent',
                meta: {
                    happier: expect.objectContaining({
                        conversationTurnOriginV1: {
                            v: 1,
                            channel: 'realtime_conversation',
                            modality: 'voice',
                        },
                    }),
                },
            }),
        }));
        expect(sessionMessages['carrier-canonical']).toBeUndefined();
        expect(readCanonicalVoiceTranscriptSnapshot('carrier-canonical')).toEqual([
            expect.objectContaining({ itemId: 'provider-item-1', final: true, text: 'final answer' }),
        ]);
    });

    it('releases only Voice attempt projection state without evicting unrelated Agent rows', async () => {
        const {
            beginCanonicalVoiceTranscriptAttempt,
            projectCanonicalVoiceTranscriptEvent,
            readCanonicalVoiceTranscriptSnapshot,
            releaseCanonicalVoiceTranscriptConversation,
        } = await import('./voiceConversationTranscript');
        sessionMessages['direct-agent-session'] = {
            messages: [{
                id: 'agent-row',
                role: 'agent',
                content: [{ type: 'text', text: 'canonical coding result' }],
            }],
        };
        const attempt = beginCanonicalVoiceTranscriptAttempt({
            conversationSessionId: 'direct-agent-session',
        });
        if (!attempt) throw new Error('expected transcript attempt');
        projectCanonicalVoiceTranscriptEvent({
            conversationSessionId: 'direct-agent-session',
            event: {
                v: 1,
                type: 'voice.transcript.final',
                epoch: attempt.epoch,
                sequence: 1,
                revision: 1,
                eventId: 'voice-final',
                itemId: 'voice-turn',
                role: 'assistant',
                text: 'spoken result',
                provenance: 'live',
            },
        });

        await releaseCanonicalVoiceTranscriptConversation({
            conversationSessionId: 'direct-agent-session',
            attemptIdentity: attempt.attemptIdentity,
        });

        expect(readCanonicalVoiceTranscriptSnapshot('direct-agent-session')).toEqual([]);
        expect(evictSessionMessages).not.toHaveBeenCalled();
        expect(sessionMessages['direct-agent-session']?.messages).toEqual([
            expect.objectContaining({ id: 'agent-row' }),
        ]);
    });

});
