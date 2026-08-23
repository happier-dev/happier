import { describe, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { delegateSessionHandoffToSourceDaemon } from './delegatedSessionHandoff';

const admission = {
    handoffId: 'handoff-1',
    status: { handoffId: 'handoff-1', status: 'pending', phase: 'preparing', recoveryActions: [] },
    endpointCandidates: [],
    targetPath: '/target',
} as const;

function terminal(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
    return {
        version: 1,
        operationId: 'operation-1',
        requestId: 'request-1',
        revision: 2,
        actionId: 'session.handoff',
        state: 'succeeded',
        scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
        title: 'Hand off session',
        createdAt: 1,
        startedAt: 2,
        settledAt: 3,
        result: { handoffId: 'handoff-1', status: { status: 'completed' } },
        cancellation: 'supported',
        ...overrides,
    };
}

describe('delegateSessionHandoffToSourceDaemon', () => {
    it('subscribes before one admission call and returns the pushed terminal result', async () => {
        const order: string[] = [];
        const observeTerminal = vi.fn(async () => {
            order.push('observe');
            return terminal();
        });
        const machineRpc = vi.fn(async () => {
            order.push('admit');
            return admission;
        });

        await expect(delegateSessionHandoffToSourceDaemon({
            accountId: 'account-1',
            sourceMachineId: 'machine-1',
            targetMachineId: 'machine-2',
            sessionId: 'session-1',
            sessionStorageMode: 'persisted',
            targetSessionStorageMode: 'direct',
            requestId: 'request-1',
            serverId: 'server-1',
        }, { machineRpc, observeTerminal })).resolves.toEqual({
            ok: true,
            handoffId: 'handoff-1',
            status: { status: 'completed' },
        });

        expect(order).toEqual(['observe', 'admit']);
        expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: 'daemon.sessionHandoff.start',
            serverId: 'server-1',
            payload: {
                requestId: 'request-1',
                sessionId: 'session-1',
                sourceMachineId: 'machine-1',
                targetMachineId: 'machine-2',
                sessionStorageMode: 'persisted',
                targetSessionStorageMode: 'direct',
                preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            },
        }));
    });

    it('maps a pushed failure to the historical dependency result', async () => {
        await expect(delegateSessionHandoffToSourceDaemon({
            accountId: 'account-1',
            sourceMachineId: 'machine-1',
            targetMachineId: 'machine-2',
            sessionId: 'session-1',
            sessionStorageMode: 'persisted',
            requestId: 'request-1',
        }, {
            machineRpc: async () => admission,
            observeTerminal: async () => terminal({
                state: 'failed',
                result: undefined,
                error: { errorCode: 'handoff_failed', error: 'Could not hand off' },
            }),
        })).resolves.toEqual({
            ok: false,
            errorCode: 'handoff_failed',
            errorMessage: 'Could not hand off',
        });
    });
});
