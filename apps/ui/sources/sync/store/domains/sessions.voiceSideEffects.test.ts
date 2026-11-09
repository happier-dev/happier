import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readStoredSessionMessages } from '@happier-dev/session-core/messages';
import { activatePendingQueueScope } from '../../engine/pending/pendingQueueV2.testHelpers';

beforeEach(async () => {
    await loadSyncSingletonForTests();
    storage.setState(storage.getInitialState(), true);
    await activatePendingQueueScope({ serverId: 'server_1', accountId: 'account_a' });
    vi.spyOn(Date, 'now').mockReturnValue(200);
});

afterEach(() => {
    storage.setState(storage.getInitialState(), true);
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

function createHarness() {
    storage.setState({
        sessionMessages: {
            s1: createSessionMessagesFixture({ isLoaded: true }),
        },
    });
    return { get: storage.getState, domain: storage.getState() };
}

describe('sessions domain: no voice side effects', () => {
    it('applies agentState permission requests to loaded session messages when applySessions receives newer agentStateVersion', async () => {
        const { get, domain } = createHarness();

        domain.applySessions([
            createSessionFixture({
                id: 's1',
                serverId: 'server_1',
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
                presence: 'online',
            }),
        ]);

        domain.applySessions([
            createSessionFixture({
                id: 's1',
                serverId: 'server_1',
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
                presence: 'online',
            }),
        ]);

        const nextState = get();
        const mappedMid = nextState.sessionMessages.s1.reducerState.toolIdToMessageId.get('req1');
        expect(mappedMid).toBeTruthy();
        if (!mappedMid) throw new Error('Expected a canonical message id for req1');
        expect(nextState.sessionMessages.s1.messageIdsOldestFirst).toEqual([mappedMid]);

        const msg = nextState.sessionMessages.s1.messagesMap[mappedMid];
        expect(msg?.kind).toBe('tool-call');
        if (msg?.kind !== 'tool-call') throw new Error('Expected the pending permission tool call');
        expect(msg.tool?.name).toBe('Bash');
        expect(msg.tool?.permission?.id).toBe('req1');
        expect(msg.tool?.permission?.status).toBe('pending');
    });

    it('reconciles cached Request interrupted placeholders back to pending on reload even when agentStateVersion is unchanged', async () => {
        const { createReducer } = await import("@happier-dev/session-core/reducer");
        const { get, domain } = createHarness();

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
        });

        domain.applySessions([createSessionFixture({
            id: 's1',
            serverId: 'server_1',
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
        })]);
        const state = get();
        state.sessionMessages.s1 = createSessionMessagesFixture({
            messageIdsOldestFirst: ['m1'],
            messagesById: {
                m1: createToolCallMessageFixture({
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
                        startedAt: 100,
                        description: null,
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
                }),
            },
            messagesMap: {},
            reducerState,
            reducerVersion: 1,
            latestThinkingMessageId: null,
            latestThinkingMessageActivityAtMs: null,
            messagesVersion: 1,
            isLoaded: true,
        });
        state.sessionMessages.s1.messagesMap = state.sessionMessages.s1.messagesById;
        state.sessionListRowsByServerId = { ...state.sessionListRowsByServerId, server_1: { s1: createSessionListRenderableSessionFixture({
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
        }) } };
        state.ordinarySessionListMembershipByServerId = { ...state.ordinarySessionListMembershipByServerId, server_1: ['s1'] };

        const previousSessions = state.sessions;
        const previousToolVersion = state.sessionMessageToolVersion;
        domain.applySessions([state.sessions.s1]);

        const nextState = get();
        const updatedMessage = nextState.sessionMessages.s1.messagesById.m1;
        expect(nextState.sessions).toBe(previousSessions);
        expect(updatedMessage?.kind).toBe('tool-call');
        if (updatedMessage?.kind !== 'tool-call') throw new Error('Expected the restored permission tool call');
        expect(updatedMessage.tool?.permission?.status).toBe('pending');
        expect(updatedMessage.tool?.state).toBe('running');
        expect(updatedMessage.tool?.completedAt).toBeNull();
        expect(updatedMessage.tool?.result).toBeUndefined();
        expect(nextState.sessionMessageToolVersion).toBeGreaterThan(previousToolVersion);
        expect(nextState.sessionListRowsByServerId.server_1.s1?.hasPendingPermissionRequests).toBe(false);
        expect(buildSessionListRenderableFromSession(nextState.sessions.s1,
            nextState.sessionListRowsByServerId.server_1.s1,
            readStoredSessionMessages(nextState, 's1') ?? []).hasPendingUserActionRequests).toBe(true);
        expect(nextState.sessionListRowsByServerId.server_1.s1?.hasPendingUserActionRequests).toBe(true);
    });
});
