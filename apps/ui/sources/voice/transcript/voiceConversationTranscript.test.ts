import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installVoiceStorageModuleMocks } from '@/voice/persistence/installVoiceStorageModuleMocks';
import type { VoiceTranscriptEvent } from './voiceConversationTranscript';

const applyMessages = vi.fn();
const applyMessagesLoaded = vi.fn();
type MutableSessionMessagesState = Record<string, { messages: unknown[] }>;

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

    it('projects user transcript payloads into selector-visible hidden conversation turns', async () => {
        const { projectRealtimeVoiceTranscriptEvent } = await import('./voiceConversationTranscript');
        const { selectVoiceTranscriptEntriesForConversationSession } = await import('./voiceTranscriptSelectors');
        const event = {
            type: 'user_transcript',
            user_transcription_event: {
                user_transcript: 'open the session',
                event_id: 1,
            },
            turn: {
                epoch: 7,
                role: 'user',
                ts: 123,
                voiceAgentId: 'voice-agent-1',
                runId: 'run_1',
                streamId: 'stream_1',
            },
        } satisfies VoiceTranscriptEvent;

        projectRealtimeVoiceTranscriptEvent({
            conversationSessionId: 'carrier-s1',
            payload: event,
        });

        expect(selectVoiceTranscriptEntriesForConversationSession(storageState, 'carrier-s1')).toEqual([
            expect.objectContaining({
                id: 'voice-turn:voice-agent-1:run_1:stream_1:7:user:123',
                kind: 'user',
                text: 'open the session',
            }),
        ]);
    });

    it('projects agent response correction payloads into selector-visible hidden conversation note turns', async () => {
        const { projectRealtimeVoiceTranscriptEvent } = await import('./voiceConversationTranscript');
        const { selectVoiceTranscriptEntriesForConversationSession } = await import('./voiceTranscriptSelectors');

        projectRealtimeVoiceTranscriptEvent({
            conversationSessionId: 'carrier-s1',
            payload: {
                type: 'agent_response_correction',
                agent_response_correction_event: {
                    original_agent_response: 'old answer',
                    corrected_agent_response: 'new answer',
                    event_id: 2,
                },
            },
        });

        expect(selectVoiceTranscriptEntriesForConversationSession(storageState, 'carrier-s1')).toEqual([
            expect.objectContaining({
                kind: 'note',
                text: 'Agent response corrected: new answer',
            }),
        ]);
    });

    it('projects generic assistant and user payloads into selector-visible hidden conversation turns', async () => {
        const { projectRealtimeVoiceTranscriptEvent } = await import('./voiceConversationTranscript');
        const { selectVoiceTranscriptEntriesForConversationSession } = await import('./voiceTranscriptSelectors');

        projectRealtimeVoiceTranscriptEvent({
            conversationSessionId: 'carrier-s1',
            payload: {
                source: 'ai',
                role: 'agent',
                message: 'I am Happier Voice.',
            },
        });
        projectRealtimeVoiceTranscriptEvent({
            conversationSessionId: 'carrier-s1',
            payload: {
                source: 'user',
                role: 'user',
                message: 'Open the session picker.',
            },
        });

        expect(selectVoiceTranscriptEntriesForConversationSession(storageState, 'carrier-s1')).toEqual([
            expect.objectContaining({
                kind: 'assistant',
                text: 'I am Happier Voice.',
            }),
            expect.objectContaining({
                kind: 'user',
                text: 'Open the session picker.',
            }),
        ]);
    });

    it('projects tool lifecycle payloads into selector-visible hidden conversation note turns', async () => {
        const { projectRealtimeVoiceTranscriptEvent } = await import('./voiceConversationTranscript');
        const { selectVoiceTranscriptEntriesForConversationSession } = await import('./voiceTranscriptSelectors');

        projectRealtimeVoiceTranscriptEvent({
            conversationSessionId: 'carrier-s1',
            payload: {
                type: 'client_tool_call',
                client_tool_call: {
                    tool_name: 'sendSessionMessage',
                    tool_call_id: 'tool_1',
                    parameters: { message: 'hello' },
                    event_id: 3,
                },
            },
        });
        projectRealtimeVoiceTranscriptEvent({
            conversationSessionId: 'carrier-s1',
            payload: {
                type: 'agent_tool_response',
                agent_tool_response: {
                    tool_name: 'sendSessionMessage',
                    tool_call_id: 'tool_1',
                    tool_type: 'client',
                    is_error: false,
                    is_called: true,
                    event_id: 4,
                },
            },
        });

        expect(selectVoiceTranscriptEntriesForConversationSession(storageState, 'carrier-s1')).toEqual([
            expect.objectContaining({
                kind: 'note',
                text: 'Tool call: sendSessionMessage',
            }),
            expect.objectContaining({
                kind: 'note',
                text: 'Tool result: sendSessionMessage succeeded',
            }),
        ]);
    });
});
