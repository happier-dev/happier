import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionSubmitPort } from './types';
import { submitSessionUserMessage } from './submitSessionUserMessage';

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => ({
                sessions: {},
                machines: {},
                getProjectForSession: () => null,
            }),
        },
    });
});

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 's1',
        serverId: 'server-1',
        seq: 41,
        createdAt: 1,
        updatedAt: 2,
        active: true,
        activeAt: Date.now(),
        pendingVersion: 2,
        pendingCount: 0,
        metadata: {
            machineId: 'm1',
            path: '/tmp/project',
            host: 'host.local',
            flavor: 'claude',
            claudeSessionId: 'claude-1',
            version: '999.0.0',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        runtimeActivityState: 'idle',
        runtimeActivityRevision: 1,
        ...overrides,
    } as Session;
}

function createPort() {
    const enqueuePendingMessage = vi.fn<SessionSubmitPort['enqueuePendingMessage']>(async () => ({
        localId: 'pending-1',
        accepted: true,
    }));
    const sendMessage = vi.fn<SessionSubmitPort['sendMessage']>(async () => ({
        localId: 'direct-1',
        seq: 42,
        persistence: 'transcript_committed',
    }));
    const updatePendingRequestedAction = vi.fn<NonNullable<SessionSubmitPort['updatePendingRequestedAction']>>(async () => {});
    const port: SessionSubmitPort = {
        enqueuePendingMessage,
        sendMessage,
        updatePendingRequestedAction,
        ensureSessionRuntimeForPendingInput: vi.fn(async () => ({ type: 'success' as const })),
        refreshSessionForSubmit: vi.fn(async () => null),
    };
    return { port, enqueuePendingMessage, sendMessage, updatePendingRequestedAction };
}

const baseOptions = {
    sessionId: 's1',
    text: 'hello',
    configuredMode: 'server_pending' as const,
    resumeCapabilityOptions: { accountSettings: {} },
};

describe('submitSessionUserMessage', () => {
    it('persists ordinary input with the canonical enqueue action', async () => {
        const harness = createPort();

        const result = await submitSessionUserMessage(harness.port, {
            ...baseOptions,
            session: createSession(),
            localId: 'local-enqueue',
        });

        expect(harness.enqueuePendingMessage).toHaveBeenCalledWith(
            's1',
            'hello',
            undefined,
            expect.objectContaining({ happierDeliveryIntentV1: 'default' }),
            expect.objectContaining({
                localId: 'local-enqueue',
                requestedAction: { v: 1, kind: 'enqueue' },
            }),
        );
        expect(harness.sendMessage).not.toHaveBeenCalled();
        expect(result).toMatchObject({ type: 'wake_pending', persistence: 'pending', localId: 'pending-1' });
    });

    it('persists force-immediate input as send_now instead of bypassing Pending', async () => {
        const harness = createPort();

        await submitSessionUserMessage(harness.port, {
            ...baseOptions,
            session: createSession(),
            forceImmediate: true,
            localId: 'local-now',
        });

        expect(harness.enqueuePendingMessage).toHaveBeenCalledWith(
            's1',
            'hello',
            undefined,
            expect.objectContaining({ happierDeliveryIntentV1: 'explicit_immediate' }),
            expect.objectContaining({ requestedAction: { v: 1, kind: 'send_now' } }),
        );
        expect(harness.sendMessage).not.toHaveBeenCalled();
    });

    it('updates the action on an existing durable row without creating a second row', async () => {
        const harness = createPort();

        const result = await submitSessionUserMessage(harness.port, {
            ...baseOptions,
            session: createSession(),
            localId: 'existing-local',
            existingDurablePendingMessage: true,
            requestedAction: { v: 1, kind: 'steer_now' },
        });

        expect(harness.updatePendingRequestedAction).toHaveBeenCalledWith(
            's1',
            'existing-local',
            { v: 1, kind: 'steer_now' },
        );
        expect(harness.enqueuePendingMessage).not.toHaveBeenCalled();
        expect(harness.sendMessage).not.toHaveBeenCalled();
        expect(result).toMatchObject({ type: 'success', persistence: 'pending', localId: 'existing-local' });
    });

    it('reports a requested-action update failure while retaining durable custody', async () => {
        const harness = createPort();
        harness.updatePendingRequestedAction.mockRejectedValueOnce(Object.assign(
            new Error('row already claimed'),
            { code: 'action-conflict' },
        ));

        const result = await submitSessionUserMessage(harness.port, {
            ...baseOptions,
            session: createSession(),
            localId: 'existing-local',
            existingDurablePendingMessage: true,
            requestedAction: { v: 1, kind: 'send_now' },
        });

        expect(result).toMatchObject({
            type: 'wake_failed',
            persistence: 'pending',
            localId: 'existing-local',
            errorCode: 'action-conflict',
            errorMessage: 'row already claimed',
        });
        expect(harness.enqueuePendingMessage).not.toHaveBeenCalled();
    });

    it('keeps an existing durable action pending when the later wake fails', async () => {
        const wakeFailures: SessionSubmitPort['ensureSessionRuntimeForPendingInput'][] = [
            async () => ({
                type: 'error' as const,
                errorCode: 'DAEMON_RPC_UNAVAILABLE' as const,
                errorMessage: 'wake timed out',
            }),
            async () => { throw new Error('wake response lost'); },
        ];

        for (const ensureSessionRuntimeForPendingInput of wakeFailures) {
            const harness = createPort();
            harness.port.ensureSessionRuntimeForPendingInput = vi.fn(ensureSessionRuntimeForPendingInput);

            const result = await submitSessionUserMessage(harness.port, {
                ...baseOptions,
                session: createSession({ active: false, presence: 0 }),
                localId: 'existing-local',
                existingDurablePendingMessage: true,
                requestedAction: { v: 1, kind: 'send_now' },
                resumeTargetOverride: { machineId: 'm1', directory: '/tmp/project' },
            });

            expect(harness.updatePendingRequestedAction).toHaveBeenCalledWith(
                's1',
                'existing-local',
                { v: 1, kind: 'send_now' },
            );
            expect(harness.port.ensureSessionRuntimeForPendingInput).toHaveBeenCalledTimes(1);
            expect(result).toMatchObject({
                type: 'wake_pending',
                persistence: 'pending',
                localId: 'existing-local',
                wake: { attempted: true, state: 'failed' },
            });
        }
    });

    it('fails closed when a requested Pending queue is unsupported', async () => {
        const harness = createPort();

        const result = await submitSessionUserMessage(harness.port, {
            ...baseOptions,
            session: createSession({
                metadata: {
                    ...createSession().metadata,
                    path: '/tmp/project',
                    host: 'host.local',
                    version: '0.0.1',
                },
            }),
        });

        expect(result).toMatchObject({
            type: 'rejected',
            persistence: 'none',
            errorCode: 'PENDING_QUEUE_UNSUPPORTED',
        });
        expect(harness.enqueuePendingMessage).not.toHaveBeenCalled();
        expect(harness.sendMessage).not.toHaveBeenCalled();
    });
});
