import { describe, expect, it, vi } from 'vitest';

import {
    CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
    CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
} from '@happier-dev/agents';
import type { AgentState } from '@/api/types';
import { InvalidAskUserQuestionInputError } from '@/agent/questions/normalizeAskUserQuestionInput';
import { AgentStateRequestStore } from './agentStateRequestStore';

class FakeSession {
    sessionId = 'session-test';
    agentState: AgentState = {
        requests: Object.create(null),
        completedRequests: Object.create(null),
    };
    updateCount = 0;

    getAgentStateSnapshot() {
        return this.agentState;
    }

    updateAgentState(updater: (state: AgentState) => AgentState) {
        this.updateCount += 1;
        this.agentState = updater(this.agentState);
    }
}

class DeferredSession extends FakeSession {
    pendingUpdater: ((state: AgentState) => AgentState) | null = null;

    override updateAgentState(updater: (state: AgentState) => AgentState) {
        this.updateCount += 1;
        this.pendingUpdater = updater;
    }

    flushAgentStateUpdate() {
        const updater = this.pendingUpdater;
        this.pendingUpdater = null;
        if (updater) this.agentState = updater(this.agentState);
    }
}

describe('AgentStateRequestStore', () => {
    it('rejects oversized direct AskUserQuestion publication before state or push side effects', () => {
        const session = new FakeSession();
        const sendToAllDevicesAsync = vi.fn(async () => {});
        const pushSender = { sendToAllDevicesAsync };
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]', pushSender });
        const toolInput = { questions: [{ question: 'x'.repeat(16_385), options: [] }] };

        expect(() => store.publishRequest({
            requestId: 'oversized',
            toolName: 'ask_user_question',
            toolInput,
            createdAt: 1,
        })).toThrow(InvalidAskUserQuestionInputError);
        expect(session.updateCount).toBe(0);
        expect(session.agentState.requests!.oversized).toBeUndefined();
        expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    });

    it('publishes a detached AskUserQuestion snapshot when the session applies its update later', () => {
        const session = new DeferredSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        const toolInput = {
            provider: { correlation: 'original' },
            questions: [{ question: 'Original?', options: [{ label: 'Original' }] }],
        };

        store.publishRequest({
            requestId: 'deferred',
            toolName: 'AskUserQuestion',
            toolInput,
            createdAt: 1,
        });
        toolInput.provider.correlation = 'mutated';
        toolInput.questions[0]!.question = 'Mutated?';
        toolInput.questions[0]!.options[0]!.label = 'Mutated';
        session.flushAgentStateUpdate();

        expect(session.agentState.requests!.deferred?.arguments).toEqual({
            provider: { correlation: 'original' },
            questions: [{ question: 'Original?', options: [{ label: 'Original' }] }],
        });
    });
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

    it('cancels all outstanding requests with an optional terminal decision', () => {
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
            decision: 'abort',
        });

        expect(Object.keys(session.agentState.requests ?? {})).toEqual([]);
        expect(Object.keys(session.agentState.completedRequests ?? {}).sort()).toEqual(['req-1', 'req-2']);
        expect(session.agentState.completedRequests!['req-1']).toEqual(
            expect.objectContaining({ status: 'canceled', reason: 'Session ended', decision: 'abort' }),
        );
        expect(session.agentState.completedRequests!['req-2']).toEqual(
            expect.objectContaining({ status: 'canceled', reason: 'Session ended', decision: 'abort' }),
        );
    });

    it('skips publishing a generated local-bridge request covered by a recent canonical bridge cancellation', () => {
        const session = new FakeSession();
        const question = { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] };
        session.agentState.completedRequests!.toolu_canonical = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            arguments: question,
            createdAt: 1,
            completedAt: 10_000,
            status: 'canceled',
            reason: CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
            source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
        } as any;
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });

        store.publishRequest({
            requestId: 'perm_generated',
            toolName: 'AskUserQuestion',
            toolInput: question,
            createdAt: 10_500,
            kind: 'user_action',
            source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
        });

        expect(session.agentState.requests!.perm_generated).toBeUndefined();
    });
});
