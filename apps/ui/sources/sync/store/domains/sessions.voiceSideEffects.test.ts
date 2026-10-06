import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { activatePendingQueueScope } from '../../engine/pending/pendingQueueV2.testHelpers';

beforeEach(async () => {
    await loadSyncSingletonForTests();
    storage.setState(storage.getInitialState(), true);
    await activatePendingQueueScope({ serverId: 'server_1', accountId: 'account_a' });
});

afterEach(() => {
    storage.setState(storage.getInitialState(), true);
    vi.clearAllMocks();
});

function createHarness(_createSessionsDomain: unknown, createReducer: typeof import('@happier-dev/session-core/reducer').createReducer) {
    storage.setState({
        sessionMessages: {
            s1: {
                messageIdsOldestFirst: [],
                messagesById: {},
                messagesMap: {},
                reducerState: createReducer(),
                latestThinkingMessageId: null,
                latestThinkingMessageActivityAtMs: null,
                messagesVersion: 0,
                isLoaded: true,
            },
        },
    });
    return { get: storage.getState, domain: storage.getState() };
}

describe('sessions domain: no voice side effects', () => {
    it('applies agentState permission requests to loaded session messages when applySessions receives newer agentStateVersion', async () => {
        const { createReducer } = await import("@happier-dev/session-core/reducer");
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, createReducer);

        domain.applySessions([
            {
                id: 's1',
                seq: 0,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: null,
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);

        domain.applySessions([
            {
                id: 's1',
                seq: 0,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: null,
                metadataVersion: 1,
                agentState: {
                    requests: {
                        req1: {
                            tool: 'Bash',
                            arguments: { command: 'ls' },
                            createdAt: 123,
                        },
                    },
                },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any,
        ]);

        const nextState: any = get();
        const mappedMid = nextState.sessionMessages.s1.reducerState.toolIdToMessageId.get('req1');
        expect(mappedMid).toBeTruthy();

        const msg = nextState.sessionMessages.s1.messagesMap[mappedMid];
        expect(msg.kind).toBe('tool-call');
        expect(msg.tool?.name).toBe('Bash');
        expect(msg.tool?.permission?.id).toBe('req1');
        expect(msg.tool?.permission?.status).toBe('pending');
    });

    it('reconciles cached Request interrupted placeholders back to pending on reload even when agentStateVersion is unchanged', async () => {
        mockSessionsDomainBoundaries();

        const { createReducer } = await import("@happier-dev/session-core/reducer");
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, createReducer);

        const reducerState = createReducer();
        reducerState.toolIdToMessageId.set('req1', 'm1');
        reducerState.messages.set('m1', {
            id: 'm1',
            localId: null,
            realID: 'real-m1',
            seq: 1,
            role: 'agent',
            createdAt: 100,
            text: null,
            event: null,
            tool: {
                id: 'req1',
                name: 'AskUserQuestion',
                state: 'error',
                input: { q: 'continue?' },
                createdAt: 100,
                startedAt: null,
                completedAt: 101,
                description: null,
                result: { error: 'Request interrupted' },
                permission: {
                    id: 'req1',
                    status: 'canceled',
                    kind: 'user_action',
                    reason: 'Request interrupted',
                },
            },
        } as any);

        const state: any = get();
        state.sessions.s1 = {
            id: 's1',
            seq: 0,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: { q: 'continue?' },
                        createdAt: 100,
                    },
                },
                completedRequests: null,
            },
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        };
        state.sessionMessages.s1 = {
            messageIdsOldestFirst: ['m1'],
            messagesById: {
                m1: {
                    id: 'm1',
                    kind: 'tool-call',
                    createdAt: 100,
                    localId: null,
                    tool: {
                        id: 'req1',
                        name: 'AskUserQuestion',
                        state: 'error',
                        input: { q: 'continue?' },
                        createdAt: 100,
                        completedAt: 101,
                        result: { error: 'Request interrupted' },
                        permission: {
                            id: 'req1',
                            status: 'canceled',
                            kind: 'user_action',
                            reason: 'Request interrupted',
                        },
                    },
                    children: [],
                },
            },
            messagesMap: {},
            reducerState,
            reducerVersion: 1,
            latestThinkingMessageId: null,
            latestThinkingMessageActivityAtMs: null,
            messagesVersion: 1,
            isLoaded: true,
        };
        state.sessionMessages.s1.messagesMap = state.sessionMessages.s1.messagesById;
        state.sessionListRowsByServerId.server_1 = { s1: {
            id: 's1',
            seq: 0,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            pendingVersion: undefined,
            pendingCount: undefined,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        } };
        state.ordinarySessionListMembershipByServerId.server_1 = ['s1'];

        domain.applySessions([
            {
                id: 's1',
                seq: 0,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: null,
                metadataVersion: 1,
                agentState: {
                    requests: {
                        req1: {
                            tool: 'AskUserQuestion',
                            kind: 'user_action',
                            arguments: { q: 'continue?' },
                            createdAt: 100,
                        },
                    },
                    completedRequests: null,
                },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any,
        ]);

        const nextState: any = get();
        const updatedMessage = nextState.sessionMessages.s1.messagesById.m1;
        expect(updatedMessage.tool?.permission?.status).toBe('pending');
        expect(updatedMessage.tool?.state).toBe('running');
        expect(updatedMessage.tool?.completedAt).toBeNull();
        expect(updatedMessage.tool?.result).toBeUndefined();
        expect(nextState.sessionListRowsByServerId.server_1.s1?.hasPendingPermissionRequests).toBe(false);
        expect(nextState.sessionListRowsByServerId.server_1.s1?.hasPendingUserActionRequests).toBe(true);
    });
});
