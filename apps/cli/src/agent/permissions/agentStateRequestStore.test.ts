import { describe, expect, it } from 'vitest';

import type { AgentState } from '@/api/types';
import { AgentStateRequestStore } from './agentStateRequestStore';

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

class AsyncFakeSession extends FakeSession {
    override updateAgentState(updater: (state: AgentState) => AgentState): Promise<void> {
        return Promise.resolve().then(() => {
            this.agentState = updater(this.agentState);
        });
    }
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('AgentStateRequestStore', () => {
    it('publishes and completes a request', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });

        store.publishRequest({
            requestId: 'req-1',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            source: 'test-source',
        });

        expect(session.agentState.requests!['req-1']).toEqual(
            expect.objectContaining({
                tool: 'Bash',
                kind: 'permission',
                arguments: { command: ['bash', '-lc', 'echo hi'] },
                createdAt: 123,
                source: 'test-source',
            }),
        );

        store.completeRequest({
            requestId: 'req-1',
            status: 'approved',
            decision: 'approved',
            extraCompletedFields: { answers: { a: 'b' } },
        });

        expect(session.agentState.requests!['req-1']).toBeUndefined();
        expect(session.agentState.completedRequests!['req-1']).toEqual(
            expect.objectContaining({
                tool: 'Bash',
                status: 'approved',
                decision: 'approved',
                answers: { a: 'b' },
            }),
        );
    });

    it('preserves response target metadata through outstanding and completed records', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const responseTarget = {
            kind: 'test_target',
            requestOwner: 'owner-1',
        };
        const subagentRef = {
            runId: 'run-1',
            callId: 'call-1',
        };

        store.publishRequest({
            requestId: 'req-targeted',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget,
            subagentRef,
            sidechainId: 'sidechain-1',
        });

        expect(session.agentState.requests!['req-targeted']).toEqual(
            expect.objectContaining({
                responseTarget,
                subagentRef,
                sidechainId: 'sidechain-1',
            }),
        );
        expect(store.readOutstandingRequest('req-targeted')).toEqual(
            expect.objectContaining({
                responseTarget,
                subagentRef,
                sidechainId: 'sidechain-1',
            }),
        );

        store.completeRequest({
            requestId: 'req-targeted',
            status: 'approved',
            decision: 'approved',
        });

        expect(session.agentState.completedRequests!['req-targeted']).toEqual(
            expect.objectContaining({
                responseTarget,
                subagentRef,
                sidechainId: 'sidechain-1',
                status: 'approved',
                decision: 'approved',
            }),
        );
    });

    it('dispatches completed requests through the registered response target handler', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const dispatches: unknown[] = [];

        store.registerResponseTargetHandler('test_target', (dispatch) => {
            dispatches.push(dispatch);
        });
        store.publishRequest({
            requestId: 'req-dispatch',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: {
                kind: 'test_target',
                requestOwner: 'owner-1',
            },
        });

        store.completeRequest({
            requestId: 'req-dispatch',
            status: 'approved',
            decision: 'approved',
        });

        expect(dispatches).toEqual([
            expect.objectContaining({
                requestId: 'req-dispatch',
                responseTarget: expect.objectContaining({
                    kind: 'test_target',
                    requestOwner: 'owner-1',
                }),
                completedRequest: expect.objectContaining({
                    tool: 'Bash',
                    status: 'approved',
                    decision: 'approved',
                }),
            }),
        ]);
    });

    it('dispatches response target handlers after asynchronous state updates settle', async () => {
        const session = new AsyncFakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const dispatches: unknown[] = [];

        session.agentState.requests!['req-async'] = {
            tool: 'Bash',
            kind: 'permission',
            arguments: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: {
                kind: 'test_target',
                requestOwner: 'owner-1',
            },
        };
        store.registerResponseTargetHandler('test_target', (dispatch) => {
            dispatches.push(dispatch);
        });

        store.completeRequest({
            requestId: 'req-async',
            status: 'approved',
            decision: 'approved',
        });

        expect(dispatches).toEqual([]);
        await flushMicrotasks();

        expect(dispatches).toEqual([
            expect.objectContaining({
                requestId: 'req-async',
                responseTarget: expect.objectContaining({
                    kind: 'test_target',
                    requestOwner: 'owner-1',
                }),
                completedRequest: expect.objectContaining({
                    status: 'approved',
                    decision: 'approved',
                }),
            }),
        ]);
    });

    it('treats async response target handler failures as non-fatal', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        let handled = false;

        store.registerResponseTargetHandler('test_target', async () => {
            handled = true;
            throw new Error('handler failed');
        });
        store.publishRequest({
            requestId: 'req-async-handler',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: { kind: 'test_target' },
        });

        store.completeRequest({
            requestId: 'req-async-handler',
            status: 'approved',
            decision: 'approved',
        });
        await flushMicrotasks();

        expect(handled).toBe(true);
        expect(session.agentState.completedRequests!['req-async-handler']).toEqual(
            expect.objectContaining({
                status: 'approved',
                decision: 'approved',
            }),
        );
    });

    it('preserves response target metadata when recording completed requests directly', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const dispatches: unknown[] = [];

        store.registerResponseTargetHandler('test_target', (dispatch) => {
            dispatches.push(dispatch);
        });
        store.recordCompletedRequest({
            requestId: 'req-recorded',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            status: 'approved',
            decision: 'approved',
            responseTarget: {
                kind: 'test_target',
                requestOwner: 'owner-1',
            },
            subagentRef: {
                runId: 'run-1',
                callId: 'call-1',
            },
            sidechainId: 'sidechain-1',
            permissionSuggestions: [{ mode: 'allow' }],
        });

        expect(session.agentState.completedRequests!['req-recorded']).toEqual(
            expect.objectContaining({
                responseTarget: expect.objectContaining({
                    kind: 'test_target',
                    requestOwner: 'owner-1',
                }),
                subagentRef: {
                    runId: 'run-1',
                    callId: 'call-1',
                },
                sidechainId: 'sidechain-1',
                permissionSuggestions: [{ mode: 'allow' }],
            }),
        );
        expect(dispatches).toEqual([
            expect.objectContaining({
                requestId: 'req-recorded',
                responseTarget: expect.objectContaining({
                    kind: 'test_target',
                    requestOwner: 'owner-1',
                }),
            }),
        ]);
    });

    it('rejects duplicate response target handlers and unregisters only the exact handler', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const dispatches: string[] = [];
        const firstUnsubscribe = store.registerResponseTargetHandler('test_target', () => {
            dispatches.push('first');
        });

        expect(() => store.registerResponseTargetHandler('test_target', () => {
            dispatches.push('duplicate');
        })).toThrow(/test_target/);

        firstUnsubscribe();
        const secondUnsubscribe = store.registerResponseTargetHandler('test_target', () => {
            dispatches.push('second');
        });
        firstUnsubscribe();

        store.publishRequest({
            requestId: 'req-second',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: { kind: 'test_target' },
        });
        store.completeRequest({
            requestId: 'req-second',
            status: 'approved',
            decision: 'approved',
        });

        secondUnsubscribe();
        store.publishRequest({
            requestId: 'req-after-unsubscribe',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo bye'] },
            createdAt: 124,
            responseTarget: { kind: 'test_target' },
        });

        expect(() => store.completeRequest({
            requestId: 'req-after-unsubscribe',
            status: 'approved',
            decision: 'approved',
        })).not.toThrow();
        expect(dispatches).toEqual(['second']);
        expect(session.agentState.completedRequests!['req-after-unsubscribe']).toEqual(
            expect.objectContaining({
                status: 'approved',
                decision: 'approved',
            }),
        );
    });

    it('clears response target handlers when disposed', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const dispatches: unknown[] = [];

        store.registerResponseTargetHandler('test_target', (dispatch) => {
            dispatches.push(dispatch);
        });
        store.publishRequest({
            requestId: 'req-after-dispose',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 123,
            responseTarget: { kind: 'test_target' },
        });

        store.dispose();
        store.completeRequest({
            requestId: 'req-after-dispose',
            status: 'approved',
            decision: 'approved',
        });

        expect(dispatches).toEqual([]);
        expect(session.agentState.completedRequests!['req-after-dispose']).toEqual(
            expect.objectContaining({
                status: 'approved',
                decision: 'approved',
            }),
        );
    });

    it('cancels all outstanding requests', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });

        store.publishRequest({
            requestId: 'req-1',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo hi'] },
            createdAt: 1,
        });
        store.publishRequest({
            requestId: 'req-2',
            toolName: 'Write',
            toolInput: { path: '/tmp/x', content: 'hi' },
            createdAt: 2,
        });

        store.cancelAllRequests({
            reason: 'Session ended',
        });

        expect(Object.keys(session.agentState.requests ?? {})).toEqual([]);
        expect(Object.keys(session.agentState.completedRequests ?? {}).sort()).toEqual(['req-1', 'req-2']);
        expect(session.agentState.completedRequests!['req-1']).toEqual(
            expect.objectContaining({ status: 'canceled', reason: 'Session ended' }),
        );
        expect(session.agentState.completedRequests!['req-2']).toEqual(
            expect.objectContaining({ status: 'canceled', reason: 'Session ended' }),
        );
    });
});
