import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionSubmitPort } from './types';
import { submitSessionUserMessage } from './submitSessionUserMessage';

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 's1',
        serverId: 'server-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        pendingVersion: 2,
        pendingCount: 0,
        metadata: {
            machineId: 'm1', path: '/tmp/project', host: 'host', flavor: 'unknown-agent', version: '999.0.0',
            claudeSessionId: 'claude-1', claudeTranscriptPath: '/tmp/claude-1.jsonl',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        ...overrides,
    };
}

function createPort() {
    const enqueuePendingMessage = vi.fn(async () => ({ localId: 'pending-1', accepted: true }));
    const updatePendingRequestedAction = vi.fn(async () => undefined);
    const resumeSession = vi.fn(async () => ({ type: 'success' as const }));
    const port: SessionSubmitPort = {
        enqueuePendingMessage,
        updatePendingRequestedAction,
        resumeSession,
        sendMessage: vi.fn(async () => ({ localId: 'direct-1', seq: 2 })),
    };
    return { port, enqueuePendingMessage, updatePendingRequestedAction, resumeSession };
}

function submitOptions(session: Session) {
    return {
        sessionId: session.id,
        session,
        text: 'hello',
        configuredMode: 'agent_queue' as const,
        resumeCapabilityOptions: {},
        nowMs: 1_000,
    };
}

describe('submitSessionUserMessage Pending action ownership', () => {
    it('persists ordinary input with an explicit enqueue action', async () => {
        const session = createSession();
        const { port, enqueuePendingMessage } = createPort();

        await expect(submitSessionUserMessage(port, submitOptions(session))).resolves.toMatchObject({
            persistence: 'pending', localId: 'pending-1',
        });
        expect(enqueuePendingMessage).toHaveBeenCalledWith(
            's1', 'hello', undefined, expect.any(Object),
            expect.objectContaining({ requestedAction: { v: 1, kind: 'enqueue' } }),
        );
    });

    it('keeps ambiguous enqueue custody pending after the local outbound handoff', async () => {
        const session = createSession();
        const { port, enqueuePendingMessage } = createPort();
        const onOutboundHandoff = vi.fn();
        enqueuePendingMessage.mockResolvedValueOnce({
            localId: 'pending-ambiguous',
            accepted: false,
        });

        await expect(submitSessionUserMessage(port, {
            ...submitOptions(session),
            onOutboundHandoff,
        })).resolves.toEqual({
            type: 'wake_pending',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
            localId: 'pending-ambiguous',
        });
        expect(onOutboundHandoff).toHaveBeenCalledWith({
            persistence: 'pending',
            localId: 'pending-ambiguous',
        });
    });

    it('persists steer_if_active only for a currently steerable turn', async () => {
        const session = createSession({
            thinking: true,
            thinkingAt: 1_000,
            agentState: { capabilities: { inFlightSteerSupported: true, inFlightSteerAvailable: true } },
        });
        const { port, enqueuePendingMessage } = createPort();

        await submitSessionUserMessage(port, submitOptions(session));

        expect(enqueuePendingMessage).toHaveBeenCalledWith(
            's1', 'hello', undefined, expect.any(Object),
            expect.objectContaining({ requestedAction: { v: 1, kind: 'steer_if_active' } }),
        );
    });

    it('mutates an already durable row through the canonical action operation', async () => {
        const session = createSession();
        const { port, enqueuePendingMessage, updatePendingRequestedAction } = createPort();

        await expect(submitSessionUserMessage(port, {
            ...submitOptions(session),
            localId: 'durable-1',
            existingDurablePendingMessage: true,
            requestedAction: { v: 1, kind: 'send_now' },
        })).resolves.toMatchObject({ type: 'success', persistence: 'pending', localId: 'durable-1' });

        expect(updatePendingRequestedAction).toHaveBeenCalledWith('s1', 'durable-1', { v: 1, kind: 'send_now' });
        expect(enqueuePendingMessage).not.toHaveBeenCalled();
    });

    it('wakes an inactive durable row with request identity only', async () => {
        const session = createSession({
            active: false,
            presence: 0,
            metadata: {
                machineId: 'm1', path: '/tmp/project', host: 'host', flavor: 'claude', version: '999.0.0',
                claudeSessionId: 'claude-1', claudeTranscriptPath: '/tmp/claude-1.jsonl',
            },
        });
        const { port, updatePendingRequestedAction, resumeSession } = createPort();

        await submitSessionUserMessage(port, {
            ...submitOptions(session),
            localId: 'durable-wake-1',
            existingDurablePendingMessage: true,
            requestedAction: { v: 1, kind: 'send_now' },
            resumeTargetOverride: { machineId: 'm1', directory: '/tmp/project' },
        });

        expect(updatePendingRequestedAction).toHaveBeenCalledBefore(resumeSession);
        expect(resumeSession).toHaveBeenCalledWith(expect.objectContaining({
            executionAuthorization: { provenance: 'user_request', requestId: 'durable-wake-1' },
        }));
    });

    it('distinguishes action persistence failure from a later wake failure', async () => {
        const session = createSession({
            active: false,
            presence: 0,
            metadata: {
                machineId: 'm1', path: '/tmp/project', host: 'host', flavor: 'claude', version: '999.0.0',
                claudeSessionId: 'claude-1', claudeTranscriptPath: '/tmp/claude-1.jsonl',
            },
        });
        const actionFailure = createPort();
        actionFailure.updatePendingRequestedAction.mockRejectedValueOnce(new Error('action not persisted'));

        await expect(submitSessionUserMessage(actionFailure.port, {
            ...submitOptions(session),
            localId: 'durable-action-failed',
            existingDurablePendingMessage: true,
            requestedAction: { v: 1, kind: 'send_now' },
            resumeTargetOverride: { machineId: 'm1', directory: '/tmp/project' },
        })).resolves.toMatchObject({
            type: 'wake_failed',
            persistence: 'pending',
            localId: 'durable-action-failed',
            errorMessage: 'action not persisted',
        });
        expect(actionFailure.resumeSession).not.toHaveBeenCalled();

        const wakeFailures: SessionSubmitPort['resumeSession'][] = [
            async () => ({
                type: 'error' as const,
                errorCode: 'DAEMON_RPC_UNAVAILABLE' as const,
                errorMessage: 'wake timed out',
            }),
            async () => { throw new Error('wake response lost'); },
        ];
        for (const resumeSession of wakeFailures) {
            const wakeFailure = createPort();
            wakeFailure.port.resumeSession = vi.fn(resumeSession);

            await expect(submitSessionUserMessage(wakeFailure.port, {
                ...submitOptions(session),
                localId: 'durable-wake-failed',
                existingDurablePendingMessage: true,
                requestedAction: { v: 1, kind: 'send_now' },
                resumeTargetOverride: { machineId: 'm1', directory: '/tmp/project' },
            })).resolves.toMatchObject({
                type: 'wake_pending',
                persistence: 'pending',
                localId: 'durable-wake-failed',
                wake: { attempted: true, state: 'failed' },
            });
            expect(wakeFailure.updatePendingRequestedAction).toHaveBeenCalledBefore(wakeFailure.port.resumeSession as ReturnType<typeof vi.fn>);
        }
    });
});
