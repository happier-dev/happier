import { describe, expect, it } from 'vitest';

import { buildLatestSessionSnapshot } from './bugReportSessionSnapshot';

describe('bugReportSessionSnapshot', () => {
    it('returns null when no sessions exist', () => {
        const snapshot = buildLatestSessionSnapshot({
            sessions: {},
            sessionMessages: {},
            sessionPending: {},
        });
        expect(snapshot).toBeNull();
    });

    it('builds a sanitized summary for the latest session', () => {
        const message = {
            id: 'message-1', kind: 'assistant-text', createdAt: 29, localId: 'local-1',
            text: 'private assistant content',
            tool: { input: { token: 'private tool credential' }, result: 'private tool result' },
        };
        const pending = { id: 'pending-1', localId: 'pending-local', text: 'private pending prompt' };
        const snapshot = buildLatestSessionSnapshot({
            sessions: {
                older: {
                    id: 'older',
                    updatedAt: 10,
                    createdAt: 5,
                    agent: 'codex',
                },
                latest: {
                    id: 'latest',
                    updatedAt: 30,
                    createdAt: 20,
                    agent: 'claude',
                    machineId: 'machine-1',
                    permissionMode: 'default',
                    modelMode: 'auto',
                    metadata: { summary: { text: 'private session summary' }, path: '/private/workspace' },
                },
            },
            sessionMessages: {
                latest: {
                    messageIdsOldestFirst: ['message-1'],
                    messagesById: {
                        'message-1': message,
                    },
                },
            },
            sessionPending: {
                latest: {
                    messages: [pending],
                },
            },
        });

        expect(snapshot).toEqual({
            sessionId: 'latest', createdAt: 20, updatedAt: 30,
            agent: 'claude', machineId: 'machine-1', permissionMode: 'default', modelMode: 'auto',
            messageCount: 1, pendingCount: 1,
            recentMessages: [{
                id: 'message-1',
                kind: 'assistant-text',
                createdAt: 29,
                localId: 'local-1',
            }],
        });
    });

    it('chooses the latest user-facing session when a newer hidden carrier exists', () => {
        const snapshot = buildLatestSessionSnapshot({
            sessions: {
                visible: {
                    id: 'visible',
                    updatedAt: 30,
                    createdAt: 20,
                    agent: 'codex',
                    metadata: {
                        summary: { text: 'Visible work' },
                    },
                },
                voiceHistory: {
                    id: 'voiceHistory',
                    updatedAt: 40,
                    createdAt: 35,
                    metadata: {
                        systemSessionV1: {
                            v: 1,
                            key: 'voice_transcript_history',
                            hidden: true,
                        },
                    },
                },
            },
            sessionMessages: {
                visible: {
                    messages: [{ id: 'visible-message', kind: 'user-text', createdAt: 29 }],
                },
                voiceHistory: {
                    messages: [{ id: 'hidden-message', kind: 'user-text', createdAt: 39 }],
                },
            },
            sessionPending: {},
        });

        expect(snapshot?.sessionId).toBe('visible');
        expect(snapshot?.recentMessages.map((message) => message.id)).toEqual(['visible-message']);
    });

    it('keeps the latest 30 messages by createdAt order', () => {
        const messages = Array.from({ length: 40 }, (_, index) => ({
            id: `message-${index + 1}`,
            kind: 'assistant-text',
            createdAt: index + 1,
            localId: null,
        }));

        const snapshot = buildLatestSessionSnapshot({
            sessions: {
                latest: {
                    id: 'latest',
                    updatedAt: 40,
                    createdAt: 1,
                },
            },
            sessionMessages: {
                latest: {
                    // Retained arrival order may differ from timestamp order.
                    messageIdsOldestFirst: messages.map((m) => m.id).reverse(),
                    messagesById: Object.fromEntries(messages.map((m) => [m.id, m])),
                },
            },
            sessionPending: {},
        });

        expect(snapshot?.recentMessages.map((message) => message.id)).toEqual(
            Array.from({ length: 30 }, (_, index) => `message-${index + 11}`),
        );
    });
});
