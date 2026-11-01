import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import {
    CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
    CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
} from '@happier-dev/agents';
import type { AgentState } from '@/api/types';
import { AgentStateRequestStore } from './agentStateRequestStore';
import type { PermissionRequestPushSender } from '@/settings/notifications/permissionRequestPush';

class FakeSession {
    sessionId = 'session-test';
    agentState: AgentState = {
        requests: Object.create(null),
        completedRequests: Object.create(null),
    };

    getAgentStateSnapshot() {
        return this.agentState;
    }

    async updateAgentStateRequestSettlement(updater: Parameters<FakeSession['updateAgentState']>[0]): Promise<void> {

      await this.updateAgentState(updater);

    }


    updateAgentState(updater: (state: AgentState) => AgentState) {
        this.agentState = updater(this.agentState);
    }
}

describe('AgentStateRequestStore', () => {
    it('publishes opaque occurrence identity that survives republication and changes for replacement input', () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        const request = { requestId: 'same', toolName: 'Write', toolInput: { path: 'first' }, createdAt: 10 };
        store.publishRequest(request);
        const first = session.agentState.requests?.same;
        expect(first).toHaveProperty('occurrenceId', expect.any(String));
        store.publishRequest(request);
        expect(session.agentState.requests?.same).toHaveProperty('occurrenceId', first?.occurrenceId);
        store.publishRequest({ ...request, toolInput: { path: 'replacement' } });
        expect(session.agentState.requests?.same?.occurrenceId).not.toBe(first?.occurrenceId);
    });

    it('rejects a replacement occurrence that appears while its notification response awaits settlement', async () => {
        const session = new FakeSession();
        const original = { tool: 'Write', arguments: { path: 'same' }, createdAt: 10, occurrenceId: 'original' };
        session.agentState = { requests: { same: original }, completedRequests: {} };
        let admit!: () => void;
        session.updateAgentState = (updater) => new Promise<void>((resolve) => {
            admit = () => { session.agentState = updater(session.agentState); resolve(); };
        });
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        const completion = store.completeRequest({
            requestId: 'same', status: 'approved', requireAck: true, expectedOccurrenceId: 'original',
            fallback: { toolName: original.tool, toolInput: original.arguments, createdAt: original.createdAt },
        });
        session.agentState.requests = { same: { ...original, occurrenceId: 'replacement' } };
        admit();
        await expect(completion).rejects.toThrow('did not match');
        expect(session.agentState.requests.same).toHaveProperty('occurrenceId', 'replacement');
        expect(session.agentState.completedRequests?.same).toBeUndefined();
    });

    it('sends the published occurrence identity without including private tool arguments in notification data', async () => {
        const session = new FakeSession();
        const sendToAllDevicesAsync = vi.fn<PermissionRequestPushSender['sendToAllDevicesAsync']>(async () => {});
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]',
            pushSender: { sendToAllDevicesAsync }, getAccountSettings: () => accountSettingsParse({}),
        });
        store.publishRequest({ requestId: 'notification', toolName: 'Write',
            toolInput: { path: '/private/path', content: 'private content' }, createdAt: Date.now() });
        await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));
        const data = sendToAllDevicesAsync.mock.calls[0]?.[2];
        expect(data).toMatchObject({ requestId: 'notification', occurrenceId: session.agentState.requests?.notification?.occurrenceId });
        expect(JSON.stringify(data)).not.toContain('private');
        store.dispose();
    });

    it.each(['claimed', 'replacement', 'missing'] as const)('rejects a %s occurrence before settlement admission', async (change) => {
        const session = new FakeSession();
        const request = { tool: 'Write', arguments: { path: '/workspace/original' }, createdAt: 10 };
        session.agentState = { requests: { sameId: request }, completedRequests: {} };
        let apply!: () => void;
        session.updateAgentStateRequestSettlement = (updater) => new Promise<void>((resolve) => {
            apply = () => { session.updateAgentState(updater); resolve(); };
        });
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        const completion = store.completeRequest({
            requestId: 'sameId', status: 'approved', observedCompletion: true,
            fallback: { toolName: request.tool, toolInput: request.arguments, createdAt: request.createdAt },
        });
        if (change === 'claimed') {
            const claimed = { ...request, permissionResponseClaimV1: { opaque: true } };
            session.agentState.requests = { sameId: claimed };
        } else if (change === 'replacement') {
            session.agentState.requests = { sameId: { ...request, createdAt: 20 } };
        } else {
            session.agentState.requests = {};
        }
        const current = structuredClone(session.agentState);
        apply();
        if (change === 'missing') {
            // A live provider waiter still supplies its exact fallback even if publication was lost.
            await completion;
            expect(session.agentState.completedRequests?.sameId).toMatchObject({ createdAt: 10, status: 'approved' });
        } else {
            await expect(completion).rejects.toThrow('did not match');
            expect(session.agentState).toEqual(current);
        }
    });
    it('does not publish automatic history over an outstanding occurrence with the same id', async () => {
        const session = new FakeSession();
        const request = { tool: 'Write', arguments: { path: 'live' }, createdAt: 2 };
        session.agentState = { requests: { reused: request }, completedRequests: {} };
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        await store.recordCompletedRequest({
            requestId: 'reused', toolName: 'Write', toolInput: { path: 'automatic' },
            createdAt: 1, status: 'approved',
        });
        expect(session.agentState).toEqual({ requests: { reused: request }, completedRequests: {} });
    });

    it('recognizes its exact committed completion after a lost acknowledgement rebases the updater', async () => {
        const session = new FakeSession();
        const request = { tool: 'Write', arguments: {}, createdAt: 1 };
        session.agentState = { requests: { ack: request } };
        session.updateAgentState = (updater) => {
            session.agentState = updater(session.agentState);
            // The first update committed; its lost ACK forces another CAS attempt.
            session.agentState = updater(session.agentState);
        };
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        await expect(store.completeRequest({
            requestId: 'ack', status: 'approved',
            fallback: { toolName: request.tool, toolInput: request.arguments, createdAt: request.createdAt },
        })).resolves.toBeUndefined();
        expect(session.agentState.requests?.ack).toBeUndefined();
        expect(session.agentState.completedRequests?.ack).toMatchObject({ status: 'approved' });
    });

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

    it('cancels only the selected source through the shared terminal write', async () => {
        const session = new FakeSession();
        const store = new AgentStateRequestStore({ session, logPrefix: '[Test]' });
        store.publishRequest({ requestId: 'local', toolName: 'Write', toolInput: {}, createdAt: 1, source: 'local' });
        store.publishRequest({ requestId: 'remote', toolName: 'Bash', toolInput: {}, createdAt: 2, source: 'remote' });
        const cancel: Parameters<typeof store.cancelAllRequests>[0] & {
            shouldCancel: (request: NonNullable<AgentState['requests']>[string]) => boolean;
        } = {
            reason: 'Bridge stopped',
            shouldCancel: (request) => (request as { source?: string }).source === 'local',
        };
        store.cancelAllRequests(cancel);
        await Promise.resolve();
        expect(Object.keys(session.agentState.requests ?? {})).toEqual(['remote']);
        expect(session.agentState.completedRequests?.local).toMatchObject({ status: 'canceled', reason: 'Bridge stopped' });
        expect(session.agentState.completedRequests?.remote).toBeUndefined();
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

        await expect(store.completeRequest({
            requestId: 'claimed',
            status: 'approved',
            decision: 'approved_for_session',
            allowedTools: ['Bash(*)'],
        })).rejects.toThrow('did not match');
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
