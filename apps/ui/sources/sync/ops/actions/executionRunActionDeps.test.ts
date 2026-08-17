import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const machineCapabilitiesDetectMock = vi.hoisted(() => vi.fn());
const readMachineControlTargetForSessionMock = vi.hoisted(() => vi.fn());
const sessionExecutionRunStartMock = vi.hoisted(() => vi.fn());
const sessionExecutionRunListMock = vi.hoisted(() => vi.fn());
const sessionExecutionRunGetMock = vi.hoisted(() => vi.fn());
const sessionExecutionRunSendMock = vi.hoisted(() => vi.fn());
const sessionExecutionRunStopMock = vi.hoisted(() => vi.fn());
const sessionExecutionRunActionMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));
vi.mock('@/sync/ops/capabilities', () => ({
    machineCapabilitiesDetect: machineCapabilitiesDetectMock,
}));
vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineControlTargetForSession: readMachineControlTargetForSessionMock,
}));
vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStart: sessionExecutionRunStartMock,
    sessionExecutionRunList: sessionExecutionRunListMock,
    sessionExecutionRunGet: sessionExecutionRunGetMock,
    sessionExecutionRunSend: sessionExecutionRunSendMock,
    sessionExecutionRunStop: sessionExecutionRunStopMock,
    sessionExecutionRunAction: sessionExecutionRunActionMock,
}));

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createUiExecutionRunActionDeps } from './executionRunActionDeps';

const V2_EXECUTION_RUN_CAPABILITY = {
    supported: true,
    response: {
        protocolVersion: 1,
        results: {
            'tool.executionRuns': {
                ok: true,
                checkedAt: 1,
                data: {
                    protocolVersion: 2,
                    features: { detachedScope: true, startAndWait: true },
                },
            },
        },
    },
} as const;

describe('UI execution.run Action dependencies', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keeps detached start, get, stop, and wait on the one exact machine selected by V2 preflight', async () => {
        machineCapabilitiesDetectMock.mockResolvedValue(V2_EXECUTION_RUN_CAPABILITY);
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ runId: 'run_1', callId: 'call_1', sidechainId: 'side_1' })
            .mockResolvedValueOnce({ run: { runId: 'run_1', status: 'running' } })
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({ run: { runId: 'run_1', status: 'succeeded' } });
        const deps = createUiExecutionRunActionDeps();
        const initialOptions = { serverId: 'server_1', targetMachineId: 'machine_mounted' };

        const capability = await deps.executionRunCheckProtocolV2?.(
            null,
            { detachedScope: true, startAndWait: true },
            initialOptions,
        );
        expect(capability).toEqual({ ok: true, exactMachineId: 'machine_mounted' });
        const exactOptions = { ...initialOptions, exactMachineId: 'machine_mounted' };

        await expect(deps.executionRunStart(null, {
            intent: 'delegate',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            instructions: 'Inspect the change.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        }, exactOptions)).resolves.toMatchObject({ runId: 'run_1' });
        await expect(deps.executionRunGet(null, { runId: 'run_1' }, exactOptions))
            .resolves.toMatchObject({ run: { status: 'running' } });
        await expect(deps.executionRunStop(null, { runId: 'run_1' }, exactOptions)).resolves.toEqual({ ok: true });
        await expect(deps.executionRunWait(null, { runId: 'run_1', timeoutSeconds: 10 }, exactOptions))
            .resolves.toEqual({ ok: true, status: 'succeeded', result: { run: { runId: 'run_1', status: 'succeeded' } } });

        expect(machineCapabilitiesDetectMock).toHaveBeenCalledWith(
            'machine_mounted',
            { requests: [{ id: 'tool.executionRuns' }] },
            expect.objectContaining({ serverId: 'server_1' }),
        );
        expect(machineRpcWithServerScopeMock.mock.calls.map(([request]) => request.machineId)).toEqual([
            'machine_mounted',
            'machine_mounted',
            'machine_mounted',
            'machine_mounted',
        ]);
        expect(machineRpcWithServerScopeMock.mock.calls.map(([request]) => request.method)).toEqual([
            SESSION_RPC_METHODS.EXECUTION_RUN_START,
            SESSION_RPC_METHODS.EXECUTION_RUN_GET,
            SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
            SESSION_RPC_METHODS.EXECUTION_RUN_GET,
        ]);
    });

    it('fails closed without an exact detached target and does not issue a machine RPC', async () => {
        const deps = createUiExecutionRunActionDeps();

        await expect(deps.executionRunCheckProtocolV2?.(
            null,
            { detachedScope: true, startAndWait: false },
            { serverId: 'server_1' },
        )).resolves.toEqual({
            ok: false,
            errorCode: 'execution_run_target_not_selected',
            error: 'execution_run_target_not_selected',
        });
        await expect(deps.executionRunStart(null, { intent: 'delegate' }, { serverId: 'server_1' }))
            .resolves.toEqual({
                ok: false,
                errorCode: 'execution_run_target_not_selected',
                error: 'execution_run_target_not_selected',
            });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('uses the contextual Session only to resolve a detached target when no mounted target was stamped', async () => {
        readMachineControlTargetForSessionMock.mockReturnValue({ machineId: 'machine_context' });
        machineCapabilitiesDetectMock.mockResolvedValue(V2_EXECUTION_RUN_CAPABILITY);
        const deps = createUiExecutionRunActionDeps();

        await expect(deps.executionRunCheckProtocolV2?.(
            null,
            { detachedScope: true, startAndWait: false },
            { serverId: 'server_1', originSessionId: 'session_context' },
        )).resolves.toEqual({ ok: true, exactMachineId: 'machine_context' });
        expect(readMachineControlTargetForSessionMock).toHaveBeenCalledWith('session_context');
        expect(machineCapabilitiesDetectMock).toHaveBeenCalledWith(
            'machine_context',
            { requests: [{ id: 'tool.executionRuns' }] },
            expect.objectContaining({ serverId: 'server_1' }),
        );
    });

    it('retains the incumbent session-scoped transport instead of routing it through a machine', async () => {
        sessionExecutionRunStartMock.mockResolvedValue({ runId: 'run_1' });
        sessionExecutionRunListMock.mockResolvedValue({ runs: [] });
        sessionExecutionRunGetMock
            .mockResolvedValueOnce({ run: { runId: 'run_1', status: 'running' } })
            .mockResolvedValueOnce({ run: { runId: 'run_1', status: 'succeeded' } });
        sessionExecutionRunSendMock.mockResolvedValue({ ok: true });
        sessionExecutionRunStopMock.mockResolvedValue({ ok: true });
        sessionExecutionRunActionMock.mockResolvedValue({ ok: true });
        const deps = createUiExecutionRunActionDeps();
        const opts = { serverId: 'server_1' };

        await deps.executionRunStart('session_1', { intent: 'delegate' }, opts);
        await deps.executionRunList('session_1', {}, opts);
        await deps.executionRunGet('session_1', { runId: 'run_1' }, opts);
        await deps.executionRunSend('session_1', { runId: 'run_1', message: 'continue' }, opts);
        await deps.executionRunStop('session_1', { runId: 'run_1' }, opts);
        await deps.executionRunAction('session_1', { runId: 'run_1', actionId: 'review.apply' }, opts);
        await expect(deps.executionRunWait('session_1', { runId: 'run_1' }, opts))
            .resolves.toEqual({ ok: true, status: 'succeeded', result: { run: { runId: 'run_1', status: 'succeeded' } } });

        expect(sessionExecutionRunStartMock).toHaveBeenCalledWith('session_1', { intent: 'delegate' }, { serverId: 'server_1' });
        expect(sessionExecutionRunListMock).toHaveBeenCalledWith('session_1', {}, { serverId: 'server_1' });
        expect(sessionExecutionRunSendMock).toHaveBeenCalledWith(
            'session_1',
            { runId: 'run_1', message: 'continue' },
            { serverId: 'server_1' },
        );
        expect(sessionExecutionRunStopMock).toHaveBeenCalledWith('session_1', { runId: 'run_1' }, { serverId: 'server_1' });
        expect(sessionExecutionRunActionMock).toHaveBeenCalledWith(
            'session_1',
            { runId: 'run_1', actionId: 'review.apply' },
            { serverId: 'server_1' },
        );
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });
});
