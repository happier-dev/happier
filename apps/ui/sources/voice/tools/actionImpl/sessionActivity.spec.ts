import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createReducer } from '@/sync/reducer/reducer';
import type { SessionMessages } from '@/sync/store/domains/messages';

function createTestSession(id: string): Session {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 123,
        active: true,
        activeAt: 0,
        metadata: {
            path: '',
            host: '',
        },
        metadataVersion: 0,
        agentState: {
            requests: {
                req_1: {
                    tool: 'session.open',
                    arguments: {},
                },
            },
        },
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

function createTestSessionMessages(messages: ReadonlyArray<Message>): SessionMessages {
    const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
    return {
        messageIdsOldestFirst: messages.map((message) => message.id),
        messagesById,
        messagesMap: messagesById,
        reducerState: createReducer(),
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        messagesVersion: 0,
        isLoaded: true,
    };
}

describe('getSessionActivityForVoiceTool', () => {
    beforeEach(() => {
        storage.setState((current) => ({
            ...current,
            sessions: {
                s1: createTestSession('s1'),
            },
            sessionListIndexByServerId: {
                'server-a': [
                    { type: 'session', sessionId: 's1', serverId: 'server-a', serverName: 'Server A' },
                ],
            },
            concurrentSessionListCacheByServerId: {},
            sessionMessages: {
                s1: createTestSessionMessages([
                    { id: 'm1', kind: 'user-text', localId: null, text: 'hi', createdAt: 1 },
                    { id: 'm2', kind: 'agent-text', localId: null, text: 'hello', createdAt: 2 },
                    {
                        id: 'm3',
                        kind: 'tool-call',
                        localId: null,
                        createdAt: 3,
                        tool: {
                            name: 'session.open',
                            state: 'completed',
                            input: {},
                            createdAt: 3,
                            startedAt: 3,
                            completedAt: 3,
                            description: null,
                        },
                        children: [],
                    },
                ]),
            },
        }));
    });

    afterEach(() => {
        storage.setState((current) => ({
            ...current,
            sessions: {},
            sessionMessages: {},
        }));
    });

    it('counts activity from normalized transcript state', async () => {
        const { getSessionActivityForVoiceTool } = await import('./sessionActivity');

        await expect(getSessionActivityForVoiceTool({ sessionId: 's1' })).resolves.toEqual({
            ok: true,
            sessionId: 's1',
            presence: 'online',
            active: true,
            thinking: false,
            updatedAt: 123,
            permissionRequestIds: ['req_1'],
            messageCounts: {
                total: 3,
                assistant: 2,
                user: 1,
            },
        });
    });

    it('uses visible lookup session state when the raw session is not hydrated', async () => {
        const { getSessionActivityForVoiceTool } = await import('./sessionActivity');

        storage.setState((current) => ({
            ...current,
            sessions: {},
            sessionListIndexByServerId: {
                'server-a': [
                    { type: 'session', sessionId: 's_cached', serverId: 'server-a', serverName: 'Server A' },
                ],
            },
            concurrentSessionListCacheByServerId: {
                'server-a': {
                    serverName: 'Server A',
                    sessions: {
                        s_cached: {
                            id: 's_cached',
                            seq: 0,
                            createdAt: 0,
                            active: false,
                            activeAt: 0,
                            updatedAt: 456,
                            metadataVersion: 0,
                            agentStateVersion: 0,
                            thinking: false,
                            thinkingAt: 0,
                            presence: 'online',
                            agentState: {
                                requests: {
                                    req_cached: {
                                        tool: 'session.open',
                                        arguments: {},
                                    },
                                },
                            },
                            metadata: {
                                path: '/tmp/cached',
                                host: 'cached-host',
                            },
                        },
                    },
                },
            },
            sessionMessages: {
                s_cached: createTestSessionMessages([
                    { id: 'm1', kind: 'user-text', localId: null, text: 'cached hi', createdAt: 1 },
                    { id: 'm2', kind: 'agent-text', localId: null, text: 'cached hello', createdAt: 2 },
                ]),
            },
        }));

        await expect(getSessionActivityForVoiceTool({ sessionId: 's_cached' })).resolves.toEqual({
            ok: true,
            sessionId: 's_cached',
            presence: 'online',
            active: false,
            thinking: false,
            updatedAt: 456,
            permissionRequestIds: ['req_cached'],
            messageCounts: {
                total: 2,
                assistant: 1,
                user: 1,
            },
        });
    });

    it('does not treat a raw-only session as visible voice-tool activity', async () => {
        const { getSessionActivityForVoiceTool } = await import('./sessionActivity');

        storage.setState((current) => ({
            ...current,
            sessions: {
                s_raw: createTestSession('s_raw'),
            },
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
            sessionMessages: {
                s_raw: createTestSessionMessages([
                    { id: 'm1', kind: 'user-text', localId: null, text: 'raw hi', createdAt: 1 },
                ]),
            },
        }));

        await expect(getSessionActivityForVoiceTool({ sessionId: 's_raw' })).resolves.toEqual({
            ok: false,
            errorCode: 'session_not_found',
            errorMessage: 'session_not_found',
            sessionId: 's_raw',
        });
    });
});
