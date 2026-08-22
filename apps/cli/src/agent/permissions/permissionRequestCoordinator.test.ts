import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentState } from '@/api/types';
import { AgentStateRequestStore, type PermissionResponseClaim } from './agentStateRequestStore';
import { createPermissionRequestCoordinator } from './permissionRequestCoordinator';

class FakeSession {
    sessionId = 'session-test';
    agentState: AgentState = {
        requests: Object.create(null),
        completedRequests: Object.create(null),
    };

    getAgentStateSnapshot() {
        return this.agentState;
    }

    updateAgentState(updater: (state: AgentState) => AgentState): void | Promise<void> {
        this.agentState = updater(this.agentState);
    }
}

class DeferredUpdateSession extends FakeSession {
    private deferNext = false;
    private applyDeferredUpdate: (() => void) | null = null;
    private rejectDeferredUpdate: ((error: Error) => void) | null = null;

    deferNextUpdate(): void {
        this.deferNext = true;
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
            return Promise.reject(new Error('agent state persistence failed'));
        }
        return super.updateAgentState(updater);
    }
}

type TestPermissionResult = Readonly<{ decision: string; answers?: Readonly<Record<string, string>> }>;

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

    it('keeps a durable responder claim outstanding when lifecycle cancellation races its terminal projection', async () => {
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

        expect(await settledState(pending)).toBe('pending');
        expect(session.agentState.requests?.[bashRequest.requestId]).toEqual(expect.objectContaining({
            permissionResponseClaimV1: claim,
        }));
        expect(session.agentState.completedRequests?.[bashRequest.requestId]).toBeUndefined();
        await expect(coordinator.handleResponse({
            requestId: bashRequest.requestId,
            buildCompletion: (context) => ({
                result: approve(context.requestId),
                completedRequest: { status: 'approved', decision: 'approved' },
            }),
        })).resolves.toBe(true);
        await expect(pending).resolves.toEqual(approve(bashRequest.requestId));
        expect(session.agentState.completedRequests?.[bashRequest.requestId]).not.toHaveProperty('permissionResponseClaimV1');
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

    it('does not consume an in-flight cached decision when the same id is retried with different input', async () => {
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
        const retry = coordinator.requestDecision(
            {
                ...bashRequest,
                toolInput: { command: ['bash', '-lc', 'echo different'] },
                createdAt: 300,
            },
            { signal: retryAbort.signal },
        );

        expect(await settledState(retry)).toBe('pending');
        expect(session.agentState.requests![bashRequest.requestId]).toEqual(
            expect.objectContaining({
                arguments: { command: ['bash', '-lc', 'echo different'] },
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
