import { buildRunScopedExecutionPermissionRequestId } from '@happier-dev/protocol/execution/runs/runPrimitives';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentState } from '@/api/types';
import { AgentStateRequestStore, type PermissionResponseClaim } from './agentStateRequestStore';
import { createPermissionRequestCoordinator } from './permissionRequestCoordinator';

class FakeSession {
    sessionId = 'session-test';
    canceledCompletionWriteCount = 0;
    agentStateWriteCount = 0;
    agentState: AgentState = {
        requests: Object.create(null),
        completedRequests: Object.create(null),
    };

    async updateAgentStateRequestSettlement(updater: (state: AgentState) => AgentState): Promise<void> {
        await this.updateAgentState(updater);
    }

    getAgentStateSnapshot() {
        return this.agentState;
    }

    updateAgentState(updater: (state: AgentState) => AgentState): void | Promise<void> {
        this.agentStateWriteCount += 1;
        const previousCompleted = this.agentState.completedRequests ?? {};
        const nextState = updater(this.agentState);
        for (const [requestId, completed] of Object.entries(nextState.completedRequests ?? {})) {
            if (completed?.status === 'canceled' && previousCompleted[requestId]?.status !== 'canceled') {
                this.canceledCompletionWriteCount += 1;
            }
        }
        this.agentState = nextState;
    }
}

class DeferredUpdateSession extends FakeSession {
    private deferNext = false;
    private applyDeferredUpdate: (() => void) | null = null;
    private rejectDeferredUpdate: ((error: Error) => void) | null = null;

    deferNextUpdate(): void {
        this.deferNext = true;
    }

    hasDeferredUpdate(): boolean {
        return this.applyDeferredUpdate !== null;
    }

    resolveDeferredUpdate(): void {
        const apply = this.applyDeferredUpdate;
        this.applyDeferredUpdate = null;
        this.rejectDeferredUpdate = null;
        apply?.();
    }

    failDeferredUpdate(): void {
        const reject = this.rejectDeferredUpdate;
        this.applyDeferredUpdate = null;
        this.rejectDeferredUpdate = null;
        reject?.(new Error('agent state persistence failed'));
    }

    override updateAgentState(updater: (state: AgentState) => AgentState): void | Promise<void> {
        if (!this.deferNext) {
            super.updateAgentState(updater);
            return;
        }

        this.deferNext = false;
        return new Promise<void>((resolve, reject) => {
            this.applyDeferredUpdate = () => {
                this.agentState = updater(this.agentState);
                resolve();
            };
            this.rejectDeferredUpdate = reject;
        });
    }
}

class RejectingUpdateSession extends FakeSession {
    private rejectNext = false;

    rejectNextUpdate(): void {
        this.rejectNext = true;
    }

    override updateAgentState(updater: (state: AgentState) => AgentState): void | Promise<void> {
        if (this.rejectNext) {
            this.rejectNext = false;
            this.agentStateWriteCount += 1;
            return Promise.reject(new Error('agent state persistence failed'));
        }
        return super.updateAgentState(updater);
    }
}

type TestPermissionResult = Readonly<{ decision: string; answers?: Readonly<Record<string, string | readonly string[]>> }>;

function createHarness(session: FakeSession = new FakeSession()) {
    const store = new AgentStateRequestStore({
        session,
        logPrefix: '[CoordinatorTest]',
    });
    const coordinator = createPermissionRequestCoordinator<TestPermissionResult>({
        store,
    });
    return { coordinator, session, store };
}

const bashRequest = {
    requestId: 'toolu_test',
    toolName: 'Bash',
    toolInput: { command: ['bash', '-lc', 'echo hi'] },
    createdAt: 100,
};

it('settles a host tool-policy denial before publishing a permission prompt', async () => {
    const session = new FakeSession();
    const store = new AgentStateRequestStore({ session, logPrefix: '[CoordinatorTest]' });
    const coordinator = createPermissionRequestCoordinator<TestPermissionResult>({
        store,
        resolveAutomaticDecision: () => ({
            result: { decision: 'denied' },
            completedRequest: { status: 'denied', decision: 'denied' },
        }),
    });
    const decision = coordinator.requestDecision(bashRequest);
    expect(session.agentState.requests).toEqual({});
    await expect(decision).resolves.toEqual({ decision: 'denied' });
    expect(session.agentState.completedRequests?.[bashRequest.requestId]).toMatchObject({ status: 'denied' });
});

function approve(requestId = bashRequest.requestId): TestPermissionResult {
    return { decision: `approved:${requestId}` };
}

async function settledState<T>(promise: Promise<T>): Promise<'pending' | 'fulfilled' | 'rejected'> {
    return Promise.race([
        promise.then(
            () => 'fulfilled' as const,
            () => 'rejected' as const,
        ),
        Promise.resolve('pending' as const),
    ]);
}

describe('PermissionRequestCoordinator', () => {
    it('retires stored-only turn approvals on incidental turn end while retaining questions and other turns', async () => {
        const { coordinator, session, store } = createHarness();
        const owner = { kind: 'plugin' as const, pluginId: 'plugin-a' };
        store.publishRequest({ ...bashRequest, requestId: 'retiring-approval', turnId: 'turn-1', owner });
        store.publishRequest({ ...bashRequest, requestId: 'other-turn', turnId: 'turn-2', owner });
        store.publishRequest({ ...bashRequest, requestId: 'other-plugin', turnId: 'turn-1',
            owner: { kind: 'plugin', pluginId: 'plugin-b' } });
        store.publishRequest({ requestId: 'retained-question', toolName: 'AskUserQuestion', toolInput: {},
            createdAt: 1, turnId: 'turn-1', owner });
        const occurrence = coordinator.requestDecision({ ...bashRequest, requestId: 'retained-occurrence',
            turnId: 'turn-1', lifetime: 'occurrence', owner }).catch(() => null);
        coordinator.cancelRequest('retained-occurrence', 'Transport detached');
        await occurrence;
        await coordinator.cancelByPluginTurn('plugin-a', 'turn-1', 'agent_turn-completed');
        expect(Object.keys(session.agentState.requests ?? {}).sort())
            .toEqual(['other-plugin', 'other-turn', 'retained-occurrence', 'retained-question']);
        expect(session.agentState.completedRequests?.['retiring-approval'])
            .toMatchObject({ status: 'canceled', reason: 'agent_turn-completed' });
    });

    it.each(['dispose', 'reset', 'plugin', 'turn', 'signal'] as const)(
        'retains durable questions through %s and occurrence questions only while their occurrence remains live', async (lifecycle) => {
            const { coordinator, session, store } = createHarness();
            const owner = { kind: 'plugin' as const, pluginId: 'plugin-a' };
            const question = { requestId: 'native-question', toolName: 'AskUserQuestion',
                toolInput: { questions: [{ question: 'Which branch?' }] }, createdAt: 1, turnId: 'turn-1', owner };
            const asynchronous = { ...question, requestId: 'occurrence-question', lifetime: 'occurrence' as const };
            const approval = { ...bashRequest, requestId: 'approval', turnId: 'turn-1', owner };
            const abort = new AbortController();
            const nativeWait = coordinator.requestDecision(question, { signal: abort.signal }).catch(() => null);
            const asyncWait = coordinator.requestDecision(asynchronous, { signal: abort.signal }).catch(() => null);
            const approvalWait = coordinator.requestDecision(approval, { signal: abort.signal }).catch(() => null);
            const planApprovalWait = coordinator.requestDecision({ ...approval, requestId: 'plan-approval', toolName: 'ExitPlanMode' },
                { signal: abort.signal }).catch(() => null);
            const questionNamedApprovalWait = coordinator.requestDecision({ ...approval, requestId: 'question-named-approval',
                toolName: 'AskUserQuestion', kind: 'permission', source: 'happier_action' },
                { signal: abort.signal }).catch(() => null);
            store.publishRequest({ ...question, requestId: 'stored-only-question' });
            store.publishRequest({ ...asynchronous, requestId: 'stored-only-occurrence-question' });
            if (lifecycle === 'dispose') await coordinator.dispose();
            if (lifecycle === 'reset') await coordinator.reset();
            if (lifecycle === 'plugin') await coordinator.cancelByPlugin('plugin-a', 'agent_runtime_replaced');
            if (lifecycle === 'turn') await coordinator.cancelByPluginTurn('plugin-a', 'turn-1', 'turn ended');
            if (lifecycle === 'signal') {
                abort.abort();
                await Promise.all([nativeWait, asyncWait, approvalWait, planApprovalWait, questionNamedApprovalWait]);
            }
            if (lifecycle === 'turn') expect(coordinator.getResponseContext(asynchronous.requestId))
                .toMatchObject({ status: 'live', correlation: 'record' });
            expect(Object.keys(session.agentState.requests ?? {}).sort())
                .toEqual(['native-question', 'stored-only-question',
                    ...(lifecycle === 'turn' ? ['occurrence-question'] : []),
                    ...(lifecycle === 'turn' || lifecycle === 'signal' ? ['stored-only-occurrence-question'] : []),
                ].sort());
            expect(session.agentState.completedRequests?.approval).toMatchObject({ status: 'canceled' });
            expect(session.agentState.completedRequests?.['plan-approval']).toMatchObject({ status: 'canceled' });
            expect(session.agentState.completedRequests?.['question-named-approval']).toMatchObject({ status: 'canceled' });
            await Promise.all([nativeWait, ...(lifecycle === 'turn' ? [] : [asyncWait]), approvalWait, planApprovalWait, questionNamedApprovalWait]);
            if (lifecycle === 'turn') expect(await settledState(asyncWait)).toBe('pending');
            expect(coordinator.getResponseContext(question.requestId)).toMatchObject({ requestId: question.requestId });
            const reloaded = lifecycle === 'signal' || lifecycle === 'turn' ? coordinator : createPermissionRequestCoordinator<TestPermissionResult>({ store });
            const rejoined = lifecycle === 'signal' || lifecycle === 'turn' ? null : reloaded.requestDecision(question);
            expect(await reloaded.handleResponse({ requestId: question.requestId, buildCompletion: () => ({
                result: { decision: 'approved', answers: { 'Which branch?': 'main' } },
                completedRequest: { status: 'approved', decision: 'approved' },
            }) })).toBe(true);
            if (rejoined) await expect(rejoined).resolves.toMatchObject({ answers: { 'Which branch?': 'main' } });
            else expect(session.agentState.completedRequests?.[question.requestId]).toMatchObject({ status: 'approved' });
            await reloaded.cancelAll('Explicit person Stop');
            await asyncWait;
            expect(session.agentState.requests).toEqual({});
            expect(session.agentState.completedRequests?.['occurrence-question'])
                .toMatchObject({ status: 'canceled', ...(lifecycle === 'turn' ? { reason: 'Explicit person Stop' } : {}) });
        },
    );

    it.each(['Session', 'plugin', 'foreground'] as const)('retires the provider waiter for every request the %s store cancels while an older ACK drains', async (scope) => {
        const session = new DeferredUpdateSession();
        const { coordinator } = createHarness(session);
        const owner = { kind: 'plugin' as const, pluginId: 'plugin-a' };
        const older = coordinator.requestDecision({ ...bashRequest, owner });
        const olderRejected = expect(older).rejects.toThrow('Session ended');
        session.deferNextUpdate();
        const response = coordinator.handleResponse({ requestId: bashRequest.requestId, buildCompletion: () => ({
            result: approve(), completedRequest: { status: 'approved', decision: 'approved' },
        }) });
        await vi.waitFor(() => expect(session.hasDeferredUpdate()).toBe(true));
        const cancellation = scope === 'plugin' ? coordinator.cancelByPlugin('plugin-a', 'Session ended')
            : coordinator.cancelAll('Session ended', scope === 'foreground' ? { scope } : undefined);
        const newcomerId = 'published-during-reset';
        let newcomerOutcome = 'pending';
        const newcomer = coordinator.requestDecision({ ...bashRequest, requestId: newcomerId, createdAt: 200, owner });
        const observed = newcomer.then(() => { newcomerOutcome = 'approved'; }, () => { newcomerOutcome = 'canceled'; });
        const neighborAbort = new AbortController();
        const neighborId = scope === 'foreground' ? buildRunScopedExecutionPermissionRequestId({
            runId: 'independent', controllerOccurrenceId: 'controller', providerRequestId: 'neighbor',
        }) : 'neighbor';
        const neighbor = scope !== 'Session' ? coordinator.requestDecision({ ...bashRequest, requestId: neighborId,
            owner: { kind: 'plugin', pluginId: 'plugin-b' } }, { signal: neighborAbort.signal }) : null;
        void neighbor?.catch(() => {});
        session.resolveDeferredUpdate();
        try {
            await cancellation;
            await expect(response).resolves.toBe(false);
            await olderRejected;
            expect(session.agentState.requests?.[newcomerId]).toBeUndefined();
            expect(session.agentState.completedRequests?.[newcomerId]).toMatchObject({ status: 'canceled' });
            expect(newcomerOutcome).toBe('canceled');
            expect(coordinator.getResponseContext(newcomerId)).toBeNull();
            if (neighbor) {
                expect(session.agentState.requests?.[neighborId]).toBeDefined();
                expect(coordinator.getResponseContext(neighborId)).not.toBeNull();
            }
        } finally {
            neighborAbort.abort();
            if (neighbor) await expect(neighbor).rejects.toThrow();
            await coordinator.dispose();
            await observed;
        }
    });

    it.each(['all', 'selected', 'foreground'] as const)('keeps a newer cached decision created while %s cancellation persists', async (scope) => {
        const session = new DeferredUpdateSession();
        const { coordinator, store } = createHarness(session);
        const cacheDecision = async (request: typeof bashRequest) => {
            const abort = new AbortController();
            const pending = coordinator.requestDecision(request, { signal: abort.signal });
            const rejected = expect(pending).rejects.toThrow('Permission request aborted');
            const response = coordinator.handleResponse({ requestId: request.requestId, buildCompletion: () => ({
                result: approve(request.requestId), completedRequest: { status: 'approved', decision: 'approved' },
            }) });
            abort.abort();
            await rejected;
            await expect(response).resolves.toBe(true);
        };
        await cacheDecision(bashRequest);
        const childCachedRequest = { ...bashRequest, requestId: buildRunScopedExecutionPermissionRequestId({
            runId: 'cached-child', controllerOccurrenceId: 'controller', providerRequestId: 'permission',
        }) };
        if (scope === 'foreground') await cacheDecision(childCachedRequest);
        const blocker = coordinator.requestDecision({ ...bashRequest, requestId: 'old-cancel-blocker' });
        const blockerRejected = expect(blocker).rejects.toThrow('old scope stopped');
        session.deferNextUpdate();
        const cancellation = scope === 'selected'
            ? coordinator.cancelRequests(['old-cancel-blocker', bashRequest.requestId], 'old scope stopped')
            : coordinator.cancelAll('old scope stopped', scope === 'foreground' ? { scope } : undefined);
        await vi.waitFor(() => expect(session.hasDeferredUpdate()).toBe(true));
        const newer = { ...bashRequest, createdAt: 200, toolInput: { command: ['bash', '-lc', 'echo newer'] } };
        await cacheDecision(newer);
        session.resolveDeferredUpdate();
        await cancellation;
        await blockerRejected;
        const retryAbort = new AbortController();
        const retry = coordinator.requestDecision(newer, { signal: retryAbort.signal });
        void retry.catch(() => {});
        try {
            expect(store.hasOutstandingRequest(newer.requestId)).toBe(false);
            await expect(retry).resolves.toEqual(approve(newer.requestId));
            if (scope === 'foreground') {
                const childRetry = coordinator.requestDecision(childCachedRequest, { signal: retryAbort.signal });
                await expect(childRetry).resolves.toEqual(approve(childCachedRequest.requestId));
                expect(store.hasOutstandingRequest(childCachedRequest.requestId)).toBe(false);
            }
        } finally {
            retryAbort.abort();
            await coordinator.dispose();
        }
    });

    it('does not apply a queued native decision after single-request cancellation begins', async () => {
        const { coordinator, session } = createHarness();
        const pending = coordinator.requestDecision(bashRequest);
        const rejected = expect(pending).rejects.toThrow();
        let nativeApplied = false;
        const handled = coordinator.completeResponse({
            context: coordinator.getResponseContext(bashRequest.requestId)!,
            completion: { result: approve(), completedRequest: { status: 'approved', decision: 'approved' } },
            acknowledgeDecisionApplication: async () => { nativeApplied = true; },
        });
        const canceled = coordinator.cancelRequests([bashRequest.requestId], 'native hook retired');
        await expect(handled).resolves.toBe(false);
        await canceled;
        await rejected;
        expect(nativeApplied).toBe(false);
        expect(session.agentState.completedRequests?.[bashRequest.requestId]).toMatchObject({ status: 'canceled' });
    });

    it('retires persisted plugin requests after local waiters have disappeared', async () => {
        const session = new FakeSession();
        const persistedRequests = {
            retained: { tool: 'Bash', arguments: {}, createdAt: 1, owner: { kind: 'plugin', pluginId: 'plugin-a' } },
            neighbor: { tool: 'Bash', arguments: {}, createdAt: 2, owner: { kind: 'plugin', pluginId: 'plugin-b' } },
        };
        session.agentState.requests = persistedRequests;
        const { coordinator } = createHarness(session);
        await coordinator.cancelByPlugin('plugin-a', 'plugin retired');
        expect(session.agentState.requests).not.toHaveProperty('retained');
        expect(session.agentState.requests).toHaveProperty('neighbor');
        expect(session.agentState.completedRequests?.retained?.status).toBe('canceled');
    });

    it('cancels only one plugin turn while occurrence questions and neighboring requests remain live', async () => {
        const { coordinator, session } = createHarness();
        const requests = [
            { requestId: 'bound', turnId: 'turn-1', owner: { kind: 'plugin' as const, pluginId: 'plugin-a' } },
            { requestId: 'uncorrelated', owner: { kind: 'plugin' as const, pluginId: 'plugin-a' } },
            { requestId: 'async', turnId: 'turn-1', lifetime: 'occurrence' as const, owner: { kind: 'plugin' as const, pluginId: 'plugin-a' } },
            { requestId: 'next-turn', turnId: 'turn-2', owner: { kind: 'plugin' as const, pluginId: 'plugin-a' } },
            { requestId: 'other-plugin', turnId: 'turn-1', owner: { kind: 'plugin' as const, pluginId: 'plugin-b' } },
        ];
        const outcomes = requests.map((request) => coordinator.requestDecision({ ...bashRequest, ...request }).catch(() => null));
        try {
            await coordinator.cancelByPluginTurn('plugin-a', 'turn-1', 'turn ended');
            await expect(outcomes[0]).resolves.toBeNull();
            expect(Object.keys(session.agentState.requests ?? {}).sort()).toEqual(['async', 'next-turn', 'other-plugin']);
            expect(session.agentState.completedRequests?.bound?.status).toBe('canceled');
            await coordinator.cancelByPlugin('plugin-a', 'plugin retired');
            expect(Object.keys(session.agentState.requests ?? {})).toEqual(['other-plugin']);
            expect(session.agentState.completedRequests?.async?.status).toBe('canceled');
        } finally {
            await coordinator.cancelAll('test cleanup');
            await Promise.all(outcomes);
        }
    });

    it.each(['turn', 'occurrence'] as const)('rejoins %s lifetime requests with their original turn custody and retirement boundary', async (lifetime) => {
        const { coordinator, session, store } = createHarness();
        const request = {
            ...bashRequest,
            requestId: 'occurrence-rejoin',
            turnId: 'turn-1',
            ...(lifetime === 'occurrence' ? { lifetime } : {}),
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
        } as const;
        const original = coordinator.requestDecision(request).catch(() => null);
        coordinator.cancelRequest(request.requestId, 'transport detached');
        await original;
        const reloaded = createPermissionRequestCoordinator<TestPermissionResult>({ store });
        const reattached = reloaded.requestDecision(request).catch(() => null);
        try {
            await reloaded.cancelByPluginTurn('plugin-a', 'turn-1', 'turn ended');
            if (lifetime === 'occurrence') {
                expect(await settledState(reattached)).toBe('pending');
                expect(session.agentState.requests?.[request.requestId]?.turnId).toBe('turn-1');
            } else {
                await expect(reattached).resolves.toBeNull();
            }
            await reloaded.cancelByPlugin('plugin-a', 'occurrence retired');
            await expect(reattached).resolves.toBeNull();
            expect(session.agentState.requests?.[request.requestId]).toBeUndefined();
            expect(session.agentState.completedRequests?.[request.requestId]?.status).toBe('canceled');
        } finally {
            await reloaded.cancelAll('test cleanup');
            await reattached;
        }
    });

    it('rejects a retry that changes the lifetime of a pending request', async () => {
        const { coordinator } = createHarness();
        const request = { ...bashRequest, lifetime: 'occurrence' } as const;
        const pending = coordinator.requestDecision(request).catch(() => null);
        try {
            await expect(coordinator.requestDecision({ ...request, lifetime: 'turn' })).rejects.toThrow();
            expect(await settledState(pending)).toBe('pending');
        } finally {
            await coordinator.cancelAll('test cleanup');
            await pending;
        }
    });

    it('resolves the live waiter when its response target is delivered after terminal persistence', async () => {
        const { coordinator, store, session } = createHarness();
        let delivered: boolean | undefined;
        store.registerResponseTargetHandler('action-confirmation', async ({ requestId }) => {
            delivered = await coordinator.handleResponse({
                requestId,
                buildCompletion: () => ({
                    result: { decision: 'approved' },
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            });
        });
        const waiter = coordinator.requestDecision({
            ...bashRequest,
            turnId: 'turn-action',
            responseTarget: { kind: 'action-confirmation', actionId: 'session.message.send' },
        });
        const outcome = waiter.then((result) => result, () => null);
        try {
            await store.completeRequest({
                requestId: bashRequest.requestId,
                status: 'approved',
                decision: 'approved',
            });
            await vi.waitFor(() => expect(delivered).toBe(true));
            await expect(outcome).resolves.toEqual({ decision: 'approved' });
            expect(session.agentState.requests?.[bashRequest.requestId]).toBeUndefined();
        } finally {
            coordinator.cancelRequest(bashRequest.requestId, 'Test cleanup');
        }
    });

    it('does not replace a persisted rejection with an approved response-target redelivery', async () => {
        const { coordinator, store, session } = createHarness();
        const waiter = coordinator.requestDecision({
            ...bashRequest,
            turnId: 'turn-action',
            responseTarget: { kind: 'action-confirmation', actionId: 'session.message.send' },
        });
        const outcome = waiter.catch(() => null);
        try {
            await store.completeRequest({ requestId: bashRequest.requestId, status: 'denied', decision: 'denied' });
            await expect(coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: () => ({
                    result: { decision: 'approved' },
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            })).resolves.toBe(false);
            expect(await settledState(outcome)).toBe('pending');
            expect(session.agentState.completedRequests?.[bashRequest.requestId]?.status).toBe('denied');
        } finally {
            coordinator.cancelRequest(bashRequest.requestId, 'Test cleanup');
        }
    });

    it.each(['live', 'reattached'] as const)('rejects a different response target when %s custody already exists', async (mode) => {
        const { coordinator, store } = createHarness();
        const request = {
            ...bashRequest,
            turnId: 'turn-action',
            responseTarget: { kind: 'action-confirmation', runtimeAccountId: 'alice' },
        };
        const original = coordinator.requestDecision(request).catch(() => null);
        const next = mode === 'live' ? coordinator : createPermissionRequestCoordinator<TestPermissionResult>({ store });
        const attempted = next.requestDecision({
            ...request,
            responseTarget: { kind: 'action-confirmation', runtimeAccountId: 'bob' },
        });
        let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
        void attempted.then(() => { state = 'fulfilled'; }, () => { state = 'rejected'; });
        try {
            await Promise.resolve();
            expect(state).toBe('rejected');
        } finally {
            coordinator.cancelRequest(request.requestId, 'Test cleanup');
            next.cancelRequest(request.requestId, 'Test cleanup');
            await original;
        }
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('attaches duplicate request ids to one UI request and resolves every live waiter', async () => {
        const { coordinator, session } = createHarness();

        const first = coordinator.requestDecision(bashRequest);
        const second = coordinator.requestDecision({
            ...bashRequest,
            createdAt: 200,
        });

        expect(Object.keys(session.agentState.requests ?? {})).toEqual([bashRequest.requestId]);
        expect(session.agentState.requests![bashRequest.requestId]).toEqual(
            expect.objectContaining({
                tool: 'Bash',
                arguments: bashRequest.toolInput,
                createdAt: 100,
            }),
        );

        const handled = coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: (context) => ({
                result: approve(context.requestId),
                completedRequest: {
                    status: 'approved',
                    decision: 'approved',
                },
            }),
        });

        await expect(handled).resolves.toBe(true);
        await expect(first).resolves.toEqual(approve());
        await expect(second).resolves.toEqual(approve());
        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests![bashRequest.requestId]).toEqual(
            expect.objectContaining({
                tool: 'Bash',
                status: 'approved',
                decision: 'approved',
            }),
        );
    });

    it('preserves the exact persisted turn custody when a fresh coordinator reattaches', async () => {
        const { session } = createHarness();
        const requestId = 'turn-custody-rejoin';
        const sourceAuthority = {
            kind: 'mediatedExternal',
            mediatorPluginId: 'happier.channels',
            sourceRef: 'binding:ops',
            sourceRevisionOrEpoch: '42',
            admittedPermissionCeiling: 'default',
            remoteApprovalMaxScope: 'request',
        } as const;
        const persisted = {
            tool: 'Bash',
            kind: 'permission',
            arguments: bashRequest.toolInput,
            createdAt: 100,
            source: 'remote-mediation',
            owner: {
                kind: 'plugin',
                pluginId: 'happier.channels',
                sourceAuthority,
            },
            turnId: 'turn-a',
        };
        session.agentState.requests![requestId] = persisted as any;
        const before = structuredClone(persisted);
        const reloaded = createPermissionRequestCoordinator<TestPermissionResult>({
            store: new AgentStateRequestStore({ session, logPrefix: '[CoordinatorReload]' }),
        });
        const request = {
            ...bashRequest,
            requestId,
            // Reload-time values must not replace the durable custody facts.
            createdAt: 900,
            source: 'remote-mediation',
            owner: persisted.owner,
            turnId: 'turn-a',
        } as Parameters<typeof reloaded.requestDecision>[0] & Readonly<{ turnId: string }>;

        const reattached = reloaded.requestDecision(request);
        try {
            expect(reloaded.getResponseContext(requestId)).toEqual(expect.objectContaining({
                requestId,
                createdAt: 100,
                kind: 'permission',
                source: 'remote-mediation',
                owner: persisted.owner,
                turnId: 'turn-a',
                correlation: 'record',
                status: 'live',
            }));
            expect(await settledState(reattached)).toBe('pending');
            expect(session.agentState.requests![requestId]).toEqual(before);
        } finally {
            await reloaded.cancelAll('cleanup');
            await Promise.allSettled([reattached]);
        }
    });

    it.each([
        ['a different turn', 'turn-b'],
        ['missing turn provenance', undefined],
    ])('rejects fresh reattachment with %s without mutating durable custody', async (_label, turnId) => {
        const { session } = createHarness();
        const requestId = 'turn-custody-conflict';
        const sourceAuthority = {
            kind: 'mediatedExternal',
            mediatorPluginId: 'happier.channels',
            sourceRef: 'binding:ops',
            sourceRevisionOrEpoch: '42',
            admittedPermissionCeiling: 'default',
            remoteApprovalMaxScope: 'request',
        } as const;
        const persisted = {
            tool: 'Bash',
            kind: 'permission',
            arguments: bashRequest.toolInput,
            createdAt: bashRequest.createdAt,
            source: 'remote-mediation',
            owner: {
                kind: 'plugin',
                pluginId: 'happier.channels',
                sourceAuthority,
            },
            turnId: 'turn-a',
        };
        session.agentState.requests![requestId] = persisted as any;
        const before = structuredClone(persisted);
        const reloaded = createPermissionRequestCoordinator<TestPermissionResult>({
            store: new AgentStateRequestStore({ session, logPrefix: '[CoordinatorReload]' }),
        });
        const incoming = {
            ...bashRequest,
            requestId,
            source: 'remote-mediation',
            owner: persisted.owner,
            ...(turnId ? { turnId } : {}),
        } as Parameters<typeof reloaded.requestDecision>[0] & Readonly<{ turnId?: string }>;
        const attempted = reloaded.requestDecision(incoming);

        try {
            await expect(attempted).rejects.toThrow('incompatible durable custody');
            expect(session.agentState.requests![requestId]).toEqual(before);
        } finally {
            await reloaded.cancelAll('cleanup');
            await Promise.allSettled([attempted]);
        }
    });

    it('persists one remote response claim across a fresh coordinator, rejoins the approved retry tuple across contribution replacement, and clears it on completion', async () => {
        const { coordinator, session } = createHarness();
        const pending = coordinator.requestDecision(bashRequest);
        const claim = {
            version: 1,
            origin: 'remoteMediation',
            actor: {
                kind: 'externalHuman',
                assurance: 'pluginAsserted',
                namespace: 'telegram',
                principalId: 'remote-user',
                assertedBy: {
                    pluginId: 'happier.channels',
                    contributionLocalId: 'telegram',
                },
            },
            mediatorPluginId: 'happier.channels',
            turnId: 'turn-remote-response',
            sourceRef: 'conversation-1',
            sourceRevisionOrEpoch: 'rev-1',
            idempotencyKey: 'reply-1',
            decision: 'allow',
            scope: 'request',
        } satisfies PermissionResponseClaim;

        await expect(coordinator.acquireResponseClaim({ requestId: bashRequest.requestId, claim })).resolves.toEqual({
            status: 'acquired',
        });

        const reloadedStore = new AgentStateRequestStore({ session, logPrefix: '[CoordinatorReload]' });
        reloadedStore.publishRequest({
            requestId: bashRequest.requestId,
            toolName: bashRequest.toolName,
            toolInput: bashRequest.toolInput,
            createdAt: bashRequest.createdAt,
        });
        expect(session.agentState.requests?.[bashRequest.requestId]).toEqual(expect.objectContaining({
            permissionResponseClaimV1: claim,
        }));

        const reloadedCoordinator = createPermissionRequestCoordinator<TestPermissionResult>({ store: reloadedStore });
        await expect(reloadedCoordinator.acquireResponseClaim({
            requestId: bashRequest.requestId,
            claim: {
                ...claim,
                actor: {
                    ...claim.actor,
                    assertedBy: {
                        ...claim.actor.assertedBy,
                        contributionLocalId: 'telegram-reloaded',
                    },
                },
            },
        })).resolves.toEqual({
            status: 'rejoined',
        });
        await expect(reloadedCoordinator.acquireResponseClaim({
            requestId: bashRequest.requestId,
            claim: { ...claim, decision: 'deny' },
        })).resolves.toEqual({ status: 'conflict' });
        await expect(reloadedCoordinator.acquireResponseClaim({
            requestId: bashRequest.requestId,
            claim: { ...claim, scope: 'session' },
        })).resolves.toEqual({ status: 'conflict' });
        await expect(reloadedCoordinator.acquireResponseClaim({
            requestId: bashRequest.requestId,
            claim: { ...claim, sourceRevisionOrEpoch: 'rev-2' },
        })).resolves.toEqual({ status: 'conflict' });
        await expect(reloadedCoordinator.acquireResponseClaim({
            requestId: bashRequest.requestId,
            claim: { ...claim, idempotencyKey: 'reply-2' },
        })).resolves.toEqual({ status: 'conflict' });
        await expect(reloadedCoordinator.acquireResponseClaim({
            requestId: bashRequest.requestId,
            claim: {
                ...claim,
                actor: { ...claim.actor, principalId: 'different-remote-user' },
            },
        })).resolves.toEqual({ status: 'conflict' });

        await expect(coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: (context) => ({
                result: approve(context.requestId),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        })).resolves.toBe(true);
        await expect(pending).resolves.toEqual(approve());
        expect(session.agentState.completedRequests?.[bashRequest.requestId]).not.toHaveProperty('permissionResponseClaimV1');
    });

    it('durably cancels an already-claimed response before it can authorize', async () => {
        const { coordinator, session } = createHarness();
        const pending = coordinator.requestDecision(bashRequest);
        const claim = {
            version: 1,
            origin: 'presentUser',
            actor: {
                kind: 'accountUser',
                accountId: 'account-owner',
                relationship: 'owner',
            },
            decision: 'approved',
            scope: 'request',
        } satisfies PermissionResponseClaim;

        await expect(coordinator.acquireResponseClaim({ requestId: bashRequest.requestId, claim })).resolves.toEqual({
            status: 'acquired',
        });
        await coordinator.cancelAll('test lifecycle cancellation');

        await expect(pending).rejects.toThrow('test lifecycle cancellation');
        expect(session.agentState.requests?.[bashRequest.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests?.[bashRequest.requestId]).toEqual(expect.objectContaining({
            status: 'canceled',
            decision: 'abort',
            reason: 'test lifecycle cancellation',
        }));
        expect(session.canceledCompletionWriteCount).toBe(1);
        await expect(coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: (context) => ({
                result: approve(context.requestId),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        })).resolves.toBe(false);
        await coordinator.cancelAll('test lifecycle cancellation');
        await coordinator.releaseResponseClaim({ requestId: bashRequest.requestId, claim });
        expect(session.canceledCompletionWriteCount).toBe(1);
    });

    it('durably cancels an already-claimed plugin response through the same lifecycle path', async () => {
        const { coordinator, session } = createHarness();
        const request = {
            ...bashRequest,
            requestId: 'claimed-plugin-response',
            owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
        } as const;
        const pending = coordinator.requestDecision(request);
        const claim = {
            version: 1,
            origin: 'presentUser',
            actor: {
                kind: 'accountUser',
                accountId: 'account-owner',
                relationship: 'owner',
            },
            decision: 'approved',
            scope: 'request',
        } satisfies PermissionResponseClaim;

        await expect(coordinator.acquireResponseClaim({ requestId: request.requestId, claim })).resolves.toEqual({
            status: 'acquired',
        });
        await coordinator.cancelByPlugin('plugin-a', 'plugin_deactivated');

        expect(session.agentState.requests?.[request.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests?.[request.requestId]).toEqual(expect.objectContaining({
            status: 'canceled',
            decision: 'abort',
            reason: 'plugin_deactivated',
            owner: request.owner,
        }));
        expect(session.canceledCompletionWriteCount).toBe(1);
        await expect(pending).rejects.toThrow('plugin_deactivated');

        await coordinator.cancelByPlugin('plugin-a', 'plugin_deactivated');
        await coordinator.releaseResponseClaim({ requestId: request.requestId, claim });
        expect(session.canceledCompletionWriteCount).toBe(1);
    });

    it('does not persist plugin cancellation when that plugin has no pending requests', async () => {
        const session = new RejectingUpdateSession();
        const { coordinator } = createHarness(session);

        session.rejectNextUpdate();
        await expect(coordinator.cancelByPlugin('plugin-a', 'plugin_deactivated')).resolves.toBeUndefined();
        expect(session.agentStateWriteCount).toBe(0);
    });

    it('does not resolve an approved waiter before its exact AgentState completion update settles', async () => {
        const session = new DeferredUpdateSession();
        const { coordinator } = createHarness(session);
        const pendingDecision = coordinator.requestDecision(bashRequest);

        session.deferNextUpdate();
        const handled = Promise.resolve(coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: (context) => ({
                result: approve(context.requestId),
                completedRequest: {
                    status: 'approved',
                    decision: 'approved',
                },
            }),
        }));

        let didHandleResponse = false;
        let didResolveDecision = false;
        void handled.then(() => {
            didHandleResponse = true;
        });
        void pendingDecision.then(() => {
            didResolveDecision = true;
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(didHandleResponse).toBe(false);
        expect(didResolveDecision).toBe(false);
        expect(session.agentState.requests![bashRequest.requestId]).toBeDefined();
        expect(session.agentState.completedRequests![bashRequest.requestId]).toBeUndefined();

        session.resolveDeferredUpdate();

        await expect(handled).resolves.toBe(true);
        await expect(pendingDecision).resolves.toEqual(approve());
        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests![bashRequest.requestId]).toEqual(
            expect.objectContaining({ status: 'approved', decision: 'approved' }),
        );
    });

    it('keeps the request and waiter retriable when completion persistence rejects', async () => {
        const session = new RejectingUpdateSession();
        const { coordinator } = createHarness(session);
        const pending = coordinator.requestDecision(bashRequest);

        session.rejectNextUpdate();
        await expect(coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: () => ({
                result: approve(),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        })).rejects.toThrow('agent state persistence failed');

        expect(await settledState(pending)).toBe('pending');
        expect(session.agentState.requests![bashRequest.requestId]).toBeDefined();
        expect(session.agentState.completedRequests![bashRequest.requestId]).toBeUndefined();

        await expect(coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: () => ({
                result: approve(),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        })).resolves.toBe(true);
        await expect(pending).resolves.toEqual(approve());
    });

    it('retains an applied native choice after failed persistence and never applies a competing answer', async () => {
        const session = new RejectingUpdateSession();
        const { coordinator } = createHarness(session);
        const request = { ...bashRequest, toolName: 'AskUserQuestion', toolInput: { questions: [] } };
        const pending = coordinator.requestDecision(request);
        const context = coordinator.getResponseContext(request.requestId)!;
        const apply = vi.fn(async () => undefined);
        const chosen = { result: { decision: 'approved', answers: { choice: 'Continue' } },
            completedRequest: { status: 'approved', decision: 'approved',
                extraCompletedFields: { answers: { choice: 'Continue' } } } };
        session.rejectNextUpdate();
        await expect(coordinator.completeResponse({ context, completion: chosen,
            acknowledgeDecisionApplication: apply })).rejects.toThrow('agent state persistence failed');
        expect(await settledState(pending)).toBe('pending');
        expect(session.agentState.requests![request.requestId]).toBeDefined();
        await expect(coordinator.completeResponse({ context,
            completion: { result: { decision: 'approved', answers: { choice: 'Restart' } },
                completedRequest: { status: 'approved', decision: 'approved',
                    extraCompletedFields: { answers: { choice: 'Restart' } } } },
            acknowledgeDecisionApplication: apply })).resolves.toBe(false);
        expect(apply).toHaveBeenCalledTimes(1);
        await expect(coordinator.completeResponse({ context, completion: chosen,
            acknowledgeDecisionApplication: apply })).resolves.toBe(true);
        await expect(pending).resolves.toEqual(chosen.result);
        expect(apply).toHaveBeenCalledTimes(1);
        expect(session.agentState.requests![request.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests![request.requestId]).toMatchObject({
            status: 'approved', answers: { choice: 'Continue' } });
    });

    it.each(['replacement', 'claim'] as const)('does not adopt a newer %s arriving during native application', async (change) => {
        const session = new FakeSession();
        const { coordinator } = createHarness(session);
        const pending = coordinator.requestDecision(bashRequest);
        void pending.catch(() => undefined);
        const context = coordinator.getResponseContext(bashRequest.requestId)!;
        const apply = vi.fn(async () => {
            const original = session.agentState.requests![bashRequest.requestId]!;
            session.agentState.requests![bashRequest.requestId] = change === 'replacement'
                ? { ...original, createdAt: 200 }
                : { ...original, permissionResponseClaimV1: { version: 1, origin: 'automaticPolicy' } };
        });
        await expect(coordinator.completeResponse({ context,
            completion: { result: approve(), completedRequest: { status: 'approved', decision: 'approved' } },
            acknowledgeDecisionApplication: apply })).resolves.toBe(false);
        await expect(pending).rejects.toThrow('Applied request retired');
        expect(session.agentState.completedRequests![bashRequest.requestId]).toBeUndefined();
        if (change === 'replacement') expect(session.agentState.requests![bashRequest.requestId]?.createdAt).toBe(200);
        else expect(session.agentState.requests![bashRequest.requestId]).toHaveProperty('permissionResponseClaimV1');
        expect(apply).toHaveBeenCalledTimes(1);
    });

    it.each(['terminal', 'replacement'] as const)('does not report the applied choice saved when the first ACK observes a newer %s', async (change) => {
        const session = new DeferredUpdateSession();
        const { coordinator } = createHarness(session);
        const pending = coordinator.requestDecision(bashRequest);
        void pending.catch(() => undefined);
        const context = coordinator.getResponseContext(bashRequest.requestId)!;
        const apply = vi.fn(async () => undefined);
        session.deferNextUpdate();
        const response = coordinator.completeResponse({ context,
            completion: { result: approve(), completedRequest: { status: 'approved', decision: 'approved' } },
            acknowledgeDecisionApplication: apply });
        await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
        const original = session.agentState.requests![bashRequest.requestId]!;
        session.agentState = change === 'terminal'
            ? { requests: {}, completedRequests: { [bashRequest.requestId]: {
                ...original, completedAt: 200, status: 'canceled', decision: 'abort' } } }
            : { requests: { [bashRequest.requestId]: { ...original, createdAt: 200 } }, completedRequests: {} };
        session.resolveDeferredUpdate();
        await expect(response).resolves.toBe(false);
        await expect(pending).rejects.toThrow('Applied request retired');
        expect(apply).toHaveBeenCalledTimes(1);
    });

    it('recovers the observed native result into the original waiter without granting a later request', async () => {
        const session = new RejectingUpdateSession();
        const { coordinator, store } = createHarness(session);
        const request = { ...bashRequest, requestId: 'native-observed-recovery',
            toolName: 'AskUserQuestion', kind: 'user_action', source: 'native.question', lifetime: 'occurrence',
            toolInput: { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
            owner: { kind: 'plugin', pluginId: 'fixture.plugin', runtimeId: 'native-runtime' } } as const;
        const pending = coordinator.requestDecision(request);
        const context = coordinator.getResponseContext(request.requestId)!;
        const answers = { 'Continue?': ['No'] };
        const completion = { result: { decision: 'approved', answers },
            completedRequest: { status: 'approved', decision: 'approved', structuredAnswersV1: answers } };
        session.rejectNextUpdate();
        await expect(coordinator.completeObservedResponse({ context, completion })).rejects.toThrow('agent state persistence failed');
        expect(store.readAppliedCompletion({ requestId: request.requestId, ...completion.completedRequest })).toMatchObject({ matches: true });
        expect(await settledState(pending)).toBe('pending');
        const replacement = new AgentStateRequestStore({ session, logPrefix: '[Observed replacement]' });
        replacement.adoptAppliedCompletions(store);
        store.dispose();
        await replacement.recoverAppliedCompletions();
        expect(coordinator.getResponseContext(request.requestId)).toBeNull();
        await expect(pending).resolves.toEqual(completion.result);
        expect(session.agentState.requests?.[request.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests?.[request.requestId]).toMatchObject({ status: 'approved', structuredAnswersV1: answers });
        await expect(coordinator.completeObservedResponse({ context, completion })).resolves.toBe(false);
        const later = coordinator.requestDecision({ ...request, requestId: 'native-observed-later' }).catch(() => null);
        expect(session.agentState.requests?.['native-observed-later']).toBeDefined();
        expect(session.agentState.completedRequests?.['native-observed-later']).toBeUndefined();
        expect(await settledState(later)).toBe('pending');
        await coordinator.cancelAll('test cleanup');
        await later;
        replacement.dispose();
    });

    it.each([1, 2])('retires an occurrence question only after the last of %i waiters aborts', async waiterCount => {
        const { coordinator, session } = createHarness();
        const request = { ...bashRequest, requestId: 'native-occurrence-expired', toolName: 'AskUserQuestion',
            kind: 'user_action', source: 'native.question', lifetime: 'occurrence',
            owner: { kind: 'plugin', pluginId: 'fixture.plugin' } } as const;
        const firstSignal = new AbortController();
        const secondSignal = new AbortController();
        const first = coordinator.requestDecision(request, { signal: firstSignal.signal }).catch(() => null);
        const second = waiterCount === 2 ? coordinator.requestDecision(request, { signal: secondSignal.signal }).catch(() => null) : null;
        firstSignal.abort();
        await first;
        if (second) {
            expect(await settledState(second)).toBe('pending');
            expect(session.agentState.requests?.[request.requestId]).toBeDefined();
            expect(session.agentState.completedRequests?.[request.requestId]).toBeUndefined();
            secondSignal.abort();
            await second;
        }
        expect(session.agentState.requests?.[request.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests?.[request.requestId]).toMatchObject({ status: 'canceled', decision: 'abort' });
        await expect(coordinator.handleResponse({ requestId: request.requestId, buildCompletion: () => ({
            result: { decision: 'approved' }, completedRequest: { status: 'approved', decision: 'approved' },
        }) })).resolves.toBe(false);
    });

    it('settles the original waiter after recovery through a replacement Session request store', async () => {
        const session = new RejectingUpdateSession();
        const { coordinator, store } = createHarness(session);
        const pending = coordinator.requestDecision(bashRequest);
        const context = coordinator.getResponseContext(bashRequest.requestId)!;
        const apply = vi.fn(async () => undefined);
        const completion = { result: approve(), completedRequest: { status: 'approved', decision: 'approved' } };
        session.rejectNextUpdate();
        await expect(coordinator.completeResponse({ context, completion,
            acknowledgeDecisionApplication: apply })).rejects.toThrow('agent state persistence failed');
        const replacement = new AgentStateRequestStore({ session, logPrefix: '[Replacement]' });
        replacement.adoptAppliedCompletions(store);
        store.dispose();
        await replacement.recoverAppliedCompletions();
        await expect(pending).resolves.toEqual(approve());
        expect(coordinator.getResponseContext(bashRequest.requestId)).toBeNull();
        expect(apply).toHaveBeenCalledTimes(1);
        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests![bashRequest.requestId]).toMatchObject({ status: 'approved' });
    });

    it.each(['replacement', 'claim', 'terminal', 'cancel', 'dispose'] as const)(
        'retires an applied fact without reviving it after %s', async (change) => {
        const session = new RejectingUpdateSession();
        const { coordinator, store } = createHarness(session);
        const pending = coordinator.requestDecision(bashRequest);
        void pending.catch(() => undefined);
        const context = coordinator.getResponseContext(bashRequest.requestId)!;
        const apply = vi.fn(async () => undefined);
        session.rejectNextUpdate();
        await expect(coordinator.completeResponse({ context,
            completion: { result: approve(), completedRequest: { status: 'approved', decision: 'approved' } },
            acknowledgeDecisionApplication: apply })).rejects.toThrow('agent state persistence failed');
        const original = session.agentState.requests![bashRequest.requestId]!;
        if (change === 'replacement') session.agentState.requests![bashRequest.requestId] = { ...original, createdAt: 200 };
        if (change === 'claim') session.agentState.requests![bashRequest.requestId] = {
            ...original, permissionResponseClaimV1: { version: 1, origin: 'automaticPolicy' } };
        if (change === 'terminal' || change === 'cancel') {
            const state: AgentState = { ...session.agentState, requests: {}, completedRequests: {
                [bashRequest.requestId]: { ...original, completedAt: 300, status: 'canceled', decision: 'abort' } } };
            session.agentState = store.applyAppliedCompletions(state);
        }
        if (change === 'dispose') store.dispose();
        else await store.recoverAppliedCompletions();
        await expect(pending).rejects.toThrow('Applied request retired');
        expect(apply).toHaveBeenCalledTimes(1);
        expect(store.readAppliedCompletion({ requestId: bashRequest.requestId, status: 'approved', decision: 'approved' })).toBeNull();
        if (change === 'replacement') expect(session.agentState.requests![bashRequest.requestId]?.createdAt).toBe(200);
        if (change === 'claim') expect(session.agentState.requests![bashRequest.requestId]).toHaveProperty('permissionResponseClaimV1');
        if (change === 'terminal' || change === 'cancel') expect(session.agentState.completedRequests![bashRequest.requestId]?.decision).toBe('abort');
    });

    it('keeps lifecycle cancellation retriable until its AgentState terminal update succeeds', async () => {
        const session = new RejectingUpdateSession();
        const { coordinator } = createHarness(session);
        const pending = coordinator.requestDecision(bashRequest);

        session.rejectNextUpdate();
        await expect(coordinator.cancelAll('Session ended')).rejects.toThrow('agent state persistence failed');

        expect(await settledState(pending)).toBe('pending');
        expect(session.agentState.requests![bashRequest.requestId]).toBeDefined();
        expect(session.agentState.completedRequests![bashRequest.requestId]).toBeUndefined();

        await expect(coordinator.cancelAll('Session ended')).resolves.toBeUndefined();
        await expect(pending).rejects.toThrow('Session ended');
        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests![bashRequest.requestId]).toEqual(expect.objectContaining({
            status: 'canceled',
            decision: 'abort',
        }));
    });

    it('surfaces an in-flight completion persistence failure to lifecycle cancellation without terminalizing the request', async () => {
        const session = new DeferredUpdateSession();
        const { coordinator } = createHarness(session);
        const pending = coordinator.requestDecision(bashRequest);

        session.deferNextUpdate();
        const completing = coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: () => ({
                result: approve(),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        });
        await Promise.resolve();
        await Promise.resolve();
        const canceling = coordinator.cancelAll('Session ended');
        const pendingOutcome = settledState(pending);

        session.failDeferredUpdate();

        const [completionOutcome, cancellationOutcome] = await Promise.allSettled([completing, canceling]);
        expect(completionOutcome).toMatchObject({
            status: 'rejected',
            reason: expect.objectContaining({ message: 'agent state persistence failed' }),
        });
        expect(cancellationOutcome).toMatchObject({
            status: 'rejected',
            reason: expect.objectContaining({ message: 'agent state persistence failed' }),
        });
        expect(await pendingOutcome).toBe('pending');
        expect(session.agentState.requests![bashRequest.requestId]).toBeDefined();
        expect(session.agentState.completedRequests![bashRequest.requestId]).toBeUndefined();

        await expect(coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: () => ({
                result: approve(),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        })).resolves.toBe(true);
        await expect(pending).resolves.toEqual(approve());
    });

    it('surfaces an in-flight completion persistence failure to plugin cancellation without terminalizing the request', async () => {
        const session = new DeferredUpdateSession();
        const { coordinator } = createHarness(session);
        const request = {
            ...bashRequest,
            requestId: 'plugin-in-flight-cancel-persistence',
            owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
        } as const;
        const pending = coordinator.requestDecision(request);

        session.deferNextUpdate();
        const completing = coordinator.handleResponse({
            requestId: request.requestId,
            buildCompletion: () => ({
                result: approve(request.requestId),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        });
        await Promise.resolve();
        await Promise.resolve();
        const canceling = coordinator.cancelByPlugin('plugin-a', 'plugin_deactivated');
        const pendingOutcome = settledState(pending);

        session.failDeferredUpdate();

        const [completionOutcome, cancellationOutcome] = await Promise.allSettled([completing, canceling]);
        expect(completionOutcome).toMatchObject({
            status: 'rejected',
            reason: expect.objectContaining({ message: 'agent state persistence failed' }),
        });
        expect(cancellationOutcome).toMatchObject({
            status: 'rejected',
            reason: expect.objectContaining({ message: 'agent state persistence failed' }),
        });
        expect(await pendingOutcome).toBe('pending');
        expect(session.agentState.requests![request.requestId]).toBeDefined();
        expect(session.agentState.completedRequests![request.requestId]).toBeUndefined();
    });

    it('keeps plugin-owned cancellation retriable until its AgentState terminal update succeeds', async () => {
        const session = new RejectingUpdateSession();
        const { coordinator } = createHarness(session);
        const request = {
            ...bashRequest,
            requestId: 'plugin-cancel-persistence',
            owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
        } as const;
        const pending = coordinator.requestDecision(request);

        session.rejectNextUpdate();
        await expect(coordinator.cancelByPlugin('plugin-a', 'plugin_deactivated')).rejects.toThrow(
            'agent state persistence failed',
        );

        expect(await settledState(pending)).toBe('pending');
        expect(session.agentState.requests![request.requestId]).toBeDefined();
        expect(session.agentState.completedRequests![request.requestId]).toBeUndefined();

        await expect(coordinator.cancelByPlugin('plugin-a', 'plugin_deactivated')).resolves.toBeUndefined();
        await expect(pending).rejects.toThrow('plugin_deactivated');
        expect(session.agentState.requests![request.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests![request.requestId]).toEqual(expect.objectContaining({
            status: 'canceled',
            decision: 'abort',
            owner: request.owner,
        }));
    });

    it('keeps a failed final plugin cancellation non-answerable until a compatible live waiter reattaches', async () => {
        const session = new RejectingUpdateSession();
        const { coordinator } = createHarness(session);
        const abort = new AbortController();
        const request = {
            ...bashRequest,
            requestId: 'plugin-abort-persistence',
            owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
        } as const;
        const pending = coordinator.requestDecision(request, { signal: abort.signal });

        session.rejectNextUpdate();
        abort.abort();

        await expect(pending).rejects.toThrow('agent state persistence failed');
        expect(session.agentState.requests![request.requestId]).toBeDefined();
        expect(session.agentState.completedRequests![request.requestId]).toBeUndefined();
        expect(coordinator.getResponseContext(request.requestId)).toBeNull();
        expect(coordinator.listResponseContexts()).toEqual([]);
        await expect(coordinator.handleResponse({
            requestId: request.requestId,
            buildCompletion: () => ({
                result: approve(request.requestId),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        })).resolves.toBe(false);

        const retry = coordinator.requestDecision(request);
        await expect(coordinator.handleResponse({
            requestId: request.requestId,
            buildCompletion: () => ({
                result: approve(request.requestId),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        })).resolves.toBe(true);
        await expect(retry).resolves.toEqual(approve(request.requestId));
    });

    it('keeps a failed final unowned cancellation non-answerable until a compatible live waiter reattaches', async () => {
        const session = new RejectingUpdateSession();
        const { coordinator } = createHarness(session);
        const abort = new AbortController();
        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });

        session.rejectNextUpdate();
        abort.abort();

        await expect(pending).rejects.toThrow('agent state persistence failed');
        expect(session.agentState.requests![bashRequest.requestId]).toBeDefined();
        expect(session.agentState.completedRequests![bashRequest.requestId]).toBeUndefined();
        expect(coordinator.getResponseContext(bashRequest.requestId)).toBeNull();
        expect(coordinator.listResponseContexts()).toEqual([]);
        await expect(coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: () => ({
                result: approve(),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        })).resolves.toBe(false);

        const retry = coordinator.requestDecision(bashRequest);
        await expect(coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: () => ({
                result: approve(),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        })).resolves.toBe(true);
        await expect(retry).resolves.toEqual(approve());
    });

    it('reconciles a failed final plugin cancellation through the existing plugin cancellation lifecycle', async () => {
        const session = new RejectingUpdateSession();
        const { coordinator } = createHarness(session);
        const abort = new AbortController();
        const request = {
            ...bashRequest,
            requestId: 'plugin-abort-reconcile',
            owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
        } as const;
        const pending = coordinator.requestDecision(request, { signal: abort.signal });

        session.rejectNextUpdate();
        abort.abort();

        await expect(pending).rejects.toThrow('agent state persistence failed');
        expect(coordinator.getResponseContext(request.requestId)).toBeNull();

        await expect(coordinator.cancelByPlugin('plugin-a', 'plugin_deactivated')).resolves.toBeUndefined();

        expect(coordinator.getResponseContext(request.requestId)).toBeNull();
        expect(session.agentState.requests![request.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests![request.requestId]).toEqual(expect.objectContaining({
            status: 'canceled',
            decision: 'abort',
            owner: request.owner,
        }));
    });

    it('lets plugin cancellation supersede an in-flight approval for the exact owned request', async () => {
        const session = new DeferredUpdateSession();
        const { coordinator } = createHarness(session);
        const pluginRequest = {
            ...bashRequest,
            requestId: 'plugin-a-in-flight-approval',
            owner: {
                kind: 'plugin',
                pluginId: 'plugin-a',
                runtimeId: 'runtime-a',
            },
        } as const;
        const pendingDecision = coordinator.requestDecision(pluginRequest);

        session.deferNextUpdate();
        const handled = coordinator.handleResponse({
            requestId: pluginRequest.requestId,
            buildCompletion: (context) => ({
                result: approve(context.requestId),
                completedRequest: {
                    status: 'approved',
                    decision: 'approved',
                },
            }),
        });
        const canceled = coordinator.cancelByPlugin('plugin-a', 'plugin_deactivated');

        expect(await settledState(pendingDecision)).toBe('pending');
        expect(await settledState(handled)).toBe('pending');
        expect(await settledState(canceled)).toBe('pending');

        session.resolveDeferredUpdate();

        await expect(handled).resolves.toBe(false);
        await expect(canceled).resolves.toBeUndefined();
        await expect(pendingDecision).rejects.toThrow('plugin_deactivated');
        expect(session.agentState.requests![pluginRequest.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests![pluginRequest.requestId]).toEqual(
            expect.objectContaining({
                status: 'canceled',
                decision: 'abort',
                reason: 'plugin_deactivated',
                owner: pluginRequest.owner,
            }),
        );

        const retryAbort = new AbortController();
        const retry = coordinator.requestDecision(pluginRequest, { signal: retryAbort.signal });
        expect(await settledState(retry)).toBe('pending');
        retryAbort.abort();
        await expect(retry).rejects.toThrow('Permission request aborted');
    });

    it('lets lifecycle cancellation supersede an in-flight approval for the exact live request', async () => {
        const session = new DeferredUpdateSession();
        const { coordinator } = createHarness(session);
        const pendingDecision = coordinator.requestDecision(bashRequest);

        session.deferNextUpdate();
        const handled = coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: (context) => ({
                result: approve(context.requestId),
                completedRequest: {
                    status: 'approved',
                    decision: 'approved',
                },
            }),
        });
        const canceled = Promise.resolve(coordinator.cancelAll('Session ended'));

        expect(await settledState(pendingDecision)).toBe('pending');
        expect(await settledState(handled)).toBe('pending');
        expect(await settledState(canceled)).toBe('pending');

        session.resolveDeferredUpdate();

        await expect(handled).resolves.toBe(false);
        await expect(canceled).resolves.toBeUndefined();
        await expect(pendingDecision).rejects.toThrow('Session ended');
        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests![bashRequest.requestId]).toEqual(
            expect.objectContaining({
                status: 'canceled',
                decision: 'abort',
                reason: 'Session ended',
            }),
        );

        const retryAbort = new AbortController();
        const retry = coordinator.requestDecision(bashRequest, { signal: retryAbort.signal });
        expect(await settledState(retry)).toBe('pending');
        retryAbort.abort();
        await expect(retry).rejects.toThrow('Permission request aborted');
    });

    it('removes only the aborted waiter while other waiters remain live', async () => {
        const { coordinator } = createHarness();
        const firstAbort = new AbortController();
        const secondAbort = new AbortController();

        const first = coordinator.requestDecision(bashRequest, { signal: firstAbort.signal });
        const second = coordinator.requestDecision(bashRequest, { signal: secondAbort.signal });

        firstAbort.abort();

        await expect(first).rejects.toThrow('Permission request aborted');
        expect(coordinator.getResponseContext(bashRequest.requestId)).toEqual(
            expect.objectContaining({
                requestId: bashRequest.requestId,
                status: 'live',
                correlation: 'record',
            }),
        );

        await expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: () => ({
                    result: approve(),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).resolves.toBe(true);

        await expect(second).resolves.toEqual(approve());
    });

    it('does not publish a plugin-owned request when its caller signal is already aborted', async () => {
        const { coordinator, session } = createHarness();
        const abort = new AbortController();
        abort.abort();

        await expect(coordinator.requestDecision({
            ...bashRequest,
            requestId: 'plugin-pre-aborted',
            owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
        }, { signal: abort.signal })).rejects.toThrow('Permission request aborted');

        expect(session.agentState.requests).toEqual({});
        expect(session.agentState.completedRequests).toEqual({});
    });

    it('terminalizes the exact plugin-owned request when its last caller aborts', async () => {
        const { coordinator, session } = createHarness();
        const abort = new AbortController();
        const request = {
            ...bashRequest,
            requestId: 'plugin-request-aborted-after-publish',
            owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
        } as const;

        const pending = coordinator.requestDecision(request, { signal: abort.signal });
        expect(session.agentState.requests![request.requestId]).toEqual(expect.objectContaining({
            owner: request.owner,
        }));

        abort.abort();

        await expect(pending).rejects.toThrow('Permission request aborted');
        expect(session.agentState.requests![request.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests![request.requestId]).toEqual(expect.objectContaining({
            status: 'canceled',
            decision: 'abort',
            reason: 'Permission request aborted',
            owner: request.owner,
        }));
        expect(coordinator.getResponseContext(request.requestId)).toBeNull();
        await expect(coordinator.handleResponse({
            requestId: request.requestId,
            buildCompletion: () => ({
                result: approve(request.requestId),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        })).resolves.toBe(false);
    });

    it('keeps a plugin-owned request live while another waiter still needs the decision', async () => {
        const { coordinator, session } = createHarness();
        const firstAbort = new AbortController();
        const request = {
            ...bashRequest,
            requestId: 'plugin-shared-waiters',
            owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
        } as const;
        const first = coordinator.requestDecision(request, { signal: firstAbort.signal });
        const second = coordinator.requestDecision(request);

        firstAbort.abort();

        await expect(first).rejects.toThrow('Permission request aborted');
        expect(session.agentState.requests![request.requestId]).toBeDefined();
        expect(session.agentState.completedRequests![request.requestId]).toBeUndefined();
        await expect(coordinator.handleResponse({
            requestId: request.requestId,
            buildCompletion: () => ({
                result: approve(request.requestId),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        })).resolves.toBe(true);
        await expect(second).resolves.toEqual(approve(request.requestId));
        expect(session.agentState.completedRequests![request.requestId]).toEqual(expect.objectContaining({
            status: 'approved',
            decision: 'approved',
        }));
    });

    it('lets an already-claimed plugin answer win an abort race without a second terminal result', async () => {
        const session = new DeferredUpdateSession();
        const { coordinator } = createHarness(session);
        const abort = new AbortController();
        const request = {
            ...bashRequest,
            requestId: 'plugin-answer-wins-abort-race',
            owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
        } as const;
        const pending = coordinator.requestDecision(request, { signal: abort.signal });
        const pendingOutcome = pending.then(
            () => null,
            (error: unknown) => error,
        );

        session.deferNextUpdate();
        const handled = coordinator.handleResponse({
            requestId: request.requestId,
            buildCompletion: () => ({
                result: approve(request.requestId),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        });
        abort.abort();
        await Promise.resolve();
        await Promise.resolve();
        session.resolveDeferredUpdate();

        await expect(handled).resolves.toBe(true);
        await expect(pendingOutcome).resolves.toEqual(expect.objectContaining({
            message: 'Permission request aborted',
        }));
        expect(session.agentState.requests![request.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests![request.requestId]).toEqual(expect.objectContaining({
            status: 'approved',
            decision: 'approved',
        }));
        expect(Object.keys(session.agentState.completedRequests ?? {})).toEqual([request.requestId]);
    });

    it('durably cancels an unowned request when its sole waiter aborts', async () => {
        const { coordinator, session } = createHarness();
        const abort = new AbortController();

        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        abort.abort();

        await expect(pending).rejects.toThrow('Permission request aborted');
        await Promise.resolve();
        await Promise.resolve();

        expect(coordinator.getResponseContext(bashRequest.requestId)).toBeNull();
        await expect(coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: (context) => ({
                result: approve(context.requestId),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        })).resolves.toBe(false);

        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests![bashRequest.requestId]).toEqual(
            expect.objectContaining({ status: 'canceled', decision: 'abort' }),
        );
    });

    it('does not reattach while the final cancellation is still persisting', async () => {
        const session = new DeferredUpdateSession();
        const { coordinator } = createHarness(session);
        const abort = new AbortController();
        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });

        session.deferNextUpdate();
        abort.abort();

        const prematureRetry = coordinator.requestDecision(bashRequest);
        void prematureRetry.catch(() => undefined);
        const prematureState = await Promise.race([
            prematureRetry.then(
                () => 'fulfilled' as const,
                () => 'rejected' as const,
            ),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
        ]);
        expect(prematureState).toBe('rejected');

        session.resolveDeferredUpdate();
        await expect(pending).rejects.toThrow('Permission request aborted');

        const retryAbort = new AbortController();
        const retry = coordinator.requestDecision(bashRequest, { signal: retryAbort.signal });
        expect(await settledState(retry)).toBe('pending');
        retryAbort.abort();
        await expect(retry).rejects.toThrow('Permission request aborted');
    });

    it('withdraws response admission before the final caller cancellation is durable', async () => {
        const session = new DeferredUpdateSession();
        const { coordinator } = createHarness(session);
        const abort = new AbortController();
        const request = { ...bashRequest, lifetime: 'occurrence' as const,
            owner: { kind: 'plugin' as const, pluginId: 'plugin-a' } };
        const pending = coordinator.requestDecision(request, { signal: abort.signal }).catch(error => error);
        const context = coordinator.getResponseContext(request.requestId)!;
        const apply = vi.fn(async () => undefined);
        session.deferNextUpdate();
        abort.abort();
        try {
            expect(session.agentState.requests?.[request.requestId]).toBeDefined();
            expect(coordinator.getResponseContext(request.requestId)).toBeNull();
            await expect(coordinator.handleResponse({ requestId: request.requestId,
                buildCompletion: () => ({ result: approve(), completedRequest: { status: 'approved' } }),
            })).resolves.toBe(false);
            await expect(coordinator.completeResponse({ context, acknowledgeDecisionApplication: apply,
                completion: { result: approve(), completedRequest: { status: 'approved' } },
            })).resolves.toBe(false);
            expect(apply).not.toHaveBeenCalled();
        } finally {
            session.resolveDeferredUpdate();
            await expect(pending).resolves.toMatchObject({ message: 'Permission request aborted' });
        }
        expect(session.agentState.completedRequests?.[request.requestId]).toMatchObject({ status: 'canceled' });
    });

    it.each(['input', 'lifetime'] as const)('does not consume an in-flight cached decision when the same id is retried with different %s', async (changed) => {
        const session = new DeferredUpdateSession();
        const { coordinator } = createHarness(session);
        const abort = new AbortController();

        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        session.deferNextUpdate();
        const handled = coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: () => ({
                result: approve(),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        });
        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');
        await Promise.resolve();
        await Promise.resolve();
        session.resolveDeferredUpdate();
        await expect(handled).resolves.toBe(true);

        const retryAbort = new AbortController();
        const toolInput = changed === 'input'
            ? { command: ['bash', '-lc', 'echo different'] }
            : bashRequest.toolInput;
        const retry = coordinator.requestDecision(
            {
                ...bashRequest,
                toolInput,
                ...(changed === 'lifetime' ? { lifetime: 'occurrence' as const } : {}),
                createdAt: 300,
            },
            { signal: retryAbort.signal },
        );

        expect(await settledState(retry)).toBe('pending');
        expect(session.agentState.requests![bashRequest.requestId]).toEqual(
            expect.objectContaining({
                arguments: toolInput,
                createdAt: 300,
            }),
        );

        retryAbort.abort();
        await expect(retry).rejects.toThrow('Permission request aborted');
    });

    it('completes UI-only responses when agent state still has the request', async () => {
        const { coordinator, session, store } = createHarness();
        const permissionSuggestions = [{ behavior: 'allow', tool: 'AskUserQuestion' }];

        store.publishRequest({
            requestId: 'agent-state-only',
            toolName: 'AskUserQuestion',
            toolInput: { questions: [{ id: 'q1' }] },
            createdAt: 500,
            kind: 'user_action',
            permissionSuggestions,
        });

        await expect(
            coordinator.handleResponse({
                requestId: 'agent-state-only',
                buildCompletion: (context) => {
                    expect(context).toEqual(
                        expect.objectContaining({
                            requestId: 'agent-state-only',
                            correlation: 'agent_state',
                            status: 'agent_state_only',
                            toolName: 'AskUserQuestion',
                            permissionSuggestions,
                        }),
                    );
                    return {
                        result: { decision: 'approved', answers: { q1: 'yes' } },
                        completedRequest: {
                            status: 'approved',
                            decision: 'approved',
                            extraCompletedFields: { answers: { q1: 'yes' } },
                        },
                    };
                },
            }),
        ).resolves.toBe(true);

        expect(session.agentState.requests!['agent-state-only']).toBeUndefined();
        expect(session.agentState.completedRequests!['agent-state-only']).toEqual(
            expect.objectContaining({
                tool: 'AskUserQuestion',
                kind: 'user_action',
                status: 'approved',
                answers: { q1: 'yes' },
                permissionSuggestions,
            }),
        );
    });

    it('passes response target metadata through publish and fallback completion', async () => {
        const { coordinator, session } = createHarness();
        const permissionSuggestions = [{ behavior: 'allow', tool: 'Bash' }];

        const pending = coordinator.requestDecision({
            ...bashRequest,
            responseTarget: {
                kind: 'test_target',
                requestOwner: 'owner-1',
            },
            subagentRef: {
                runId: 'run-1',
                callId: 'call-1',
            },
            sidechainId: 'sidechain-1',
            permissionSuggestions,
        });

        expect(session.agentState.requests![bashRequest.requestId]).toEqual(
            expect.objectContaining({
                responseTarget: {
                    kind: 'test_target',
                    requestOwner: 'owner-1',
                },
                subagentRef: {
                    runId: 'run-1',
                    callId: 'call-1',
                },
                sidechainId: 'sidechain-1',
                permissionSuggestions,
            }),
        );

        await expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: (context) => {
                    expect(context).toEqual(
                        expect.objectContaining({
                            responseTarget: {
                                kind: 'test_target',
                                requestOwner: 'owner-1',
                            },
                            subagentRef: {
                                runId: 'run-1',
                                callId: 'call-1',
                            },
                            sidechainId: 'sidechain-1',
                            permissionSuggestions,
                        }),
                    );
                    return {
                        result: approve(context.requestId),
                        completedRequest: { status: 'approved', decision: 'approved' },
                    };
                },
            }),
        ).resolves.toBe(true);

        await expect(pending).resolves.toEqual(approve());
        expect(session.agentState.completedRequests![bashRequest.requestId]).toEqual(
            expect.objectContaining({
                responseTarget: {
                    kind: 'test_target',
                    requestOwner: 'owner-1',
                },
                subagentRef: {
                    runId: 'run-1',
                    callId: 'call-1',
                },
                sidechainId: 'sidechain-1',
                permissionSuggestions,
            }),
        );
    });

    it('does not reuse a completed live decision for a later same-id retry', async () => {
        const { coordinator, session } = createHarness();

        const first = coordinator.requestDecision(bashRequest);
        await expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: () => ({
                    result: approve(),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).resolves.toBe(true);

        await expect(first).resolves.toEqual(approve());
        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();

        const retryAbort = new AbortController();
        const retry = coordinator.requestDecision(bashRequest, { signal: retryAbort.signal });

        expect(await settledState(retry)).toBe('pending');
        expect(session.agentState.requests![bashRequest.requestId]).toEqual(
            expect.objectContaining({
                tool: 'Bash',
                arguments: bashRequest.toolInput,
            }),
        );

        retryAbort.abort();
        await expect(retry).rejects.toThrow('Permission request aborted');
    });

    it('ignores uncorrelated responses without building a completion', async () => {
        const { coordinator, session } = createHarness();
        let built = false;

        await expect(
            coordinator.handleResponse({
                requestId: 'stale',
                buildCompletion: () => {
                    built = true;
                    return {
                        result: approve('stale'),
                        completedRequest: { status: 'approved', decision: 'approved' },
                    };
                },
            }),
        ).resolves.toBe(false);

        expect(built).toBe(false);
        expect(Object.keys(session.agentState.completedRequests ?? {})).toEqual([]);
    });

    it('clears cached in-flight approval state on lifecycle cancellation', async () => {
        const session = new DeferredUpdateSession();
        const { coordinator } = createHarness(session);
        const abort = new AbortController();

        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        session.deferNextUpdate();
        const handled = coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: () => ({
                result: approve(),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        });
        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');
        await Promise.resolve();
        await Promise.resolve();
        session.resolveDeferredUpdate();
        await expect(handled).resolves.toBe(true);

        await coordinator.cancelAll('Session ended');

        const retryAbort = new AbortController();
        const retry = coordinator.requestDecision(bashRequest, { signal: retryAbort.signal });
        expect(await settledState(retry)).toBe('pending');
        expect(session.agentState.requests![bashRequest.requestId]).toEqual(
            expect.objectContaining({
                tool: 'Bash',
                arguments: bashRequest.toolInput,
            }),
        );

        retryAbort.abort();
        await expect(retry).rejects.toThrow('Permission request aborted');
        await coordinator.dispose();
    });

    it('cancels only pending requests owned by a deactivated plugin', async () => {
        const { coordinator, session } = createHarness();
        const pluginARequest = {
            ...bashRequest,
            requestId: 'plugin-a-request',
            owner: {
                kind: 'plugin',
                pluginId: 'plugin-a',
                runtimeId: 'runtime-a',
            },
        } as const;
        const pluginBRequest = {
            ...bashRequest,
            requestId: 'plugin-b-request',
            owner: {
                kind: 'plugin',
                pluginId: 'plugin-b',
                runtimeId: 'runtime-b',
            },
        } as const;

        const pluginAPending = coordinator.requestDecision(pluginARequest);
        const pluginBPending = coordinator.requestDecision(pluginBRequest);

        coordinator.cancelByPlugin('plugin-a', 'plugin_deactivated');

        await expect(pluginAPending).rejects.toThrow('plugin_deactivated');
        expect(await settledState(pluginBPending)).toBe('pending');
        expect(Object.keys(session.agentState.requests ?? {}).sort()).toEqual(['plugin-b-request']);
        expect(session.agentState.requests!['plugin-b-request']).toEqual(
            expect.objectContaining({
                tool: 'Bash',
                owner: {
                    kind: 'plugin',
                    pluginId: 'plugin-b',
                    runtimeId: 'runtime-b',
                },
            }),
        );
        expect(session.agentState.completedRequests!['plugin-a-request']).toEqual(
            expect.objectContaining({
                status: 'canceled',
                reason: 'plugin_deactivated',
                owner: {
                    kind: 'plugin',
                    pluginId: 'plugin-a',
                    runtimeId: 'runtime-a',
                },
            }),
        );

        await expect(
            coordinator.handleResponse({
                requestId: 'plugin-b-request',
                buildCompletion: () => ({
                    result: approve('plugin-b-request'),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).resolves.toBe(true);
        await expect(pluginBPending).resolves.toEqual(approve('plugin-b-request'));
    });

    it('does not merge duplicate request ids across different plugin owners', async () => {
        const { coordinator, session } = createHarness();
        const pluginARequest = {
            ...bashRequest,
            requestId: 'shared-request',
            owner: {
                kind: 'plugin',
                pluginId: 'plugin-a',
                runtimeId: 'runtime-a',
            },
        } as const;
        const pluginBRequest = {
            ...bashRequest,
            requestId: 'shared-request',
            owner: {
                kind: 'plugin',
                pluginId: 'plugin-b',
                runtimeId: 'runtime-b',
            },
        } as const;

        const first = coordinator.requestDecision(pluginARequest);
        const second = coordinator.requestDecision(pluginBRequest);

        await expect(second).rejects.toThrow('different owner or tool input');
        expect(session.agentState.requests!['shared-request']).toEqual(
            expect.objectContaining({
                owner: {
                    kind: 'plugin',
                    pluginId: 'plugin-a',
                    runtimeId: 'runtime-a',
                },
            }),
        );

        await coordinator.cancelAll('cleanup');
        await Promise.allSettled([first, second]);
    });

    it('does not merge a source-owned request with a same-id request lacking that provenance', async () => {
        const { coordinator } = createHarness();
        const sourceOwned = coordinator.requestDecision({
            ...bashRequest,
            requestId: 'source-owned-request',
            source: 'claude_unified_terminal_dialog_choice',
        });
        const unownedDuplicate = coordinator.requestDecision({
            ...bashRequest,
            requestId: 'source-owned-request',
        });

        await expect(unownedDuplicate).rejects.toThrow('different owner or tool input');

        await coordinator.cancelAll('cleanup');
        await Promise.allSettled([sourceOwned, unownedDuplicate]);
    });

    it('does not reuse a terminally cancelled plugin decision for a later request', async () => {
        const { coordinator, session } = createHarness();
        const abort = new AbortController();
        const pluginARequest = {
            ...bashRequest,
            requestId: 'cached-shared-request',
            owner: {
                kind: 'plugin',
                pluginId: 'plugin-a',
                runtimeId: 'runtime-a',
            },
        } as const;
        const pluginBRequest = {
            ...bashRequest,
            requestId: 'plugin-b-after-cancel',
            owner: {
                kind: 'plugin',
                pluginId: 'plugin-b',
                runtimeId: 'runtime-b',
            },
            createdAt: 300,
        } as const;

        const pending = coordinator.requestDecision(pluginARequest, { signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');

        await expect(
            coordinator.handleResponse({
                requestId: pluginARequest.requestId,
                buildCompletion: () => ({
                    result: approve(pluginARequest.requestId),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).resolves.toBe(false);

        const retry = coordinator.requestDecision(pluginBRequest);

        expect(await settledState(retry)).toBe('pending');
        expect(session.agentState.requests![pluginBRequest.requestId]).toEqual(
            expect.objectContaining({
                owner: {
                    kind: 'plugin',
                    pluginId: 'plugin-b',
                    runtimeId: 'runtime-b',
                },
                createdAt: 300,
            }),
        );

        await coordinator.cancelAll('cleanup');
        await Promise.allSettled([retry]);
    });

    it('keeps pending requests unresolved until an explicit decision arrives even after timers advance', async () => {
        vi.useFakeTimers();
        const { coordinator, session } = createHarness();

        const pending = coordinator.requestDecision(bashRequest);

        await vi.advanceTimersByTimeAsync(60_000);

        expect(await settledState(pending)).toBe('pending');
        expect(session.agentState.requests![bashRequest.requestId]).toEqual(
            expect.objectContaining({
                tool: 'Bash',
                arguments: bashRequest.toolInput,
            }),
        );

        await coordinator.cancelAll('Session ended');
        await expect(pending).rejects.toThrow('Session ended');
    });
});
