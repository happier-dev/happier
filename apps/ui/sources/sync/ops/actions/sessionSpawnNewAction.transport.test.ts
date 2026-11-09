import { beforeEach, describe, expect, it, vi } from 'vitest';

// Machine RPC routing/transport is the daemon boundary of this spawn client.
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '@/sync/domains/session/spawn/spawnSessionRpcTimeout';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcTimeoutError';
import { createSocketIoAckTimeoutError, markRpcRequestDisposition } from '@happier-dev/sync-client';
import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { clearBugReportUserActionTrail, getBugReportUserActionTrail } from '@/utils/system/bugReportActionTrail';
import { isMachineRequestReachabilityFailure } from '@/sync/domains/machines/reachability/machineReachability';
import { ScopedRpcSocketConnectionTimeoutError } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';

import { dispatchSessionSpawnNewToMachine } from './sessionSpawnNewAction';

const payload = {
    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
    creationKey: 'manual:attempt-a',
} as unknown as SessionSpawnNewInputV2;
const createMachineRpcTimeoutError = () => Object.assign(new Error('Machine RPC timed out'), {
    code: MACHINE_RPC_TIMEOUT_ERROR_CODE,
});

describe('session.spawn_new daemon dispatch', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        clearBugReportUserActionTrail();
    });

    it('preserves the pool timeout classification and phase without copying exception content', async () => {
        const failure = new ScopedRpcSocketConnectionTimeoutError('reachability-wait');
        failure.message = 'private request authentication';
        machineRpcWithServerScopeMock.mockRejectedValue(failure);
        const result = await dispatchSessionSpawnNewToMachine({ payload });
        expect(result).toMatchObject({ type: 'error', code: 'spawn_failed', retryable: true,
            launchError: { rpcErrorCode: 'MACHINE_RPC_TIMEOUT', connectionPhase: 'reachability-wait' } });
        expect(SessionSpawnNewResultV1Schema.parse(result)).toEqual(result);
        expect(JSON.stringify(result)).not.toContain('private request authentication');
    });

    it('retains content-free setup timeout evidence before projecting the spawn failure', async () => {
        const clock = vi.spyOn(Date, 'now');
        clock.mockReturnValueOnce(1_000).mockReturnValue(391_000);
        const failure = markRpcRequestDisposition(Object.assign(createMachineRpcTimeoutError(), {
            scope: 'scoped',
            message: 'private payload and authentication must not be recorded',
        }), 'notSent');
        machineRpcWithServerScopeMock.mockRejectedValue(failure);

        try {
            await dispatchSessionSpawnNewToMachine({ payload });
            expect(getBugReportUserActionTrail()).toEqual([expect.objectContaining({
                action: 'session.spawn_new.transport_failure',
                metadata: {
                    phase: 'setup', issued: false, elapsedMs: 390_000, phaseElapsedMs: 390_000,
                    errorName: 'Error', errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE,
                    requestDisposition: 'notSent', transportScope: 'scoped',
                },
            })]);
        } finally {
            clock.mockRestore();
        }
    });

    it('retains issuance and response timing while preserving an unknown spawn outcome', async () => {
        const clock = vi.spyOn(Date, 'now');
        clock.mockReturnValueOnce(1_000).mockReturnValueOnce(4_000).mockReturnValue(9_000);
        const failure = markRpcRequestDisposition(createMachineRpcTimeoutError(), 'outcomeUnknown');
        machineRpcWithServerScopeMock.mockImplementation(async (request: { onIssued?: () => void }) => {
            request.onIssued?.();
            throw failure;
        });

        try {
            await expect(dispatchSessionSpawnNewToMachine({ payload })).resolves.toEqual({
                type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown',
            });
            expect(getBugReportUserActionTrail()[0]?.metadata).toEqual({
                phase: 'response', issued: true, elapsedMs: 8_000, phaseElapsedMs: 5_000,
                errorName: 'Error', errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE,
                requestDisposition: 'outcomeUnknown', transportScope: 'unknown',
            });
        } finally {
            clock.mockRestore();
        }
    });

    it.each([
        ['private error\nwith content', '/private/payload'],
        ['SecretName', 'PrivateToken'],
    ])('records a refusal without retaining untrusted error name %s or payload', async (name, code) => {
        const failure = Object.assign(new Error('Bearer private-authentication /private/path'), {
            name, code, scope: 'private-home',
        });
        machineRpcWithServerScopeMock.mockRejectedValue(failure);

        await expect(dispatchSessionSpawnNewToMachine({ payload })).rejects.toBe(failure);
        expect(getBugReportUserActionTrail()[0]?.metadata).toEqual({
            phase: 'setup', issued: false, elapsedMs: expect.any(Number), phaseElapsedMs: expect.any(Number),
            errorName: 'unknown', errorCode: 'unknown',
            requestDisposition: 'unknown', transportScope: 'unknown',
        });
    });

    it('waits for the daemon for the Session spawn budget, not the generic machine RPC default', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' });

        await dispatchSessionSpawnNewToMachine({ payload });

        const request = machineRpcWithServerScopeMock.mock.calls[0]?.[0];
        expect(request).toMatchObject({ serverId: 'server-a', machineId: 'machine-a', method: RPC_METHODS.SESSION_SPAWN_NEW });
        // A daemon that answers after the generic 30 s default (the observed
        // stall was 23 s plus client/relay overhead) is still inside this budget.
        expect(request.timeoutMs).toBeGreaterThan(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS);
        expect(request.timeoutMs).toBe(readSpawnSessionRpcTimeoutMsFromEnv());
    });

    it.each([
        ['socket acknowledgement', createSocketIoAckTimeoutError],
        ['machine RPC setup', createMachineRpcTimeoutError],
        ['machine row setup', () => createRpcCallError({ error: 'Machine row request timed out', errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE })],
    ] as const)('reports a %s timeout before issuance as a retryable failure without claiming a Session may exist', async (_kind, timeout) => {
        machineRpcWithServerScopeMock.mockRejectedValue(timeout());

        const result = await dispatchSessionSpawnNewToMachine({ payload });
        expect(result).toEqual({
            type: 'error',
            code: 'spawn_failed',
            retryable: true,
            launchError: {
                kind: 'launch_error',
                code: MACHINE_RPC_TIMEOUT_ERROR_CODE,
                message: expect.any(String),
                ...(_kind === 'machine row setup' ? { rpcErrorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE } : {}),
            },
        });
        expect(SessionSpawnNewResultV1Schema.parse(result)).toEqual(result);
        // A setup deadline cannot override independently observed connected presence.
        expect(isMachineRequestReachabilityFailure(result)).toBe(false);
        expect(machineRpcWithServerScopeMock.mock.calls[0]?.[0]).toMatchObject({
            onIssued: expect.any(Function),
        });
    });

    it.each([
        ['socket acknowledgement', createSocketIoAckTimeoutError],
        ['machine RPC deadline', createMachineRpcTimeoutError],
    ] as const)('settles an emitted spawn after a %s timeout as outcome-unknown, to retry with the same creation key', async (_kind, timeout) => {
        machineRpcWithServerScopeMock.mockImplementation(async (request: { onIssued?: () => void }) => {
            request.onIssued?.();
            throw timeout();
        });

        await expect(dispatchSessionSpawnNewToMachine({ payload })).resolves.toEqual({
            type: 'pending',
            retryWithSameCreationKey: true,
            outcome: 'unknown',
        });
    });

    it('settles an emitted spawn whose socket dropped before the acknowledgement as outcome-unknown, not as a failure to start', async () => {
        // Socket.IO clears every issued acknowledgement with this error when the
        // scoped-rpc socket is recycled; the daemon may already be creating the Session.
        machineRpcWithServerScopeMock.mockImplementation(async (request: { onIssued?: () => void }) => {
            request.onIssued?.();
            throw markRpcRequestDisposition(createRpcCallError({
                error: 'socket has been disconnected',
                errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN,
            }), 'outcomeUnknown');
        });

        await expect(dispatchSessionSpawnNewToMachine({ payload })).resolves.toEqual({
            type: 'pending',
            retryWithSameCreationKey: true,
            outcome: 'unknown',
        });
    });

    it('keeps a definitive daemon refusal a typed failure rather than an unknown outcome', async () => {
        machineRpcWithServerScopeMock.mockRejectedValue(createRpcCallError({
            error: 'RPC method not available',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        }));

        await expect(dispatchSessionSpawnNewToMachine({ payload })).rejects.toMatchObject({
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
        expect(getBugReportUserActionTrail()[0]?.metadata).toMatchObject({
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, issued: false,
        });
    });

    it('records only the strict daemon refusal code and preserves its result', async () => {
        const refusal = SessionSpawnNewResultV1Schema.parse({
            type: 'error', code: 'permission_denied', retryable: false,
        });
        machineRpcWithServerScopeMock.mockImplementation(async (request: { onIssued?: () => void }) => {
            request.onIssued?.();
            return refusal;
        });

        await expect(dispatchSessionSpawnNewToMachine({ payload })).resolves.toBe(refusal);
        expect(getBugReportUserActionTrail()).toEqual([expect.objectContaining({
            action: 'session.spawn_new.daemon_refusal',
            metadata: {
                phase: 'response', issued: true, elapsedMs: expect.any(Number), phaseElapsedMs: expect.any(Number),
                resultCode: 'permission_denied',
            },
        })]);
    });
});
