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
        latestTurnStatus: null,
        latestTurnStatusObservedAt: null,
        pendingRequestObservedAt: null,
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
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        messagesVersion: 0,
        lastAppliedAgentStateVersion: null,
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

    it('counts activity from normalized transcript state and reports the live pending request as blocking', async () => {
        const { getSessionActivityForVoiceTool } = await import('./sessionActivity');

        await expect(getSessionActivityForVoiceTool({ sessionId: 's1' })).resolves.toEqual({
            ok: true,
            sessionId: 's1',
            presence: 'online',
            active: true,
            thinking: false,
            working: false,
            blocked: true,
            permissionRequired: true,
            actionRequired: false,
            updatedAt: 123,
            permissionRequestIds: ['req_1'],
            messageCounts: {
                total: 3,
                assistant: 2,
                user: 1,
            },
        });
    });

    it('reports working from fresh turn projection without raw thinking', async () => {
        storage.setState((current) => ({
            ...current,
            sessions: {
                s1: {
                    ...createTestSession('s1'),
                    agentState: { requests: {} },
                    thinking: false,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: Date.now(),
                },
            },
        }));
        const { getSessionActivityForVoiceTool } = await import('./sessionActivity');

        await expect(getSessionActivityForVoiceTool({ sessionId: 's1' })).resolves.toMatchObject({
            ok: true,
            thinking: false,
            working: true,
            blocked: false,
        });
    });

    it('reports permission blocking from projected pending status without request ids', async () => {
        storage.setState((current) => ({
            ...current,
            sessions: {
                s1: {
                    ...createTestSession('s1'),
                    agentState: { requests: {} },
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1,
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 0,
                    pendingRequestObservedAt: Date.now(),
                },
            },
        }));
        const { getSessionActivityForVoiceTool } = await import('./sessionActivity');

        await expect(getSessionActivityForVoiceTool({ sessionId: 's1' })).resolves.toMatchObject({
            ok: true,
            working: false,
            blocked: true,
            permissionRequired: true,
            actionRequired: false,
            permissionRequestIds: [],
        });
    });
});
