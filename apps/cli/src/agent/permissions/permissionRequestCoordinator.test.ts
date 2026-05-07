import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

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

    it('completes UI-only responses when agent state still has the request', () => {
        const { coordinator, session, store } = createHarness();

        store.publishRequest({
            requestId: 'agent-state-only',
            toolName: 'AskUserQuestion',
            toolInput: { questions: [{ id: 'q1' }] },
            createdAt: 500,
            kind: 'user_action',
        });

        expect(
            coordinator.handleResponse({
                requestId: 'agent-state-only',
                buildCompletion: (context) => {
                    expect(context).toEqual(
                        expect.objectContaining({
                            requestId: 'agent-state-only',
                            correlation: 'agent_state',
                            status: 'agent_state_only',
                            toolName: 'AskUserQuestion',
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
        ).toBe(true);

        expect(session.agentState.requests!['agent-state-only']).toBeUndefined();
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

        coordinator.cancelAll('Session ended');

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
