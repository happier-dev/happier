import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { InvalidAskUserQuestionInputError } from '@/agent/questions/normalizeAskUserQuestionInput';

import type { AgentState } from '@/api/types';
import { AgentStateRequestStore } from './agentStateRequestStore';
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

    async updateAgentStateRequestSettlement(
        updater: Parameters<FakeSession['updateAgentState']>[0],
    ): Promise<void> {
        this.agentState = updater(this.agentState);
    }


    updateAgentState(updater: (state: AgentState) => AgentState) {
        this.agentState = updater(this.agentState);
    }
}

type TestPermissionResult = Readonly<{ decision: string; answers?: Readonly<Record<string, string>> }>;

function createHarness() {
    const session = new FakeSession();
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
    it.each(['admitted', 'failed'] as const)('preserves a replacement occurrence after an older cancelAll is %s', async (outcome) => {
        const { coordinator, session } = createHarness();
        const original = coordinator.requestDecision(bashRequest);
        const originalRejected = expect(original).rejects.toThrow('retired old request');
        let admit!: () => void;
        let fail!: (error: Error) => void;
        session.updateAgentStateRequestSettlement = async (updater) => {
            updater(session.agentState); // Capture before disk admission; replay still uses current state.
            await new Promise<void>((resolve, reject) => { admit = resolve; fail = reject; });
            // Non-ACK admission does not run the later transport replay here.
        };
        const cancellation = coordinator.cancelAll('old reset');
        const cancellationResult = outcome === 'admitted'
            ? expect(cancellation).resolves.toBeUndefined()
            : expect(cancellation).rejects.toThrow('journal unavailable');
        coordinator.cancelRequest(bashRequest.requestId, 'retired old request');
        await originalRejected;
        const replacement = coordinator.requestDecision({ ...bashRequest, toolInput: { command: ['echo replacement'] }, createdAt: 101 });
        void replacement.catch(() => undefined);
        if (outcome === 'admitted') admit();
        else fail(new Error('journal unavailable'));
        await cancellationResult;
        expect(coordinator.getResponseContext(bashRequest.requestId)).toMatchObject({ status: 'live', createdAt: 101 });
        const context = coordinator.getResponseContext(bashRequest.requestId)!;
        expect(await coordinator.completeRpcResponse({ context, completion: { result: approve(), completedRequest: { status: 'approved' } } })).toBe(true);
        await expect(replacement).resolves.toEqual(approve());
    });

    it.each(['toolu_test', 'next-turn'] as const)('retains the newer %s cached decision when an older cancellation completes', async (nextId) => {
        const { coordinator, session } = createHarness();
        const original = coordinator.requestDecision(bashRequest);
        const originalRejected = expect(original).rejects.toThrow('retired old request');
        let admit!: () => void;
        session.updateAgentStateRequestSettlement = async (updater) => {
            updater(session.agentState); // Capture before disk admission; replay still uses current state.
            await new Promise<void>((resolve) => { admit = resolve; });
            // Non-ACK admission does not run the later transport replay here.
        };
        const cancellation = coordinator.cancelAll('old reset');
        coordinator.cancelRequest(bashRequest.requestId, 'retired old request');
        await originalRejected;
        const request = { ...bashRequest, requestId: nextId, createdAt: 101, toolInput: { command: ['echo next'] } };
        const next = coordinator.requestDecision(request);
        const context = coordinator.getResponseContext(nextId)!;
        await coordinator.completeRpcResponse({ context, completion: { result: approve(nextId), completedRequest: { status: 'approved' } } });
        await expect(next).resolves.toEqual(approve(nextId));
        admit();
        await cancellation;
        const cached = coordinator.requestDecision(request);
        expect(coordinator.getLocallyOwnedLiveResponseContext(nextId)).toBeNull();
        await expect(cached).resolves.toEqual(approve(nextId));
    });

    it('does not detach a replacement waiter when an older concurrent cancellation admission fails', async () => {
        const { coordinator, session } = createHarness();
        const original = coordinator.requestDecision(bashRequest);
        const admissions: { admit: () => void; fail: () => void }[] = [];
        session.updateAgentStateRequestSettlement = async (updater) => {
            const updated = updater(session.agentState);
            await new Promise<void>((resolve, reject) => {
                admissions.push({ admit: resolve, fail: () => reject(new Error('journal unavailable')) });
            });
            session.agentState = updated;
        };
        const context = coordinator.getResponseContext(bashRequest.requestId)!;
        const first = coordinator.completeCancellationResponse({ context, result: { decision: 'abort' }, reason: 'stopped' });
        const second = coordinator.completeCancellationResponse({ context, result: { decision: 'abort' }, reason: 'stopped' });
        const secondFailure = expect(second).rejects.toThrow('journal unavailable');
        expect(admissions).toHaveLength(2);
        admissions[0]!.admit();
        await expect(first).resolves.toBe(true);
        await expect(original).resolves.toEqual({ decision: 'abort' });

        const replacement = coordinator.requestDecision({ ...bashRequest, createdAt: 101 });
        let replacementSettled = false;
        void replacement.then(() => { replacementSettled = true; }, () => { replacementSettled = true; });
        admissions[1]!.fail();
        await secondFailure;
        expect(coordinator.getResponseContext(bashRequest.requestId)).toMatchObject({ status: 'live', createdAt: 101 });
        expect(replacementSettled).toBe(false);
        expect(session.agentState.requests?.[bashRequest.requestId]?.createdAt).toBe(101);
        coordinator.cancelRequest(bashRequest.requestId, 'test cleanup');
        await expect(replacement).rejects.toThrow('test cleanup');
    });

    it('does not grant an in-flight UI approval while a single lifecycle cancellation is admitted', async () => {
        const { coordinator, session } = createHarness();
        const provider = coordinator.requestDecision(bashRequest);
        let acknowledge!: () => void;
        const acknowledgement = new Promise<void>((resolve) => { acknowledge = resolve; });
        let admitCancellation!: () => void;
        const cancellationAdmission = new Promise<void>((resolve) => { admitCancellation = resolve; });
        session.updateAgentState = async (updater) => {
            const updated = updater(session.agentState);
            await acknowledgement;
            session.agentState = updated;
        };
        session.updateAgentStateRequestSettlement = async (updater) => {
            updater(session.agentState);
            await cancellationAdmission;
        };
        const context = coordinator.getResponseContext(bashRequest.requestId)!;
        let granted = false;
        const approval = coordinator.completeRpcResponse({
            context,
            completion: { result: approve(), completedRequest: { status: 'approved' } },
            onAdmitted: () => { granted = true; },
        });
        const canceled = { decision: 'abort' };
        const cancellation = coordinator.completeCancellationResponse({ context, result: canceled, reason: 'stopped' });
        acknowledge();
        try {
            await approval;
            expect(granted).toBe(false);
        } finally {
            admitCancellation();
            await cancellation;
        }
        await expect(provider).resolves.toEqual(canceled);
    });

    it('does not apply an approval after cancellation retired its pending entry', async () => {
        const { coordinator, session } = createHarness();
        const pending = coordinator.requestDecision(bashRequest);
        let approveAdmission!: () => void;
        const acknowledgement = new Promise<void>((resolve) => { approveAdmission = resolve; });
        const apply = session.updateAgentState.bind(session);
        session.updateAgentState = async (updater) => { await acknowledgement; apply(updater); };
        const rejected = expect(pending).rejects.toThrow('canceled');
        let granted = false;
        coordinator.completeResponse({
            context: coordinator.getResponseContext(bashRequest.requestId)!,
            completion: { result: approve(), completedRequest: { status: 'approved' } },
            onAdmitted: () => { granted = true; },
        });
        await coordinator.cancelAll('canceled');
        await rejected;
        approveAdmission();
        await Promise.resolve();
        await Promise.resolve();
        expect(granted).toBe(false);
    });
    it('does not grant approval while its cancellation is awaiting durable admission', async () => {
        const { coordinator, session } = createHarness();
        const pending = coordinator.requestDecision(bashRequest);
        const admissions = new Map<string, () => void>();
        const apply = session.updateAgentState.bind(session);
        session.updateAgentState = async (updater) => {
            await new Promise<void>((resolve) => { admissions.set('approved', resolve); });
            apply(updater);
        };
        session.updateAgentStateRequestSettlement = async (updater) => {
            await new Promise<void>((resolve) => { admissions.set('canceled', resolve); });
            apply(updater);
        };
        const rejected = expect(pending).rejects.toThrow('canceled');
        let granted = false;
        coordinator.completeResponse({
            context: coordinator.getResponseContext(bashRequest.requestId)!,
            completion: { result: approve(), completedRequest: { status: 'approved' } },
            onAdmitted: () => { granted = true; },
        });
        const cancellation = coordinator.cancelAll('canceled');
        admissions.get('approved')!();
        await Promise.resolve();
        await Promise.resolve();
        expect(granted).toBe(false);
        admissions.get('canceled')!();
        await cancellation;
        await rejected;
    });
    it('does not release a provider waiter claimed while durable admission is pending', async () => {
        const { coordinator, session } = createHarness();
        const pending = coordinator.requestDecision(bashRequest);
        let admit!: () => void;
        const acknowledgement = new Promise<void>((resolve) => { admit = resolve; });
        const apply = session.updateAgentState.bind(session);
        session.updateAgentState = async (updater) => { await acknowledgement; apply(updater); };
        let resumed = false;
        void pending.then(() => { resumed = true; }, () => {});
        const context = coordinator.getResponseContext(bashRequest.requestId)!;
        coordinator.completeResponse({ context, completion: { result: approve(), completedRequest: { status: 'approved' } } });
        const claimed = {
            ...session.agentState.requests![bashRequest.requestId]!,
            permissionResponseClaimV1: { owner: 'another-runtime' },
        };
        session.agentState.requests![bashRequest.requestId] = claimed;
        admit();
        await Promise.resolve();
        await Promise.resolve();
        expect(resumed).toBe(false);
        coordinator.cancelRequest(bashRequest.requestId, 'test cleanup');
        await expect(pending).rejects.toThrow('test cleanup');
    });
    it('holds the provider waiter until request settlement obtains durable custody', async () => {
        const { coordinator, session } = createHarness();
        const provider = coordinator.requestDecision(bashRequest);
        let admit!: () => void;
        const acknowledgement = new Promise<void>((resolve) => { admit = resolve; });
        const apply = session.updateAgentState.bind(session);
        session.updateAgentState = async (updater) => { await acknowledgement; apply(updater); };
        let providerResumed = false;
        void provider.then(() => { providerResumed = true; });
        const context = coordinator.getResponseContext(bashRequest.requestId)!;
        expect(coordinator.completeResponse({ context, completion: {
            result: approve(), completedRequest: { status: 'approved' },
        } })).toBe(true);
        await Promise.resolve();
        expect(providerResumed).toBe(false);
        admit();
        await expect(provider).resolves.toEqual(approve());
    });
    it.each(['native', 'rpc'] as const)('rejects canceled provider waiters after admission failure and fences a late %s approval before writing', async (channel) => {
        const { coordinator, session } = createHarness();
        const provider = coordinator.requestDecision(bashRequest);
        let outcome = 'pending';
        void provider.then(() => { outcome = 'approved'; }, () => { outcome = 'canceled'; });
        const admit = session.updateAgentStateRequestSettlement.bind(session);
        session.updateAgentStateRequestSettlement = async () => { throw new Error('journal unavailable'); };
        await expect(coordinator.cancelAll('stopped')).rejects.toThrow('journal unavailable');
        await Promise.resolve();
        expect(outcome).toBe('canceled');
        expect(coordinator.getResponseContext(bashRequest.requestId)).toMatchObject({ status: 'detached' });
        const beforeApproval = structuredClone(session.agentState);
        const response = {
            context: coordinator.getResponseContext(bashRequest.requestId)!,
            completion: { result: approve(), completedRequest: { status: 'approved' } },
        };
        if (channel === 'rpc') await expect(coordinator.completeRpcResponse(response)).resolves.toBe(false);
        else expect(coordinator.completeResponse(response)).toBe(false);
        expect(session.agentState).toEqual(beforeApproval);
        expect(session.agentState.requests?.[bashRequest.requestId]).toBeDefined();
        expect(session.agentState.completedRequests?.[bashRequest.requestId]).toBeUndefined();
        session.updateAgentStateRequestSettlement = admit;
        await coordinator.cancelAll('stopped');
        expect(session.agentState.completedRequests?.[bashRequest.requestId]).toMatchObject({ status: 'canceled' });
        expect(coordinator.getResponseContext(bashRequest.requestId)).toBeNull();
    });

    it.each(['rebase', 'returned-outcome'] as const)('does not grant a pre-effect approval superseded during the acknowledged write (%s)', async (conflict) => {
        const { coordinator, session } = createHarness();
        const provider = coordinator.requestDecision(bashRequest);
        void provider.catch(() => {});
        let granted = false;
        session.updateAgentState = async (updater) => {
            // Simulate a CAS attempt followed by the newer authoritative server snapshot.
            updater(session.agentState);
            session.agentState = { requests: {}, completedRequests: {
                [bashRequest.requestId]: {
                    tool: bashRequest.toolName, arguments: bashRequest.toolInput,
                    createdAt: bashRequest.createdAt, completedAt: Date.now() + 1, status: 'denied',
                },
            } };
            if (conflict === 'rebase') session.agentState = updater(session.agentState);
        };
        await expect(coordinator.completeRpcResponse({
            context: coordinator.getResponseContext(bashRequest.requestId)!,
            completion: { result: approve(), completedRequest: { status: 'approved' } },
            onAdmitted: () => { granted = true; },
        })).rejects.toThrow();
        expect(granted).toBe(false);
        expect(session.agentState.completedRequests?.[bashRequest.requestId]).toMatchObject({ status: 'denied' });
        coordinator.cancelRequest(bashRequest.requestId, 'cleanup');
    });

    it('rejects invalid AskUserQuestion input before request publication or waiter insertion', async () => {
        const { coordinator, session } = createHarness();
        const invalid = {
            requestId: 'invalid-question',
            toolName: 'ask_user_question',
            toolInput: { questions: [{ question: 'x'.repeat(16_385), options: [] }] },
            createdAt: 1,
        };

        expect(() => coordinator.requestDecision(invalid)).toThrow(InvalidAskUserQuestionInputError);
        expect(session.agentState.requests!['invalid-question']).toBeUndefined();
        expect(coordinator.getResponseContext('invalid-question')).toBeNull();

        const valid = coordinator.requestDecision({
            ...invalid,
            toolInput: { questions: [{ question: 'Choose?', options: [{ label: 'A' }] }] },
        });
        expect(coordinator.getResponseContext('invalid-question')).toEqual(expect.objectContaining({ status: 'live' }));
        coordinator.cancelRequest('invalid-question', 'test complete');
        await expect(valid).rejects.toThrow('test complete');
    });

    it('rolls back the pending record when publication rejects a second-pass input check', async () => {
        let rejectPublication = true;
        let publishCount = 0;
        const coordinator = createPermissionRequestCoordinator<TestPermissionResult>({
            store: {
                publishRequest: () => {
                    publishCount += 1;
                    if (rejectPublication) throw new InvalidAskUserQuestionInputError();
                },
                completeRequest: async () => {},
                hasOutstandingRequest: () => false,
                isOutstandingRequestClaimed: () => false,
                readOutstandingRequest: () => null,
            },
        });
        const request = {
            requestId: 'second-pass-invalid',
            toolName: 'ask_user_question',
            toolInput: { questions: [{ question: 'Choose?', options: [{ label: 'A' }] }] },
            createdAt: 1,
        };

        expect(() => coordinator.requestDecision(request)).toThrow(InvalidAskUserQuestionInputError);
        expect(coordinator.getResponseContext(request.requestId)).toBeNull();

        rejectPublication = false;
        const retry = coordinator.requestDecision(request);
        expect(publishCount).toBe(2);
        expect(coordinator.getResponseContext(request.requestId)).toEqual(expect.objectContaining({ status: 'live' }));
        coordinator.cancelRequest(request.requestId, 'test complete');
        await expect(retry).rejects.toThrow('test complete');
    });

    it('fences opaque claims from persisted and already-live coordinator response paths', async () => {
        const { coordinator, session } = createHarness();
        const opaqueClaim = { malformed: [true, { unexpected: 'shape' }] };

        const claimedRequest: NonNullable<AgentState['requests']>[string] & Record<'permissionResponseClaimV1', unknown> = {
            tool: 'Bash',
            kind: 'permission',
            arguments: bashRequest.toolInput,
            createdAt: 1,
            permissionResponseClaimV1: opaqueClaim,
        };
        session.agentState.requests!.persisted = claimedRequest;

        expect(coordinator.getResponseContext('persisted')).toBeNull();
        await expect(coordinator.requestDecision({ ...bashRequest, requestId: 'persisted' })).rejects.toThrow(/reserved/i);
        expect(coordinator.handleResponse({
            requestId: 'persisted',
            buildCompletion: () => ({
                result: approve('persisted'),
                completedRequest: { status: 'approved', decision: 'approved_for_session', allowedTools: ['Bash(*)'] },
            }),
        })).toBe(false);
        expect(session.agentState.completedRequests!.persisted).toBeUndefined();

        const controller = new AbortController();
        const live = coordinator.requestDecision({ ...bashRequest, requestId: 'live-claim' }, { signal: controller.signal });
        const staleContext = coordinator.getResponseContext('live-claim');
        expect(staleContext).not.toBeNull();
        (session.agentState.requests!['live-claim'] as Record<string, unknown>).permissionResponseClaimV1 = opaqueClaim;

        expect(coordinator.getResponseContext('live-claim')).toBeNull();
        expect(coordinator.completeResponse({
            context: staleContext!,
            completion: {
                result: approve('live-claim'),
                completedRequest: { status: 'approved', decision: 'approved_for_session', allowedTools: ['Bash(*)'] },
            },
        })).toBe(false);

        controller.abort();
        await expect(live).rejects.toThrow('Permission request aborted');
        coordinator.cancelAll('reset after claim');

        const retained = session.agentState.requests!['live-claim'] as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(retained, 'permissionResponseClaimV1')).toBe(true);
        expect(retained.permissionResponseClaimV1).toBe(opaqueClaim);
        expect(session.agentState.completedRequests!['live-claim']).toBeUndefined();
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

        expect(handled).toBe(true);
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

        expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: () => ({
                    result: approve(),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).toBe(true);

        await expect(second).resolves.toEqual(approve());
    });

    it('exposes structured-response ownership only while a local waiter is live', async () => {
        const { coordinator, session } = createHarness();
        const abort = new AbortController();
        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        const occurrenceId = session.agentState.requests?.[bashRequest.requestId]?.occurrenceId;
        expect(occurrenceId).toEqual(expect.any(String));
        expect(coordinator.getLocallyOwnedLiveResponseContext(bashRequest.requestId, 'stale-occurrence')).toBeNull();
        expect(coordinator.getLocallyOwnedLiveResponseContext(bashRequest.requestId, occurrenceId)).toEqual(
            expect.objectContaining({
                requestId: bashRequest.requestId,
                correlation: 'record',
                status: 'live',
            }),
        );

        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');
        expect(coordinator.getLocallyOwnedLiveResponseContext(bashRequest.requestId)).toBeNull();
    });

    it('retains all-aborted requests as detached and satisfies a compatible same-id retry after late approval', async () => {
        const { coordinator, session } = createHarness();
        const abort = new AbortController();

        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        abort.abort();

        await expect(pending).rejects.toThrow('Permission request aborted');
        expect(coordinator.getResponseContext(bashRequest.requestId)).toEqual(
            expect.objectContaining({
                requestId: bashRequest.requestId,
                status: 'detached',
                correlation: 'record',
                toolName: 'Bash',
                toolInput: bashRequest.toolInput,
            }),
        );

        expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: (context) => ({
                    result: approve(context.requestId),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).toBe(true);

        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();
        expect(session.agentState.completedRequests![bashRequest.requestId]).toEqual(
            expect.objectContaining({ status: 'approved', decision: 'approved' }),
        );

        await expect(coordinator.requestDecision(bashRequest)).resolves.toEqual(approve());
        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();
    });

    it('keeps a failed detached UI response retryable and waits for persistence after reattachment', async () => {
        const { coordinator, session } = createHarness();
        const abort = new AbortController();
        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');

        const completion = {
            result: approve(),
            completedRequest: { status: 'approved', decision: 'approved' },
        };
        const updateState = session.updateAgentState.bind(session);
        session.updateAgentState = async () => { throw new Error('state transport unavailable'); };
        await expect(coordinator.completeRpcResponse({
            context: coordinator.getResponseContext(bashRequest.requestId)!, completion,
        })).rejects.toThrow('state transport unavailable');
        expect(coordinator.getResponseContext(bashRequest.requestId)).toMatchObject({
            status: 'detached', correlation: 'record',
        });
        expect(session.agentState.completedRequests![bashRequest.requestId]).toBeUndefined();

        let release!: () => void;
        const acknowledgement = new Promise<void>((resolve) => { release = resolve; });
        session.updateAgentState = async (updater) => {
            await acknowledgement;
            updateState(updater);
        };
        const response = coordinator.completeRpcResponse({
            context: coordinator.getResponseContext(bashRequest.requestId)!, completion,
        });
        const retry = coordinator.requestDecision(bashRequest);
        expect(await settledState(retry)).toBe('pending');
        expect(session.agentState.requests![bashRequest.requestId]).toBeDefined();
        release();
        await expect(response).resolves.toBe(true);
        await expect(retry).resolves.toEqual(approve());
        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();
    });

    it('replays a late cached decision for multiple compatible same-id retry callers', async () => {
        const { coordinator, session } = createHarness();
        const abort = new AbortController();

        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');

        expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: (context) => ({
                    result: approve(context.requestId),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).toBe(true);

        await expect(coordinator.requestDecision(bashRequest)).resolves.toEqual(approve());
        await expect(coordinator.requestDecision(bashRequest)).resolves.toEqual(approve());
        expect(session.agentState.requests![bashRequest.requestId]).toBeUndefined();
    });

    it('does not consume a cached decision when the same id is retried with different input', async () => {
        const { coordinator, session } = createHarness();
        const abort = new AbortController();

        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');

        expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: () => ({
                    result: approve(),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).toBe(true);

        const retryAbort = new AbortController();
        await expect.poll(() => coordinator.getResponseContext(bashRequest.requestId)).toBeNull();
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

    it('prioritizes an incompatible pending retry over an older cached decision', async () => {
        const { coordinator } = createHarness();
        const abort = new AbortController();

        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');

        expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: () => ({
                    result: approve(),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).toBe(true);

        const incompatibleAbort = new AbortController();
        await expect.poll(() => coordinator.getResponseContext(bashRequest.requestId)).toBeNull();
        const incompatible = coordinator.requestDecision(
            {
                ...bashRequest,
                toolInput: { command: ['bash', '-lc', 'echo different'] },
            },
            { signal: incompatibleAbort.signal },
        );
        incompatibleAbort.abort();
        await expect(incompatible).rejects.toThrow('Permission request aborted');

        const originalRetryAbort = new AbortController();
        const originalRetry = coordinator.requestDecision(bashRequest, { signal: originalRetryAbort.signal });
        await expect(originalRetry).rejects.toThrow('already pending with different tool input');
    });

    it('rejects incompatible duplicate waiters while an existing request id is live', async () => {
        const { coordinator } = createHarness();

        const first = coordinator.requestDecision(bashRequest);
        const incompatible = coordinator.requestDecision({
            ...bashRequest,
            toolInput: { command: ['bash', '-lc', 'echo different'] },
        });

        await expect(incompatible).rejects.toThrow('already pending with different tool input');

        expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: () => ({
                    result: approve(),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).toBe(true);
        await expect(first).resolves.toEqual(approve());
    });

    it('rejects incompatible duplicate waiters while an existing request id is detached', async () => {
        const { coordinator } = createHarness();
        const abort = new AbortController();

        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');

        const incompatible = coordinator.requestDecision({
            ...bashRequest,
            toolInput: { command: ['bash', '-lc', 'echo different'] },
        });

        await expect(incompatible).rejects.toThrow('already pending with different tool input');
        expect(coordinator.getResponseContext(bashRequest.requestId)).toEqual(
            expect.objectContaining({
                status: 'detached',
                toolInput: bashRequest.toolInput,
            }),
        );
    });

    it('keeps a failed agent-state-only UI response retryable and preserves independent requests', async () => {
        const { coordinator, session, store } = createHarness();

        store.publishRequest({
            requestId: 'agent-state-only',
            toolName: 'AskUserQuestion',
            toolInput: { questions: [{ id: 'q1', question: 'q1' }] },
            createdAt: 500,
            kind: 'user_action',
        });
        store.publishRequest({
            requestId: 'independent', toolName: 'Bash', toolInput: { command: 'pwd' }, createdAt: 600,
        });

        const context = coordinator.getResponseContext('agent-state-only')!;
        expect(context).toMatchObject({ correlation: 'agent_state', status: 'agent_state_only' });
        const completion = {
            result: { decision: 'approved', answers: { q1: 'yes' } },
            completedRequest: {
                status: 'approved', decision: 'approved', extraCompletedFields: { answers: { q1: 'yes' } },
            },
        };
        const updateState = session.updateAgentState.bind(session);
        session.updateAgentState = async () => { throw new Error('state transport unavailable'); };
        await expect(coordinator.completeRpcResponse({ context, completion })).rejects.toThrow('state transport unavailable');
        expect(session.agentState.requests!['agent-state-only']).toBeDefined();
        expect(session.agentState.requests!.independent).toBeDefined();
        expect(session.agentState.completedRequests!['agent-state-only']).toBeUndefined();
        session.updateAgentState = updateState;

        await expect(coordinator.completeRpcResponse({ context, completion })).resolves.toBe(true);

        expect(session.agentState.requests!['agent-state-only']).toBeUndefined();
        expect(session.agentState.requests!.independent).toBeDefined();
        expect(session.agentState.completedRequests!['agent-state-only']).toEqual(
            expect.objectContaining({
                tool: 'AskUserQuestion',
                kind: 'user_action',
                status: 'approved',
                answers: { q1: 'yes' },
            }),
        );
    });

    it('ignores uncorrelated responses without building a completion', () => {
        const { coordinator, session } = createHarness();
        let built = false;

        expect(
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
        ).toBe(false);

        expect(built).toBe(false);
        expect(Object.keys(session.agentState.completedRequests ?? {})).toEqual([]);
    });

    it('clears pending detached and cached state on lifecycle cancellation', async () => {
        const { coordinator, session } = createHarness();
        const abort = new AbortController();

        const pending = coordinator.requestDecision(bashRequest, { signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toThrow('Permission request aborted');

        expect(
            coordinator.handleResponse({
                requestId: bashRequest.requestId,
                buildCompletion: () => ({
                    result: approve(),
                    completedRequest: { status: 'approved', decision: 'approved' },
                }),
            }),
        ).toBe(true);

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
        coordinator.dispose();
    });

    it('does not use timer APIs for permission correctness', () => {
        const currentDir = dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(join(currentDir, 'permissionRequestCoordinator.ts'), 'utf8');

        expect(source).not.toContain('setTimeout');
        expect(source).not.toContain('setInterval');
    });
});
