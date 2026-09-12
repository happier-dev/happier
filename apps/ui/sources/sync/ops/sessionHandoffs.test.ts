import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const storageGetStateMock = vi.hoisted(() => vi.fn());

vi.mock('../runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('../domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: storageGetStateMock,
        },
    });
});

import {
    cancelSessionHandoff,
    completeSessionHandoff,
    getSessionHandoffStatus,
    normalizePrepareTargetResponseCandidate,
    normalizeSessionHandoffStartResponse,
    performSessionHandoffRecoveryAction,
    startSessionHandoff,
    startSessionHandoffOnSourceWithRetry,
} from './sessionHandoffs';

function pendingStatus(handoffId: string) {
    return {
        handoffId,
        status: 'pending' as const,
        phase: 'preparing' as const,
        recoveryActions: [],
    };
}

function completedStatus(handoffId: string) {
    return {
        handoffId,
        status: 'completed' as const,
        phase: 'finalizing' as const,
        recoveryActions: [],
    };
}

describe('session handoff operations', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        storageGetStateMock.mockReset();
        storageGetStateMock.mockReturnValue({ sessions: {} });
    });

    it('routes the complete start request through the source daemon coordinator', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({
            ok: true,
            result: {
                handoffId: 'handoff-1',
                status: pendingStatus('handoff-1'),
                endpointCandidates: [],
                handoffMetadataV2: {},
                targetPath: '/target/repo',
            },
        });

        await expect(startSessionHandoff({
            sessionId: 'session-1',
            sourceMachineId: 'source-machine',
            targetMachineId: ' target-machine ',
            targetPath: '/target/repo',
            serverId: ' server-1 ',
            sessionStorageMode: 'persisted',
            targetSessionStorageMode: 'direct',
        })).resolves.toEqual({
            ok: true,
            handoffId: 'handoff-1',
            status: pendingStatus('handoff-1'),
            endpointCandidates: [],
            handoffMetadataV2: {},
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledOnce();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'source-machine',
            method: RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3,
            payload: {
                sessionId: 'session-1',
                targetMachineId: 'target-machine',
                targetPath: '/target/repo',
                targetSessionStorageMode: 'direct',
            },
            serverId: 'server-1',
        });
    });

    it('fails before RPC when no source machine can be resolved', async () => {
        await expect(startSessionHandoff({
            sessionId: 'missing-session',
            targetMachineId: 'target-machine',
            sessionStorageMode: 'persisted',
        })).resolves.toEqual({
            ok: false,
            errorCode: 'machine_not_found',
            errorMessage: 'No reachable source machine target found for session handoff',
        });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('preserves typed daemon errors and status context', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({
            ok: false,
            errorCode: 'target_unavailable',
            error: 'Target is unavailable',
            status: pendingStatus('handoff-failed'),
        });

        await expect(startSessionHandoff({
            sessionId: 'session-1',
            sourceMachineId: 'source-machine',
            targetMachineId: 'target-machine',
            sessionStorageMode: 'persisted',
        })).resolves.toEqual({
            ok: false,
            errorCode: 'target_unavailable',
            errorMessage: 'Target is unavailable',
            handoffId: 'handoff-failed',
            status: pendingStatus('handoff-failed'),
        });
    });

    it('reports malformed coordinator responses without interpreting them locally', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({ unsupported: true });

        await expect(startSessionHandoff({
            sessionId: 'session-1',
            sourceMachineId: 'source-machine',
            targetMachineId: 'target-machine',
            sessionStorageMode: 'persisted',
        })).resolves.toEqual({
            ok: false,
            errorCode: 'UNEXPECTED',
            errorMessage: 'Unsupported session handoff response from daemon',
        });
    });

    it('keeps the legacy retry entrypoint as a single coordinator request', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({
            handoffId: 'handoff-once',
            status: pendingStatus('handoff-once'),
            endpointCandidates: [],
            targetPath: '/repo',
        });

        await expect(startSessionHandoffOnSourceWithRetry({
            sessionId: 'session-1',
            sourceMachineId: 'source-machine',
            targetMachineId: 'target-machine',
            sessionStorageMode: 'persisted',
        }, {
            timeoutMs: 1,
            intervalMs: 1,
        })).resolves.toMatchObject({ ok: true, handoffId: 'handoff-once' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledOnce();
    });

    it('completes from the coordinator status without running UI-owned phases', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({
            handoffId: 'handoff-complete',
            status: completedStatus('handoff-complete'),
        });

        await expect(completeSessionHandoff({
            sessionId: 'session-1',
            sourceMachineId: 'source-machine',
            targetMachineId: 'target-machine',
            sessionStorageMode: 'persisted',
        })).resolves.toEqual({
            ok: true,
            handoffId: 'handoff-complete',
            status: completedStatus('handoff-complete'),
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledOnce();
    });

    it('reads handoff status through the owning daemon', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({
            status: completedStatus('handoff-status'),
        });

        await expect(getSessionHandoffStatus({
            machineId: 'source-machine',
            handoffId: 'handoff-status',
            serverId: 'server-1',
        })).resolves.toEqual({
            ok: true,
            status: completedStatus('handoff-status'),
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'source-machine',
            method: RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3,
            payload: { handoffId: 'handoff-status' },
            serverId: 'server-1',
        });
    });

    it('returns transport failures as operation errors', async () => {
        machineRpcWithServerScopeMock.mockRejectedValue(new Error('socket closed'));

        await expect(getSessionHandoffStatus({
            machineId: 'source-machine',
            handoffId: 'handoff-status',
        })).resolves.toEqual({
            ok: false,
            errorCode: 'UNEXPECTED',
            errorMessage: 'socket closed',
        });
    });

    it('cancels through the source daemon and preserves a returned status', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({
            status: {
                handoffId: 'handoff-cancel',
                status: 'aborted',
                phase: 'finalizing',
                recoveryActions: [],
            },
        });

        await expect(cancelSessionHandoff({
            machineId: 'source-machine',
            handoffId: 'handoff-cancel',
            reason: 'operator_cancelled',
        })).resolves.toMatchObject({
            ok: true,
            status: { handoffId: 'handoff-cancel', status: 'aborted' },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'source-machine',
            method: RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3,
            payload: { handoffId: 'handoff-cancel', reason: 'operator_cancelled' },
            serverId: null,
        });
    });

    it('only handles the local keep-stopped recovery action', async () => {
        await expect(performSessionHandoffRecoveryAction({
            action: 'keep_stopped',
            recovery: {},
        })).resolves.toEqual({ ok: true });
        await expect(performSessionHandoffRecoveryAction({
            action: 'restart_on_source',
            recovery: {},
        })).resolves.toEqual({
            ok: false,
            error: 'Session handoff recovery must be retried from the source machine',
        });
    });

    it('unwraps coordinator results and accepts only object prepare candidates', () => {
        expect(normalizeSessionHandoffStartResponse({ ok: true, result: { handoffId: 'handoff-1' } }))
            .toEqual({ handoffId: 'handoff-1' });
        expect(normalizePrepareTargetResponseCandidate({ handoffId: 'handoff-1' }))
            .toEqual({ handoffId: 'handoff-1' });
        expect(normalizePrepareTargetResponseCandidate([])).toBeNull();
    });
});
