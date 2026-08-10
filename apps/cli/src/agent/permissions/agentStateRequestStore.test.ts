import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import {
    CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
    CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
} from '@happier-dev/agents';
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

describe('AgentStateRequestStore', () => {
    it('can persist private request input without forwarding it to push notification rendering', () => {
        const session = new FakeSession();
        const sendToAllDevicesAsync = vi.fn(async () => {});
        const settings = accountSettingsParse({
            notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
        });
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
            pushSender: { sendToAllDevicesAsync },
            getAccountSettings: () => settings,
        });

        store.publishRequest({
            requestId: 'private-1',
            toolName: 'AskUserQuestion',
            toolInput: { questions: [{ question: 'private terminal context' }] },
            createdAt: 123,
            notifyPush: false,
        });

        expect(session.agentState.requests!['private-1']).toMatchObject({
            arguments: { questions: [{ question: 'private terminal context' }] },
        });
        expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
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

    it('preserves an opaque claim through republish and leaves it outstanding across terminal and cancellation paths', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({
            session,
            logPrefix: '[Test]',
        });
        const opaqueClaim = { unexpected: ['malformed', { payload: true }] };
        const claimedRequest: NonNullable<AgentState['requests']>[string] & Record<'permissionResponseClaimV1', unknown> = {
            tool: 'Bash',
            kind: 'permission',
            arguments: { command: ['bash', '-lc', 'echo old'] },
            createdAt: 1,
            permissionResponseClaimV1: opaqueClaim,
        };
        session.agentState.requests!.claimed = claimedRequest;

        store.publishRequest({
            requestId: 'claimed',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo republished'] },
            createdAt: 2,
        });
        store.publishRequest({
            requestId: 'unclaimed',
            toolName: 'Write',
            toolInput: { path: '/tmp/x', content: 'x' },
            createdAt: 3,
        });

        const republished = session.agentState.requests!.claimed as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(republished, 'permissionResponseClaimV1')).toBe(true);
        expect(republished.permissionResponseClaimV1).toBe(opaqueClaim);

        await store.completeRequest({
            requestId: 'claimed',
            status: 'approved',
            decision: 'approved_for_session',
            allowedTools: ['Bash(*)'],
        });
        store.recordCompletedRequest({
            requestId: 'claimed',
            toolName: 'Bash',
            toolInput: { command: ['bash', '-lc', 'echo terminal'] },
            status: 'approved',
            decision: 'approved_for_session',
            allowedTools: ['Bash(*)'],
        });
        store.cancelAllRequests({ reason: 'Session ended', decision: 'abort' });

        const retained = session.agentState.requests!.claimed as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(retained, 'permissionResponseClaimV1')).toBe(true);
        expect(retained.permissionResponseClaimV1).toBe(opaqueClaim);
        expect(session.agentState.completedRequests!.claimed).toBeUndefined();
        expect(session.agentState.requests!.unclaimed).toBeUndefined();
        expect(session.agentState.completedRequests!.unclaimed).toMatchObject({ status: 'canceled' });
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
