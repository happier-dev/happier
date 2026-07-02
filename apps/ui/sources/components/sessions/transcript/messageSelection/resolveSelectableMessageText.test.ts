import { describe, expect, it } from 'vitest';

import type { AgentTextMessage, Message, UserTextMessage } from '@/sync/domains/messages/messageTypes';

import { resolveSelectableMessageText } from './resolveSelectableMessageText';

function createUserMessage(overrides: Partial<UserTextMessage> = {}): UserTextMessage {
    return {
        kind: 'user-text',
        id: 'u1',
        localId: null,
        createdAt: 1,
        text: 'Hello from user',
        ...overrides,
    };
}

function createAgentMessage(overrides: Partial<AgentTextMessage> = {}): AgentTextMessage {
    return {
        kind: 'agent-text',
        id: 'a1',
        localId: null,
        createdAt: 2,
        text: 'Hello from assistant',
        isThinking: false,
        ...overrides,
    };
}

describe('resolveSelectableMessageText', () => {
    it('resolves user-text messages as user entries', () => {
        expect(resolveSelectableMessageText({
            message: createUserMessage({ text: 'User body' }),
            isStructuredOnly: false,
            hasAttachmentBlockToStrip: false,
        })).toEqual({ role: 'user', text: 'User body' });
    });

    it('prefers displayText for user-text messages', () => {
        expect(resolveSelectableMessageText({
            message: createUserMessage({ text: 'Raw body', displayText: 'Displayed body' }),
            isStructuredOnly: false,
            hasAttachmentBlockToStrip: false,
        })).toEqual({ role: 'user', text: 'Displayed body' });
    });

    it('strips legacy attachment blocks from user-text messages when requested', () => {
        const message = createUserMessage({
            text: [
                'Please inspect this.',
                '',
                'Attachments:',
                '[attachments]',
                '- note.txt',
                '[/attachments]',
                '',
                'Thanks.',
            ].join('\n'),
        });

        expect(resolveSelectableMessageText({
            message,
            isStructuredOnly: false,
            hasAttachmentBlockToStrip: true,
        })).toEqual({ role: 'user', text: 'Please inspect this.\n\nThanks.' });
    });

    it('normalizes voice-agent user turns before returning text', () => {
        const message = createUserMessage({
            text: [
                'At the start of your reply, include a short friendly greeting (one sentence).',
                'Then continue with your response.',
                'Context updates since your last voice turn:',
                'New messages in session: s1 (1 new message)',
                '',
                'User said:',
                'Create a file named voice.txt containing exactly HELLO.',
            ].join('\n'),
            meta: {
                happier: {
                    kind: 'voice_agent_turn.v1',
                    payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'mid', ts: 100 },
                },
            },
        });

        expect(resolveSelectableMessageText({
            message,
            isStructuredOnly: false,
            hasAttachmentBlockToStrip: false,
        })).toEqual({ role: 'user', text: 'Create a file named voice.txt containing exactly HELLO.' });
    });

    it('resolves agent-text messages as assistant entries', () => {
        expect(resolveSelectableMessageText({
            message: createAgentMessage({ text: 'Assistant body' }),
            isStructuredOnly: false,
            hasAttachmentBlockToStrip: false,
        })).toEqual({ role: 'assistant', text: 'Assistant body' });
    });

    it('does not resolve assistant stream segments with unknown state', () => {
        for (const segmentState of [null, 'unknown'] as const) {
            const message = createAgentMessage({
                text: 'Partial assistant output',
                meta: {
                    happierStreamSegmentV1: {
                        v: 1,
                        segmentKind: 'assistant',
                        segmentLocalId: 'assistant-1',
                        segmentState,
                        startedAtMs: 1,
                        updatedAtMs: 2,
                    },
                },
            });

            expect(resolveSelectableMessageText({
                message,
                isStructuredOnly: false,
                hasAttachmentBlockToStrip: false,
            })).toBeNull();
        }
    });

    it('does not resolve actively streaming thinking agent text', () => {
        const message = createAgentMessage({
            isThinking: true,
            meta: {
                happierStreamSegmentV1: {
                    v: 1,
                    segmentKind: 'thinking',
                    segmentLocalId: 'thinking-1',
                    segmentState: 'streaming',
                    startedAtMs: 1,
                    updatedAtMs: 2,
                },
            },
        });

        expect(resolveSelectableMessageText({
            message,
            isStructuredOnly: false,
            hasAttachmentBlockToStrip: false,
        })).toBeNull();
    });

    it('unwraps settled legacy thinking wrappers', () => {
        expect(resolveSelectableMessageText({
            message: createAgentMessage({ isThinking: true, text: '*Thinking...*\n\n*Reasoning body*' }),
            isStructuredOnly: false,
            hasAttachmentBlockToStrip: false,
        })).toEqual({ role: 'assistant', text: 'Reasoning body' });
    });

    it('uses raw text for structured-only user and assistant messages', () => {
        expect(resolveSelectableMessageText({
            message: createUserMessage({ text: '{"kind":"structured"}', displayText: 'Rendered text' }),
            isStructuredOnly: true,
            hasAttachmentBlockToStrip: true,
        })).toEqual({ role: 'user', text: '{"kind":"structured"}' });

        expect(resolveSelectableMessageText({
            message: createAgentMessage({ text: '{"kind":"structured"}' }),
            isStructuredOnly: true,
            hasAttachmentBlockToStrip: false,
        })).toEqual({ role: 'assistant', text: '{"kind":"structured"}' });
    });

    it('does not resolve tool calls or whitespace-only text', () => {
        const toolMessage: Message = {
            kind: 'tool-call',
            id: 'tool-1',
            localId: null,
            createdAt: 3,
            tool: {
                name: 'Bash',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
            },
            children: [],
        };

        expect(resolveSelectableMessageText({
            message: toolMessage,
            isStructuredOnly: false,
            hasAttachmentBlockToStrip: false,
        })).toBeNull();
        expect(resolveSelectableMessageText({
            message: createUserMessage({ text: '   \n\t' }),
            isStructuredOnly: false,
            hasAttachmentBlockToStrip: false,
        })).toBeNull();
    });
});
