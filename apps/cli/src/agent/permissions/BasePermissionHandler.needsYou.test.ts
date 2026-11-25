import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { listPendingRequests } from '@happier-dev/session-core/pending';
import type { AgentState } from '@/api/types';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { BasePermissionHandler } from './BasePermissionHandler';
import { ServerBoundPermissionRpcHandlerManager } from './testkit/serverBoundPermissionRpcHandlerManager';
import type { QuestionSessionSnapshot } from './sessionQuestionManager';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

class QuestionSession {
    sessionId = 'worker';
    rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
    state: AgentState = { requests: {}, completedRequests: {} };
    yielded: string[] = [];
    waitingTurnId: string | null = null;
    stoppedQuestionTurnIds: string[] = [];
    private readonly archiveEvents = new EventEmitter();
    private archivedAt: number | null = null;
    getArchivedAtSnapshot() { return this.archivedAt; }
    onArchivedAtChange(listener: (archivedAt: number | null) => void) {
        this.archiveEvents.on('archive', listener);
        return () => this.archiveEvents.off('archive', listener);
    }
    publishArchiveSnapshot(archivedAt: number | null) {
        if (this.archivedAt === archivedAt) return;
        this.archivedAt = archivedAt;
        this.archiveEvents.emit('archive', archivedAt);
    }
    wireProtocolVersion: number | undefined = 4;
    getServerFeaturesSnapshot(): CliServerFeaturesSnapshot | undefined {
        return this.wireProtocolVersion === undefined ? undefined : { status: 'ready', features: FeaturesResponseSchema.parse({
            features: {}, capabilities: { accountStoredContentCompatibility: { v: 1,
                minimumProtocolVersion: 2, currentProtocolVersion: this.wireProtocolVersion,
                declarationTransport: 'http-header-and-socket-auth-v1' } },
        }) };
    }
    clearQuestionWaitTurn(turnIds: readonly string[] = []) {
        this.waitingTurnId = null;
        this.stoppedQuestionTurnIds.push(...turnIds);
    }
    getAgentStateSnapshot() { return this.state; }
    getMetadataSnapshot() { return null; }
    updateAgentState(update: (state: AgentState) => AgentState) { this.state = update(this.state); }
    async updateAgentStateRequestSettlement(update: (state: AgentState) => AgentState) { this.updateAgentState(update); }
    async readQuestionSessionSnapshot(sessionId: string): Promise<QuestionSessionSnapshot | null> {
        return { sessionId, accountId: 'account', managerSessionId: sessionId === 'worker' ? 'manager' : null,
            available: true, answersWorkerQuestions: true };
    }
    async yieldQuestionTurn(turnId: string) {
        // Model the runtime boundary only: ending a turn cannot precede persistence.
        expect(Object.values(this.state.requests ?? {}).some(request => request.turnId === turnId)).toBe(true);
        this.yielded.push(turnId);
        this.waitingTurnId = turnId;
        return true;
    }
    async call(input: unknown, context: RpcHandlerContext) {
        const handler = this.rpcHandlerManager.handlers.get('session.needs_you.raise');
        return handler ? await handler(input, context) : { ok: false, errorCode: 'rpc_method_not_found' };
    }
}

class QuestionHandler extends BasePermissionHandler {
    protected getLogPrefix() { return '[Needs you]'; }
    request(id: string) { return this.requestPermissionDecision(id, 'AskUserQuestion', { questions: [{ question: 'Native?' }] }); }
}

const origin: RpcHandlerContext = { signal: new AbortController().signal, sessionActionOrigin: {
    v: 1, caller: { kind: 'session', sessionId: 'worker', starterDepth: 0, turnDepth: 0 },
    sourceTurnId: 'turn', sourceInputId: 'bob-input', callerPermissionMode: 'default', requestId: 'action',
} };
const form = { type: 'decision', questions: [{ id: 'revision', type: 'text', prompt: 'Which revision?' }] };

describe('needs-you at the registered question owner', () => {
    it.each([undefined, 3])('refuses wait before publication on a Home with wire version %s while keeping continue usable', async version => {
        const session = new QuestionSession();
        session.wireProtocolVersion = version;
        new QuestionHandler(session as never);
        expect(await session.call({ ...form, mode: 'wait' }, origin)).toMatchObject({
            ok: false, errorCode: 'question_turn_yield_unavailable',
        });
        expect(session.state.requests).toEqual({});
        expect(session.yielded).toEqual([]);
        expect(await session.call({ ...form, mode: 'continue', assumption: 'Revision 3' }, origin))
            .toMatchObject({ ok: true, mode: 'continue' });
    });
    it('keeps the author reason with the existing durable question', async () => {
        const session = new QuestionSession();
        new QuestionHandler(session as never);
        expect(await session.call({ ...form, mode: 'continue', assumption: 'Revision 3', reason: 'The API versions disagree' }, origin))
            .toMatchObject({ ok: true });
        expect(session.state.requests?.action).toMatchObject({ questionV1: { reason: 'The API versions disagree' } });
    });
    it.each(['native', 'action'] as const)('does not publish a %s question after Stop during initial handler facts', async (path) => {
        let releaseFacts!: (snapshot: QuestionSessionSnapshot | null) => void;
        let factsEntered!: () => void;
        const entered = new Promise<void>(resolve => { factsEntered = resolve; });
        const facts = new Promise<QuestionSessionSnapshot | null>(resolve => { releaseFacts = resolve; });
        class PreparingSession extends QuestionSession {
            override async readQuestionSessionSnapshot() {
                factsEntered();
                return facts;
            }
        }
        const session = new PreparingSession();
        const handler = new QuestionHandler(session as never);
        const pending = path === 'native' ? handler.request('preparing-native')
            : session.call({ ...form, mode: 'continue', assumption: 'Revision 3' }, origin);
        // Attach the rejection observer before Stop can reject the preparation.
        const outcome = pending.then(value => ({ value }), error => ({ error }));
        await entered;
        await handler.abortPendingRequestsAndFlush('Explicit person Stop');
        releaseFacts(null);
        // Drain the released facts without waiting on a wrongly published
        // native waiter, so the missing behavior fails as state, not timeout.
        await new Promise<void>(resolve => setImmediate(resolve));
        const requestsAfterStop = { ...session.state.requests };
        await handler.abortPendingRequestsAndFlush('Test cleanup');
        expect(requestsAfterStop).toEqual({});
        expect(await outcome).toMatchObject({ error: expect.objectContaining({ message: 'Explicit person Stop' }) });
        expect(session.state.completedRequests).toEqual({});
        expect(session.yielded).toEqual([]);
    });

    it.each(['wait', 'continue'] as const)('returns one durable %s request and ends only a wait turn', async (mode) => {
        const session = new QuestionSession();
        new QuestionHandler(session as never);
        const result = await session.call({ ...form, mode, ...(mode === 'continue' ? { assumption: 'Revision 3' } : {}) }, origin);
        expect(result).toMatchObject({ ok: true, mode, requestId: expect.any(String) });
        const entries = Object.entries(session.state.requests ?? {});
        expect(entries).toHaveLength(1);
        expect(entries[0]![1]).toMatchObject({ tool: 'AskUserQuestion', kind: 'user_action',
            questionV1: { mode, lasting: false, type: 'decision' }, currentHandler: { kind: 'session', sessionId: 'manager' },
            responseTarget: { kind: 'session_question_answer', sessionId: 'worker', sourceTurnId: 'turn', sourceInputId: 'bob-input' },
            arguments: { questions: [{ id: 'revision', question: 'Which revision?', selection: 'text' }] } });
        expect(session.yielded).toEqual(mode === 'wait' ? ['turn'] : []);
    });

    it('does not yield a stopped turn when question publication acknowledgement arrives late', async () => {
        let releasePublication!: () => void;
        class PublishingSession extends QuestionSession {
            override updateAgentState(update: (state: AgentState) => AgentState): void | Promise<void> {
                super.updateAgentState(update);
                if (Object.keys(this.state.requests ?? {}).length > 0 && !releasePublication) {
                    return new Promise<void>(resolve => { releasePublication = resolve; });
                }
            }
            override async yieldQuestionTurn(turnId: string) {
                this.yielded.push(turnId);
                return true;
            }
        }
        const session = new PublishingSession();
        const handler = new QuestionHandler(session as never);
        const pending = session.call({ ...form, mode: 'wait' }, origin);
        const outcome = pending.then(value => ({ value }), error => ({ error }));
        await vi.waitFor(() => expect(session.state.requests?.action).toBeDefined());
        await handler.abortPendingRequestsAndFlush('Explicit person Stop');
        releasePublication();
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(await outcome).toMatchObject({ error: expect.objectContaining({ message: 'Explicit person Stop' }) });
        expect(session.state.requests).toEqual({});
        expect(session.state.completedRequests?.action).toMatchObject({ status: 'canceled', reason: 'Explicit person Stop' });
        expect(session.yielded).toEqual([]);
    });

    it.each([false, true])('retains host question-wait intent only for incidental cleanup=%s', async preserveQuestions => {
        const session = new QuestionSession();
        const handler = new QuestionHandler(session as never);
        await session.call({ ...form, mode: 'wait' }, origin);
        expect(session.waitingTurnId).toBe('turn');
        await handler.abortPendingRequestsAndFlush(preserveQuestions ? 'Runtime replaced' : 'Explicit person Stop', { preserveQuestions });
        expect(session.waitingTurnId).toBe(preserveQuestions ? 'turn' : null);
        expect(Boolean(session.state.requests?.action)).toBe(preserveQuestions);
        if (!preserveQuestions) expect(session.state.completedRequests?.action).toMatchObject({
            status: 'canceled', reason: 'Explicit person Stop',
        });
    });

    it('settles the durable waiting turn after runtime rejoin has lost its local yield intent', async () => {
        const session = new QuestionSession();
        const handler = new QuestionHandler(session as never);
        await session.call({ ...form, mode: 'wait' }, origin);
        // Only the host-local intent is lost; the canonical request retains its
        // causal turn through reload, just as the durable request rejoin does.
        session.waitingTurnId = null;
        await handler.abortPendingRequestsAndFlush('Explicit person Stop');
        expect(session.stoppedQuestionTurnIds).toEqual(['turn']);
        expect(session.state.requests).toEqual({});
        expect(session.state.completedRequests?.action).toMatchObject({ status: 'canceled' });
    });

    it('settles both retained waits on Archive and keeps the Inbox clear through replay and Unarchive', async () => {
        const session = new QuestionSession();
        new QuestionHandler(session as never);
        const inbox = () => listPendingRequests({
            sessionId: session.sessionId, active: false, agentState: session.state,
            permissionRelationship: 'owner', actionConfirmations: null, presentationCompletedRequests: null, projected: null,
        });
        for (const turnId of ['first-wait', 'second-wait']) {
            const result = await session.call({ ...form, mode: 'wait' }, { ...origin, sessionActionOrigin: {
                ...origin.sessionActionOrigin!, sourceTurnId: turnId, requestId: turnId,
            } });
            expect(result).toMatchObject({ ok: true, requestId: turnId });
        }
        expect(inbox()).toHaveLength(2);

        session.publishArchiveSnapshot(42);
        await vi.waitFor(() => expect(session.state.requests).toEqual({}));
        for (const requestId of ['first-wait', 'second-wait']) {
            expect(session.state.completedRequests?.[requestId]).toMatchObject({
                status: 'canceled', decision: 'abort', reason: 'Session archived',
            });
        }
        await vi.waitFor(() => expect(session.stoppedQuestionTurnIds).toEqual(['first-wait', 'second-wait']));
        expect(session.waitingTurnId).toBeNull();
        expect(inbox()).toEqual([]);
        const closed = structuredClone(session.state);

        session.publishArchiveSnapshot(42);
        session.publishArchiveSnapshot(null);
        for (const id of ['first-wait', 'second-wait']) {
            const answer = session.rpcHandlerManager.handlers.get('session.user_action.answer');
            expect(await answer?.({ id, approved: true, answers: { revision: ['main'] } }, { signal: origin.signal }))
                .toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
        }
        expect(session.state).toEqual(closed);
        expect(session.stoppedQuestionTurnIds).toEqual(['first-wait', 'second-wait']);
        expect(inbox()).toEqual([]);
    });

    it('archives a Session without a question or waiting Turn', async () => {
        const session = new QuestionSession();
        new QuestionHandler(session as never);
        session.publishArchiveSnapshot(42);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(session.state.requests).toEqual({});
        expect(session.state.completedRequests).toEqual({});
        expect(session.stoppedQuestionTurnIds).toEqual([]);
    });

    it.each(['native', 'authored'] as const)('withdraws an asking agent\'s %s question and retains its reason', async (source) => {
        const session = new QuestionSession();
        const handler = new QuestionHandler(session as never);
        const native = source === 'native' ? handler.request('native').catch(error => error) : null;
        if (source === 'native') {
            await vi.waitFor(() => expect(session.state.requests?.native).toBeDefined());
            expect(session.state.requests?.native?.source).toBeUndefined();
        } else await session.call({ ...form, mode: 'continue', assumption: 'Revision 3' }, origin);
        const requestId = Object.keys(session.state.requests ?? {})[0]!;
        expect(await session.call({ requestId, withdraw: 'Revision settled elsewhere' }, origin)).toMatchObject({ ok: true, requestId, withdrawn: true });
        expect(session.state.requests?.[requestId]).toBeUndefined();
        expect(session.state.completedRequests?.[requestId]).toMatchObject({ status: 'canceled', reason: 'Revision settled elsewhere' });
        if (native) expect(await native).toMatchObject({ message: 'Revision settled elsewhere' });
    });

    it('does not let question withdrawal cancel an approval wrapper', async () => {
        const session = new QuestionSession();
        session.state.requests!.approval = { tool: 'AskUserQuestion', kind: 'permission', source: 'happier_action',
            arguments: {}, createdAt: 1 };
        new QuestionHandler(session as never);
        expect(await session.call({ requestId: 'approval', withdraw: 'Not a question' }, origin))
            .toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
        expect(session.state.requests?.approval).toBeDefined();
        expect(session.state.completedRequests?.approval).toBeUndefined();
    });

    it('refuses another Session author without publishing', async () => {
        const session = new QuestionSession();
        new QuestionHandler(session as never);
        expect(await session.call({ ...form, mode: 'wait' }, { ...origin, sessionActionOrigin: {
            ...origin.sessionActionOrigin!, caller: { kind: 'session', sessionId: 'stranger', starterDepth: 0, turnDepth: 0 },
        } })).toMatchObject({ ok: false, errorCode: 'question_author_forbidden' });
        expect(session.state.requests).toEqual({});
    });
});
