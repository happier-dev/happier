import { describe, expect, it, vi } from 'vitest';
import { NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE } from '@happier-dev/protocol/sessions/permissions/v1';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';

import type { AgentState } from '@/api/types';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { ProviderEnforcedPermissionHandler } from './providerEnforced/handler';
import { ServerBoundPermissionRpcHandlerManager } from './testkit/serverBoundPermissionRpcHandlerManager';
import type { QuestionSessionSnapshot } from './sessionQuestionManager';
import { HAPPIER_ACTION_REQUEST_SOURCE } from './requestKind';
import { AgentStateResponseTargetDispatcher, type AgentStateResponseTargetDispatch } from './agentStateRequestStore';
import { toStructuredQuestionPermissionInput } from './structuredQuestionPermissionInput';

class QuestionSession {
    sessionId = 'worker';
    rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
    agentState: AgentState = { requests: {}, completedRequests: {} };
    dispatcher = new AgentStateResponseTargetDispatcher();
    sessions = new Map<string, QuestionSessionSnapshot>([
        ['worker', { sessionId: 'worker', accountId: 'account-owner', managerSessionId: 'manager', available: true, answersWorkerQuestions: true }],
        ['manager', { sessionId: 'manager', accountId: 'account-owner', managerSessionId: 'lead', available: true, answersWorkerQuestions: true }],
        ['lead', { sessionId: 'lead', accountId: 'account-owner', managerSessionId: null, available: true, answersWorkerQuestions: true }],
    ]);

    getAgentStateSnapshot() { return this.agentState; }
    getMetadataSnapshot() { return null; }
    updateAgentState(updater: (state: AgentState) => AgentState) { this.agentState = updater(this.agentState); }
    async updateAgentStateRequestSettlement(updater: (state: AgentState) => AgentState) { this.updateAgentState(updater); }
    async readQuestionSessionSnapshot(sessionId: string) { return this.sessions.get(sessionId) ?? null; }
    getAgentStateResponseTargetDispatcher() { return this.dispatcher; }
}

function managerContext(callerSessionId = 'manager', accountId = 'account-owner') {
    return {
        signal: new AbortController().signal,
        sessionActionOrigin: {
            v: 1, caller: { kind: 'session', sessionId: callerSessionId, starterDepth: 0, turnDepth: 0 },
            sourceTurnId: 'manager-turn', callerPermissionMode: 'default', requestId: 'manager-action',
        },
        authorization: {
            kind: 'session.permission.respond', sessionId: 'worker',
            actor: { kind: 'accountUser', accountId, relationship: 'owner' },
        },
    } satisfies RpcHandlerContext;
}

function tokenContext(): RpcHandlerContext {
    // Verified RPC ingress is the boundary: digest/signature and grant checks
    // remain the real RpcHandlerManager owner's separate transport contract.
    return {
        signal: new AbortController().signal, callerAuthority: 'account_automation',
        callerInputAuthorization: { v: 1, token: 'verified-bound-token', binding: {
            accountId: 'collaborator', principalId: 'principal', credentialId: 'credential',
            grant: API_TOKEN_FULL_GRANT_V1, serverIdentityId: 'home', machineId: 'machine',
            custodianAccountId: 'account-owner', installationId: 'installation',
            actionId: 'session.user_action.answer', requestId: 'answer-request', requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'session', sessionId: 'worker' },
        } },
    };
}

function prepareQuestion() {
    const session = new QuestionSession();
    session.agentState.requests!.question = {
        tool: 'AskUserQuestion', kind: 'user_action', createdAt: 100,
        arguments: { questions: [{ question: 'Choose?', options: [{ label: 'Yes' }], multiSelect: false, allowCustom: false }, { question: 'Revision?' }] },
        questionV1: { mode: 'wait', lasting: false }, currentHandler: { kind: 'session', sessionId: 'manager' },
    };
    new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Manager question]' });
    const rpc = session.rpcHandlerManager.handlers.get('session.user_action.answer')!;
    return { session, rpc };
}

const answer = { id: 'question', approved: true, answers: { 'Choose?': ['Yes'], 'Revision?': ['3'] } };

describe('manager answers at the registered question RPC owner', () => {
    it('attributes a present person to the authenticated answering Account, not the worker or manager owner', async () => {
        const { session, rpc } = prepareQuestion();
        const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
            authorization: { kind: 'session.permission.respond', sessionId: 'worker',
                actor: { kind: 'accountUser', accountId: 'bob', relationship: 'sharedApprover' } } };
        for (const answeredBy of [{ kind: 'person', accountId: 'eve' }, { kind: 'session', sessionId: 'forged' }]) {
            expect(await rpc({ ...answer, answeredBy }, context)).toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
            expect(session.agentState.completedRequests!.question).toBeUndefined();
        }
        await expect(rpc(answer, context)).resolves.toBeUndefined();
        expect(session.agentState.completedRequests!.question).toMatchObject({
            answeredBy: { kind: 'person', accountId: 'bob' }, structuredAnswersV1: answer.answers,
        });
    });
    it('never takes the answering actor or requester from authored answer fields', async () => {
        const managed = prepareQuestion();
        const forged = { ...answer, answeredBy: { kind: 'session', sessionId: 'forged' },
            actionRequestAttributionV1: { requester: { accountId: 'forged-person' } } };
        expect(await managed.rpc(forged, managerContext())).toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
        expect(managed.session.agentState.completedRequests!.question).toBeUndefined();
        await expect(managed.rpc(answer, managerContext())).resolves.toBeUndefined();
        expect(managed.session.agentState.completedRequests!.question)
            .toMatchObject({ answeredBy: { kind: 'session', sessionId: 'manager' } });
        expect(managed.session.agentState.completedRequests!.question).not.toHaveProperty('actionRequestAttributionV1');
        const personal = prepareQuestion();
        expect(await personal.rpc(forged)).toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
        expect(personal.session.agentState.completedRequests!.question).toBeUndefined();
        await expect(personal.rpc(answer)).resolves.toBeUndefined();
        expect(personal.session.agentState.completedRequests!.question).not.toHaveProperty('answeredBy');
        expect(personal.session.agentState.completedRequests!.question).not.toHaveProperty('actionRequestAttributionV1');
    });
    it.each([
        'approval', 'lasting', 'other-worker-account', 'other-manager-account', 'other-actor-account', 'toggle-off',
        'sibling', 'self', 'detached', 'wrong-handler', 'person-handler', 'missing-actor',
        'deny', 'abort', 'missing-answer', 'session-grant', 'approval-like-user-action',
        'native-approval-question', 'action-confirmation-question', 'explicit-permission-kind',
        'facts-unavailable', 'facts-error',
    ])('refuses %s without completing or transferring the request', async (reason) => {
        const { session, rpc } = prepareQuestion();
        const request = session.agentState.requests!.question!;
        let context: RpcHandlerContext = managerContext();
        if (reason === 'approval') Object.assign(request, { tool: 'Bash', kind: 'permission', arguments: { command: 'echo hi' } });
        if (reason === 'lasting') Object.assign(request, { questionV1: { mode: 'wait', lasting: true } });
        if (reason === 'other-worker-account') session.sessions.set('worker', { ...session.sessions.get('worker')!, accountId: 'other-account' });
        if (reason === 'other-manager-account') session.sessions.set('manager', { ...session.sessions.get('manager')!, accountId: 'other-account' });
        if (reason === 'other-actor-account') context = managerContext('manager', 'other-account');
        if (reason === 'toggle-off') session.sessions.set('manager', { ...session.sessions.get('manager')!, answersWorkerQuestions: false });
        if (reason === 'sibling') context = managerContext('sibling');
        if (reason === 'self') context = managerContext('worker');
        if (reason === 'detached') session.sessions.set('worker', { ...session.sessions.get('worker')!, managerSessionId: null });
        if (reason === 'wrong-handler') Object.assign(request, { currentHandler: { kind: 'session', sessionId: 'lead' } });
        if (reason === 'person-handler') Object.assign(request, { currentHandler: { kind: 'person' } });
        if (reason === 'missing-actor') context = { ...context, authorization: undefined };
        if (reason === 'approval-like-user-action') Object.assign(request, { tool: 'ExitPlanMode', arguments: {} });
        if (reason === 'native-approval-question') request.source = NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE;
        if (reason === 'action-confirmation-question') request.source = HAPPIER_ACTION_REQUEST_SOURCE;
        if (reason === 'explicit-permission-kind') request.kind = 'permission';
        if (reason === 'facts-unavailable') session.sessions.delete('worker');
        if (reason === 'facts-error') session.readQuestionSessionSnapshot = async () => { throw new Error('Session facts unavailable'); };
        const response = reason === 'deny' ? { id: 'question', approved: false, decision: 'denied' }
            : reason === 'abort' ? { id: 'question', approved: false, decision: 'abort' }
            : reason === 'missing-answer' ? { id: 'question', approved: true }
            : reason === 'session-grant' ? { ...answer, decision: 'approved_for_session' }
            : answer;
        await expect(rpc(response, context)).resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
        if (!['deny', 'abort', 'missing-answer', 'session-grant'].includes(reason)) {
            await expect(rpc({ id: 'question', disposition: 'pass_up' }, context))
                .resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
        }
        expect(session.agentState.requests!.question).toBeDefined();
        expect(session.agentState.completedRequests!.question).toBeUndefined();
    });

    it('accepts omission of an optional authored question through the real form projection', async () => {
        const { session, rpc } = prepareQuestion();
        session.agentState.requests!.question!.arguments = toStructuredQuestionPermissionInput({ questions: [
            { id: 'required', type: 'text', prompt: 'Required?', required: true },
            { id: 'optional', type: 'text', prompt: 'Optional?', required: false },
        ] });
        await expect(rpc({ id: 'question', approved: true, answers: { required: ['Answer'] } }, managerContext()))
            .resolves.toBeUndefined();
        expect(session.agentState.completedRequests!.question).toMatchObject({
            answeredBy: { kind: 'session', sessionId: 'manager' }, structuredAnswersV1: { required: ['Answer'] },
        });
    });

    it('accepts an empty answer when every authored question is optional', async () => {
        const { session, rpc } = prepareQuestion();
        session.agentState.requests!.question!.arguments = toStructuredQuestionPermissionInput({ questions: [
            { id: 'optional', type: 'text', prompt: 'Optional?', required: false },
        ] });
        await expect(rpc({ id: 'question', approved: true, answers: {} }, managerContext())).resolves.toBeUndefined();
        expect(session.agentState.completedRequests!.question).toMatchObject({
            answeredBy: { kind: 'session', sessionId: 'manager' }, structuredAnswersV1: {},
        });
    });

    it('answers as the current eligible manager and retains every structured answer with Session attribution', async () => {
        const { session, rpc } = prepareQuestion();
        const deliveries: AgentStateResponseTargetDispatch[] = [];
        session.agentState.requests!.question!.responseTarget = { kind: 'test-question-return' };
        // The callback is the outgoing answer-delivery boundary; the request
        // coordinator, state writer and response-target dispatcher stay real.
        session.dispatcher.register('test-question-return', (dispatch) => { deliveries.push(dispatch); });
        await expect(rpc(answer, managerContext())).resolves.toBeUndefined();
        expect(session.agentState.requests!.question).toBeUndefined();
        expect(session.agentState.completedRequests!.question).toMatchObject({
            status: 'approved', answeredBy: { kind: 'session', sessionId: 'manager' },
            structuredAnswersV1: { 'Choose?': ['Yes'], 'Revision?': ['3'] },
        });
        expect(deliveries).toEqual([expect.objectContaining({ requestId: 'question', completedRequest: expect.objectContaining({
            answeredBy: { kind: 'session', sessionId: 'manager' }, structuredAnswersV1: answer.answers,
        }) })]);
        await rpc(answer, managerContext());
        expect(deliveries).toHaveLength(1);
    });

    it('does not answer a replacement occurrence while manager facts are being read', async () => {
        const { session, rpc } = prepareQuestion();
        const read = session.readQuestionSessionSnapshot.bind(session);
        let release!: () => void;
        const paused = new Promise<void>((resolve) => { release = resolve; });
        let reached!: () => void;
        const reading = new Promise<void>((resolve) => { reached = resolve; });
        session.readQuestionSessionSnapshot = async (id) => {
            reached();
            await paused;
            return read(id);
        };
        const result = rpc(answer, managerContext());
        await reading;
        session.agentState.requests!.question = { ...session.agentState.requests!.question!, createdAt: 200 };
        release();
        await expect(result).resolves.toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
        expect(session.agentState.requests!.question).toMatchObject({ createdAt: 200 });
        expect(session.agentState.completedRequests).toEqual({});
    });

    it('does not complete a manager answer after the current handler changes during settlement', async () => {
        const { session, rpc } = prepareQuestion();
        let release!: () => void;
        const paused = new Promise<void>((resolve) => { release = resolve; });
        let reached!: () => void;
        const writing = new Promise<void>((resolve) => { reached = resolve; });
        const update = session.updateAgentState.bind(session);
        session.updateAgentState = async (updater) => {
            reached();
            await paused;
            update(updater);
        };
        const result = rpc(answer, managerContext());
        await writing;
        session.agentState.requests!.question = {
            ...session.agentState.requests!.question!, currentHandler: { kind: 'session', sessionId: 'lead' },
        };
        release();
        await expect(result).resolves.toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
        expect(session.agentState.requests!.question).toMatchObject({ currentHandler: { kind: 'session', sessionId: 'lead' } });
        expect(session.agentState.completedRequests).toEqual({});
    });

    it.each(['session.user_action.answer', 'permission', 'session.structuredQuestion.respond.v1'])(
        'attributes the authenticated person at %s while a manager handles the question', async method => {
        const { session } = prepareQuestion();
        const deliveries: AgentStateResponseTargetDispatch[] = [];
        session.agentState.requests!.question!.responseTarget = { kind: 'test-question-return' };
        session.dispatcher.register('test-question-return', dispatch => { deliveries.push(dispatch); });
        const rpc = session.rpcHandlerManager.handlers.get(method)!;
        const context = { ...managerContext(), sessionActionOrigin: undefined, callerAuthority: 'present_user' as const };
        await expect(rpc(method === 'session.structuredQuestion.respond.v1'
            ? { id: 'question', structuredAnswersV1: answer.answers } : answer, context)).resolves.toBeUndefined();
        expect(session.agentState.requests!.question).toBeUndefined();
        expect(session.agentState.completedRequests!.question).toMatchObject({ status: 'approved',
            answeredBy: { kind: 'person', accountId: context.authorization!.actor.accountId }, permissionDecisionActorV1: context.authorization!.actor });
        expect(deliveries).toEqual([expect.objectContaining({ completedRequest: expect.objectContaining({
            answeredBy: { kind: 'person', accountId: context.authorization!.actor.accountId }, structuredAnswersV1: answer.answers,
        }) })]);
        const { AgentStateSchema } = await import('@happier-dev/session-core/state');
        const { createReducer, runAgentStatePermissionsPhase } = await import('@happier-dev/session-core/reducer');
        const state = createReducer();
        runAgentStatePermissionsPhase({ state, agentState: AgentStateSchema.parse(session.agentState),
            incomingToolIds: new Set(), mainHistoryStartLoaded: true, changed: new Set(),
            allocateId: () => 'question-message', enableLogging: false });
        expect(state.messages.get('question-message')?.tool?.permission).toMatchObject({
            id: 'question', status: 'approved', answeredBy: { kind: 'person' },
        });
    });

    it('refuses an automation principal when its validated Session origin is missing', async () => {
        const { session, rpc } = prepareQuestion();
        await expect(rpc(answer, { ...managerContext(), sessionActionOrigin: undefined, callerAuthority: 'account_automation' }))
            .resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
        expect(session.agentState.requests!.question).toBeDefined();
        expect(session.agentState.completedRequests).toEqual({});
    });

    it('keeps legacy question replies behind the same manager authorization owner', async () => {
        const { session } = prepareQuestion();
        const legacy = session.rpcHandlerManager.handlers.get('permission')!;
        await expect(legacy(answer, managerContext('sibling')))
            .resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
        expect(session.agentState.requests!.question).toBeDefined();
        await expect(legacy({ ...answer, answers: { 'Choose?': 'Yes', 'Revision?': '3' } }))
            .resolves.toBeUndefined();
        expect(session.agentState.completedRequests!.question).toMatchObject({ structuredAnswersV1: answer.answers });
    });

    it('preserves verified token conversational answers without granting Session-manager authority', async () => {
        const { session, rpc } = prepareQuestion();
        await expect(rpc(answer, { ...tokenContext(), ...managerContext('sibling') }))
            .resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
        await expect(rpc(answer, tokenContext())).resolves.toBeUndefined();
        expect(session.agentState.completedRequests!.question).toMatchObject({ structuredAnswersV1: answer.answers });
        expect(session.agentState.completedRequests!.question).not.toHaveProperty('answeredBy');
    });

    it('does not apply a verified token answer to a replacement during the durable write', async () => {
        const { session, rpc } = prepareQuestion();
        let release!: () => void;
        const paused = new Promise<void>((resolve) => { release = resolve; });
        let reached!: () => void;
        const writing = new Promise<void>((resolve) => { reached = resolve; });
        const update = session.updateAgentState.bind(session);
        session.updateAgentState = async (updater) => {
            reached();
            await paused;
            update(updater);
        };
        const result = rpc(answer, tokenContext());
        await writing;
        session.agentState.requests!.question = { ...session.agentState.requests!.question!, createdAt: 200 };
        release();
        await expect(result).resolves.toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
        expect(session.agentState.requests!.question).toMatchObject({ createdAt: 200 });
        expect(session.agentState.completedRequests).toEqual({});
    });

    it.each(['wrong-action', 'wrong-target', 'lasting', 'native-approval', 'action-confirmation'])(
        'does not treat a conversational token as present-person authority: %s', async (reason) => {
            const { session, rpc } = prepareQuestion();
            const context = tokenContext();
            const proof = context.callerInputAuthorization!;
            const boundContext = reason === 'wrong-action'
                ? { ...context, callerInputAuthorization: { ...proof, binding: { ...proof.binding, actionId: 'session.message.send' } } }
                : reason === 'wrong-target'
                    ? { ...context, callerInputAuthorization: { ...proof, binding: { ...proof.binding, target: { kind: 'session' as const, sessionId: 'other' } } } }
                    : context;
            if (reason === 'lasting') session.agentState.requests!.question!.questionV1 = { mode: 'wait', lasting: true };
            if (reason === 'native-approval') session.agentState.requests!.question!.source = NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE;
            if (reason === 'action-confirmation') session.agentState.requests!.question!.source = HAPPIER_ACTION_REQUEST_SOURCE;
            await expect(rpc(answer, boundContext)).resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
            expect(session.agentState.requests!.question).toBeDefined();
            expect(session.agentState.completedRequests).toEqual({});
        },
    );

    it.each([
        { decision: 'approved_for_session' },
        { allowedTools: ['AskUserQuestion'] },
        { updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] },
        { decision: 'approved_execpolicy_amendment', execPolicyAmendment: { command: ['echo', 'hi'] } },
    ])('does not apply native approval side effects from a conversational token: %j', async (sideEffects) => {
        const { session, rpc } = prepareQuestion();
        expect(await rpc({ ...answer, ...sideEffects }, tokenContext()))
            .toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
        expect(session.agentState.requests!.question).toBeDefined();
        expect(session.agentState.completedRequests).toEqual({});
    });

    it('publishes and serves the predecessor lossless structured-question codec through the same answer owner', async () => {
        const { session } = prepareQuestion();
        expect(session.agentState.capabilities).toMatchObject({ structuredQuestionAnswersV1Supported: true });
        const legacy = session.rpcHandlerManager.handlers.get('session.structuredQuestion.respond.v1');
        expect(legacy).toBeDefined();
        if (!legacy) return;
        expect(await legacy({ id: 'question', structuredAnswersV1: answer.answers, approved: true }))
            .toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
        await expect(legacy({ id: 'question', structuredAnswersV1: answer.answers }, managerContext('sibling')))
            .resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
        await expect(legacy({ id: 'question', structuredAnswersV1: answer.answers })).resolves.toBeUndefined();
        expect(session.agentState.completedRequests!.question).toMatchObject({ structuredAnswersV1: answer.answers });
    });

    it('returns an orphaned native question answer through the existing generic response target', async () => {
        const { session, rpc } = prepareQuestion();
        delete session.agentState.requests!.question!.questionV1;
        delete session.agentState.requests!.question!.currentHandler;
        const deliveries: AgentStateResponseTargetDispatch[] = [];
        session.dispatcher.register('session_question_answer', (dispatch) => { deliveries.push(dispatch); });
        await expect(rpc(answer)).resolves.toBeUndefined();
        expect(deliveries).toEqual([expect.objectContaining({
            requestId: 'question', responseTarget: { kind: 'session_question_answer', sessionId: 'worker' },
            completedRequest: expect.objectContaining({ structuredAnswersV1: answer.answers,
                questionV1: { mode: 'wait', lasting: false, type: 'decision' } }),
        })]);
    });

    it('keeps a live native question answer on its original in-turn waiter without a generic return', async () => {
        const session = new QuestionSession();
        const deliveries: AgentStateResponseTargetDispatch[] = [];
        session.dispatcher.register('session_question_answer', (dispatch) => { deliveries.push(dispatch); });
        const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Live question]' });
        const pending = handler.handleToolCall('live-question', 'AskUserQuestion', {
            questions: [{ question: 'Choose?', options: [{ label: 'Yes' }], multiSelect: false }],
        });
        await vi.waitFor(() => expect(session.agentState.requests!['live-question']).toBeDefined());
        const rpc = session.rpcHandlerManager.handlers.get('session.user_action.answer')!;
        await expect(rpc({ id: 'live-question', approved: true, answers: { 'Choose?': ['Yes'] } })).resolves.toBeUndefined();
        await expect(pending).resolves.toMatchObject({ decision: 'approved', answers: { 'Choose?': ['Yes'] } });
        expect(deliveries).toEqual([]);
        expect(session.agentState.completedRequests!['live-question']).not.toHaveProperty('responseTarget');
    });

    it.each([true, false])('selects the handler once for a native question with manager availability %s', async (available) => {
        const session = new QuestionSession();
        session.sessions.set('manager', { ...session.sessions.get('manager')!, available });
        const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Native manager question]' });
        const pending = handler.handleToolCall('native-question', 'AskUserQuestion', {
            questions: [{ question: 'Choose?', options: [{ label: 'Yes' }], multiSelect: false }],
        });
        await vi.waitFor(() => expect(session.agentState.requests!['native-question']).toBeDefined());
        const currentHandler = available ? { kind: 'session', sessionId: 'manager' } : { kind: 'person' };
        expect(session.agentState.requests!['native-question']).toMatchObject({ currentHandler });
        // Later presence changes affect presentation, not the admitted handler.
        session.sessions.set('manager', { ...session.sessions.get('manager')!, available: !available });
        const rpc = session.rpcHandlerManager.handlers.get('session.user_action.answer')!;
        const response = { id: 'native-question', approved: true, answers: { 'Choose?': ['Yes'] } };
        if (!available) {
            await expect(rpc(response, managerContext())).resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
        }
        await expect(rpc(response, available ? managerContext() : undefined)).resolves.toBeUndefined();
        await expect(pending).resolves.toMatchObject({ decision: 'approved', answers: response.answers });
        if (available) expect(session.agentState.completedRequests!['native-question'])
            .toMatchObject({ answeredBy: { kind: 'session', sessionId: 'manager' } });
    });

    it('rejoins a persisted native question without replacing its passed-up handler', async () => {
        const session = new QuestionSession();
        session.agentState.requests!.question = {
            tool: 'AskUserQuestion', kind: 'user_action', createdAt: 100,
            arguments: { questions: [{ question: 'Choose?', options: [{ label: 'Yes' }], multiSelect: false }] },
            questionV1: { mode: 'wait', lasting: false }, currentHandler: { kind: 'session', sessionId: 'lead' },
        };
        const handler = new ProviderEnforcedPermissionHandler(session as never, { logPrefix: '[Rejoined manager question]' });
        const pending = handler.handleToolCall('question', 'AskUserQuestion', session.agentState.requests!.question.arguments);
        await vi.waitFor(() => expect(session.agentState.requests!.question)
            .toMatchObject({ createdAt: 100, currentHandler: { kind: 'session', sessionId: 'lead' } }));
        const rpc = session.rpcHandlerManager.handlers.get('session.user_action.answer')!;
        const response = { id: 'question', approved: true, answers: { 'Choose?': ['Yes'] } };
        await expect(rpc(response, managerContext())).resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
        await expect(rpc(response, managerContext('lead'))).resolves.toBeUndefined();
        await expect(pending).resolves.toMatchObject({ decision: 'approved', answers: response.answers });
        expect(session.agentState.completedRequests!.question).toMatchObject({ answeredBy: { kind: 'session', sessionId: 'lead' } });
    });

    it.each([
        { 'Choose?': ['Yes'] },
        { ...answer.answers, 'Unknown?': ['No'] },
        { ...answer.answers, 'Choose?': ['Unknown'] },
        { ...answer.answers, 'Revision?': ['3', '4'] },
    ])('keeps an incompletely or incorrectly answered form open: %j', async (answers) => {
        const { session, rpc } = prepareQuestion();
        await expect(rpc({ ...answer, answers }, managerContext()))
            .resolves.toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
        expect(session.agentState.requests!.question).toBeDefined();
        expect(session.agentState.completedRequests!.question).toBeUndefined();
    });

    it('does not let a person invocation impersonate a manager pass-up', async () => {
        const { session, rpc } = prepareQuestion();
        await expect(rpc({ id: 'question', disposition: 'pass_up' }))
            .resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
        expect(session.agentState.requests!.question).toMatchObject({ currentHandler: { kind: 'session', sessionId: 'manager' } });
        expect(session.agentState.completedRequests).toEqual({});
    });

    // The pass-up chain is exercised through actual ancestor intake in
    // sessionFollowStalled.sqlite.composed.integration.spec.ts. Directly
    // invoking the next manager here used to hide missing offer delivery.
});
