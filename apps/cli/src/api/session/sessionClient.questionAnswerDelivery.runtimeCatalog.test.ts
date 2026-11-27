import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { FeaturesResponseSchema, type SessionPendingEnqueueByMachineRequestV1, type SessionPendingExecutionRunEnqueueByMachineRequestV2 } from '@happier-dev/protocol';
import type { AgentState } from '@/api/types';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createMockSession, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ApiSessionClient } from './sessionClient';
import { buildPluginSessionInputAdmissionV1 } from '@/session/services/sessionInputAdmissionIdentity';
import { settleSessionInputRequestV1, withSessionInputAuthorityV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

// The Session's portable Home identity, distinct from the transport's local profile id.
const questionHomeIdentity = 'srv_question_home';

// HTTP/Socket.IO, authenticated Machine admission and persisted AgentState are the system boundaries.
vi.mock('axios');
vi.mock('socket.io-client', () => ({ io: () => createApiSessionSocketStub() }));
const clients: ApiSessionClient[] = [];
afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map(client => client.close()));
    vi.restoreAllMocks();
});

describe('Session-owned question answer return', () => {
    it.each(['wait', 'continue'] as const)('delivers a persisted %s completion through the real S3 returned-information owner', async mode => {
        const sessionId = `c${'a'.repeat(24)}`;
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.sig`;
        const home = 'https://question-return-home.test';
        const cause = { requestRef: 'bob-input', requester: { serverId: questionHomeIdentity, accountId: 'bob' },
            persona: { serverId: questionHomeIdentity, sessionId }, origin: { kind: 'session',
                session: { serverId: questionHomeIdentity, sessionId }, messageId: 'bob-message' } };
        const sourceInputId = mode === 'wait' ? 'bob-input' : undefined;
        const originalMessage = { id: 'bob-message', localId: 'bob-input', seq: 7,
            sidechainId: null, createdAt: 1, updatedAt: 1, messageRole: 'user',
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'bob', sessionRelationship: 'sharedEditor' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Bob original' },
                meta: { actionRequestAttributionV1: { ...cause, requester: { serverId: questionHomeIdentity, accountId: 'forged' } } } } },
        };
        const pending: Array<SessionPendingEnqueueByMachineRequestV1 | SessionPendingExecutionRunEnqueueByMachineRequestV2> = [];
        vi.mocked(axios.get).mockImplementation(async url => {
            const path = new URL(String(url));
            if (path.pathname.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId,
                latestTurnId: 'carol-turn', updatedAt: 4, turns: [
                    { turnId: 'turn', status: 'waiting', startedAt: 1, updatedAt: 2,
                        transcriptAnchors: sourceInputId ? { startUserMessageSeq: 1, userMessageSeqs: [1, 7] }
                            : { startUserMessageSeq: 7, userMessageSeqs: [7] } },
                    { turnId: 'carol-turn', status: 'in_progress', startedAt: 3, updatedAt: 4,
                        transcriptAnchors: { startUserMessageSeq: 9, userMessageSeqs: [9] } },
                ] } };
            if (path.pathname.endsWith('/messages/by-local-id/bob-input')) return { status: 200, data: { message: originalMessage } };
            if (path.pathname.endsWith('/messages')) {
                expect(sourceInputId).toBeUndefined();
                expect(path.searchParams.get('afterSeq')).toBe('6');
                expect(path.searchParams.has('beforeSeq')).toBe(false);
                return { status: 200, data: { messages: [originalMessage], hasMore: false } };
            }
            if (String(url).endsWith('/v1/account/encryption/currentness')) return {
                status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }),
            };
            if (/delivery-mutes$/u.test(String(url))) return { status: 200, data: { scopes: [] } };
            if (String(url).includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
                createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: true,
                    metadata: JSON.stringify({ machineId: 'worker-machine', path: '/repo' }) }) } };
            return { status: 404, data: {} };
        });
        const socket = createApiSessionSocketStub();
        const client = new ApiSessionClient(token, createMockSession({ id: sessionId, encryptionMode: 'plain' }), {
            metadataAuthority: { kind: 'owner', credentials: { token, encryption: null } },
            durableMutationDeliveryInitiallyActive: false,
            getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
                capabilities: { serverIdentity: { serverIdentityId: questionHomeIdentity } } }) }),
            machineAdmissionTransport: async request => {
                expect(request.sessionId).toBe(sessionId);
                expect(request.targetMachineId).toBe('worker-machine');
                pending.push(request);
                return { status: 'accepted', localId: request.localId };
            },
            transport: { serverId: 'question-home', serverUrl: home, createSessionSocketTransport: () => ({
                socket: socket as never, transport: createSocketTransportAdapter(socket as never),
            }) },
        });
        clients.push(client);
        let state: AgentState = { requests: {}, completedRequests: {} };
        const store = new AgentStateRequestStore({ target: { scopeId: sessionId,
            readState: () => state, updateState: update => { state = update(state); },
            getResponseTargetDispatcher: () => client.getAgentStateResponseTargetDispatcher(),
        }, logPrefix: '[Question return]' });
        client.bindAgentStateRequestStore(store);
        await store.publishRequestAndWait({ requestId: 'question', toolName: 'custom-question',
            toolInput: { questions: [{ id: 'revision', question: 'Which revision?', selection: 'text' }] },
            kind: 'user_action', createdAt: 1,
            questionV1: { mode, lasting: false, ...(mode === 'continue' ? { assumption: 'Revision 2' } : {}) },
            currentHandler: { kind: 'person' },
            responseTarget: { kind: 'session_question_answer', sessionId, sourceTurnId: 'turn', ...(sourceInputId ? { sourceInputId } : {}) },
        });
        await runWithServerHttpBaseUrl('https://unrelated-home.test', () => store.completeRequest({
            requestId: 'question', status: 'approved', decision: 'approved',
            extraCompletedFields: { structuredAnswersV1: { revision: ['Revision 3, preserving commas'] },
                answeredBy: { kind: 'session', sessionId: 'manager' } },
        }));
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        expect(pending[0]).toMatchObject({ requestedAction: { v: 1, kind: 'enqueue' },
            content: { t: 'plain', v: { content: { text: expect.stringContaining('Revision 3, preserving commas') },
            meta: { happierInputRequestV1: { actionRequestAttributionV1: cause, returnedAnswer: { requestSessionId: sessionId, requestLocalId: 'question',
                outcome: 'answer', delivery: 'wake',
                senderSessionId: 'manager',
                answeredBy: { kind: 'happierSession', sourceSessionId: 'manager' } } } } } } });
        const returnedContent = pending[0]?.content;
        if (returnedContent?.t !== 'plain') throw new Error('Expected the plain Account answer envelope');
        expect(returnedContent.v).toMatchObject({ meta: {
            happierProvenanceV1: { kind: 'host', producer: 'sessionAction' },
        } });
        expect(pending[0]).not.toHaveProperty('reply');
        expect(returnedContent.v).not.toHaveProperty('meta.happierInputRequestV1.replyIntent');
        expect(returnedContent.v).not.toHaveProperty('meta.happierInputRequestV1.sourceSession');
        expect(vi.mocked(axios.get).mock.calls.some(([url]) => String(url).startsWith(`${home}/v2/sessions/${sessionId}`))).toBe(true);
        await vi.waitFor(() => expect(state.completedRequests?.question).not.toHaveProperty('responseTarget'));
    });

    it.each([
        { requester: 'bob', failure: 'receipt' }, { requester: null, failure: 'receipt' },
        { requester: 'bob', failure: 'original-read' },
    ] as const)('rejoins a complete person answer after host loss ($requester, $failure) with the same original cause', async ({ requester, failure }) => {
        const sessionId = `c${'b'.repeat(24)}`;
        const cause = { requestRef: 'original-delegated-input', requester: requester ? { serverId: questionHomeIdentity, accountId: requester } : null,
            persona: { serverId: questionHomeIdentity, sessionId: 'original-bot' }, origin: null };
        const original = buildPluginSessionInputAdmissionV1({ actionRequestAttributionV1: cause,
            caller: { kind: 'plugin', pluginId: 'example.bridge', contributionLocalId: 'messages' }, source: {
                sourceRef: 'original', sourceRevisionOrEpoch: '1', requestedPermissionCeiling: 'read-only', remoteApprovalMaxScope: 'request' } });
        const receipt = { v: 1 as const, issuer: 'authenticatedMachine' as const };
        const authority = settleSessionInputRequestV1({ request: original.request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt });
        const questions = Array.from({ length: 5 }, (_, index) => ({ id: `q${index}`, question: `Question ${index}?`, selection: 'text' }));
        const answers = Object.fromEntries(questions.map(question => [question.id, [`Answer ${question.id}, with punctuation`]]));
        let state: AgentState = { requests: {}, completedRequests: { question: {
            tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions }, createdAt: 1, completedAt: 2,
            status: 'approved', decision: 'approved', questionV1: { mode: 'wait', lasting: false },
            structuredAnswersV1: answers, answeredBy: { kind: 'person', accountId: 'carol-answerer' },
            responseTarget: { kind: 'session_question_answer', sessionId, sourceTurnId: 'old-native-turn' },
        } } };
        const pending: Array<SessionPendingEnqueueByMachineRequestV1 | SessionPendingExecutionRunEnqueueByMachineRequestV2> = [];
        let refuseOriginalRead = failure === 'original-read';
        let refusedOriginalRead = false;
        vi.mocked(axios.get).mockImplementation(async url => {
            const path = new URL(String(url));
            if (path.pathname.endsWith('/turns') && refuseOriginalRead) {
                refuseOriginalRead = false;
                refusedOriginalRead = true;
                return { status: 503, data: {} };
            }
            if (path.pathname.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 2,
                turns: [{ turnId: 'old-native-turn', status: 'waiting', startedAt: 1, updatedAt: 2,
                    transcriptAnchors: { userMessageSeqs: [4] } }] } };
            if (path.pathname.endsWith('/messages')) {
                expect(path.searchParams.get('afterSeq')).toBe('3');
                expect(path.searchParams.has('beforeSeq')).toBe(false);
                return { status: 200, data: { messages: [{ id: 'original-message', localId: 'worker-input', seq: 4,
                    sidechainId: null, createdAt: 1, updatedAt: 1, messageRole: 'user', inputAdmissionReceipt: receipt,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Original' },
                        meta: withSessionInputAuthorityV1({ happierProvenanceV1: original.provenance }, authority) } },
                }], hasMore: false } };
            }
            if (String(url).endsWith('/v1/account/encryption/currentness')) return {
                status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }),
            };
            if (String(url).includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
                createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: true,
                    metadata: JSON.stringify({ machineId: 'worker-machine', path: '/repo' }),
                    agentState: JSON.stringify(state), agentStateVersion: 1 }) } };
            return { status: 404, data: {} };
        });
        const bindRecoveredClient = async (loseReceipt: boolean) => {
            const socket = createApiSessionSocketStub();
            const client = new ApiSessionClient('token', createMockSession({ id: sessionId, encryptionMode: 'plain' }), {
                metadataAuthority: { kind: 'owner', credentials: { token: 'token', encryption: null } },
                durableMutationDeliveryInitiallyActive: false,
                getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
                    capabilities: { serverIdentity: { serverIdentityId: questionHomeIdentity } } }) }),
                machineAdmissionTransport: async request => {
                    pending.push(request);
                    if (loseReceipt) throw new Error('Machine admission receipt lost');
                    return { status: 'accepted', localId: request.localId };
                },
                transport: { serverId: 'question-home', serverUrl: 'https://question-return-home.test',
                    createSessionSocketTransport: () => ({ socket: socket as never,
                        transport: createSocketTransportAdapter(socket as never) }) },
            });
            clients.push(client);
            // Exercise the actual HTTP snapshot opener before rebinding the persisted store view.
            await client.readOpenedSessionStateSnapshot({ agentStateVersion: 0, sharedMetadataVersion: 0 });
            const openedState = client.getAgentStateSnapshot();
            if (!openedState) throw new Error('Expected the persisted CLI request snapshot');
            state = structuredClone(openedState);
            const store = new AgentStateRequestStore({ target: { scopeId: sessionId,
                readState: () => state, updateState: update => { state = update(state); },
                getResponseTargetDispatcher: () => client.getAgentStateResponseTargetDispatcher(),
            }, logPrefix: '[Recovered question return]' });
            client.bindAgentStateRequestStore(store);
            return { client, store };
        };
        const first = await bindRecoveredClient(failure === 'receipt');
        await vi.waitFor(() => failure === 'original-read' ? expect(refusedOriginalRead).toBe(true) : expect(pending).toHaveLength(1));
        await first.client.close();
        if (failure === 'original-read') expect(pending).toHaveLength(0);
        expect(state.completedRequests?.question).toHaveProperty('responseTarget');
        // Only persisted state crosses host loss; no old native waiter survives.
        state = structuredClone(state);
        const recovered = await bindRecoveredClient(false);
        await vi.waitFor(() => expect(state.completedRequests?.question).not.toHaveProperty('responseTarget'));
        expect(pending).toHaveLength(failure === 'original-read' ? 1 : 2);
        if (failure === 'receipt') expect(pending[1]?.localId).toBe(pending[0]?.localId);
        for (const attempt of pending) expect(attempt.content).toMatchObject({ t: 'plain', v: { meta: {
            happierInputRequestV1: { actionRequestAttributionV1: cause },
        } } });
        const content = pending.at(-1)?.content;
        if (content?.t !== 'plain') throw new Error('Expected the plain Account answer envelope');
        expect(content.v).toMatchObject({ content: { text: JSON.stringify({ requestId: 'question',
            question: { questions }, context: { mode: 'wait', lasting: false }, answers }) } });
        expect(content.v).not.toHaveProperty('meta.happierInputRequestV1.returnedAnswer.senderSessionId');
        expect(content.v).toMatchObject({ meta: { happierInputRequestV1: { returnedAnswer: {
            answeredBy: { v: 1, kind: 'happierApp', actor: { kind: 'person', accountId: 'carol-answerer' } },
        } } } });
        expect(content.v).not.toHaveProperty('meta.happierInputRequestV1.sourceSession');
        expect(pending.at(-1)).not.toHaveProperty('reply');
        recovered.store.replayCompletedResponseTargets();
        expect(pending).toHaveLength(failure === 'original-read' ? 1 : 2);
    });
});
