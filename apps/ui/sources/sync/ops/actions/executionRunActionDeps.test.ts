import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const machineCapabilitiesDetectMock = vi.hoisted(() => vi.fn());
const readMachineControlTargetForSessionMock = vi.hoisted(() => vi.fn());
const sessionExecutionRunStartMock = vi.hoisted(() => vi.fn());
const sessionExecutionRunListMock = vi.hoisted(() => vi.fn());
const sessionExecutionRunGetMock = vi.hoisted(() => vi.fn());
const sessionExecutionRunWaitMock = vi.hoisted(() => vi.fn());
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
    sessionExecutionRunWait: sessionExecutionRunWaitMock,
    sessionExecutionRunSend: sessionExecutionRunSendMock,
    sessionExecutionRunStop: sessionExecutionRunStopMock,
    sessionExecutionRunAction: sessionExecutionRunActionMock,
}));

import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
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

    it('preserves the exact Home, Account, Machine and issuance witness when answering a detached request', async () => {
        const controller = new AbortController();
        const onTransportIssued = vi.fn();
        machineRpcWithServerScopeMock.mockImplementation(async (params) => {
            params.onIssued?.();
            return { ok: false, errorCode: 'permission_request_not_found', error: 'Not found' };
        });
        const request = { runId: 'run-1', requestId: 'request-1', answers: { branch: ['dev'] } };
        expect(await createUiExecutionRunActionDeps().executionRunPermissionRespond?.(request, {
            serverId: 'home-1', runtimeAccountId: 'account-1', executionRunTargetMachineId: 'machine-1',
            signal: controller.signal, onTransportIssued, authority: 'present_user',
        })).toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            serverId: 'home-1', accountId: 'account-1', machineId: 'machine-1',
            method: RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND, payload: request,
            preferScoped: true, signal: controller.signal, onIssued: onTransportIssued,
        });
        expect(onTransportIssued).toHaveBeenCalledOnce();
    });

    it.each([{ waitForInputId: 'input-1' }, { waitForOutput: { kind: 'review_walkthrough' as const, comparisonId: 'comparison-1' } }])
    ('keeps detached exact get observation under caller lifecycle: %j', async (wait) => {
        machineRpcWithServerScopeMock.mockResolvedValue({ run: { runId: 'run-1' } });
        const controller = new AbortController();
        await createUiExecutionRunActionDeps().executionRunGet(null, { runId: 'run-1', ...wait }, {
            targetMachineId: 'machine-1', serverId: 'server-1', signal: controller.signal,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: SESSION_RPC_METHODS.EXECUTION_RUN_GET, operationTimeoutMs: null, signal: controller.signal,
        }));
    });

    it('keeps detached start, get, stop, and wait on the one exact machine selected by V2 preflight', async () => {
        machineCapabilitiesDetectMock.mockResolvedValue(V2_EXECUTION_RUN_CAPABILITY);
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ runId: 'run_1', callId: 'call_1', sidechainId: 'side_1' })
            .mockResolvedValueOnce({ run: { runId: 'run_1', status: 'running' } })
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({ ok: true, status: 'succeeded', result: { run: { runId: 'run_1', status: 'succeeded' } } });
        const deps = createUiExecutionRunActionDeps();
        const initialOptions = { serverId: 'server_1', targetMachineId: 'machine_mounted' };

        const capability = await deps.executionRunCheckProtocolV2?.(
            null,
            {
                detachedScope: true,
                startAndWait: true,
                exactInputResults: false,
                runScopedAgentBindings: false,
                secretReferenceOverlay: false,
            },
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
            SESSION_RPC_METHODS.EXECUTION_RUN_WAIT,
        ]);
        expect(machineRpcWithServerScopeMock.mock.calls[3]?.[0]).toMatchObject({
            payload: { runId: 'run_1', timeoutSeconds: 10 },
        });
    });

    it('fails closed without an exact detached target and does not issue a machine RPC', async () => {
        const deps = createUiExecutionRunActionDeps();

        await expect(deps.executionRunCheckProtocolV2?.(
            null,
            {
                detachedScope: true,
                startAndWait: false,
                exactInputResults: false,
                runScopedAgentBindings: false,
                secretReferenceOverlay: false,
            },
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
            {
                detachedScope: true,
                startAndWait: false,
                exactInputResults: false,
                runScopedAgentBindings: false,
                secretReferenceOverlay: false,
            },
            { serverId: 'server_1', originSessionId: 'session_context' },
        )).resolves.toEqual({ ok: true, exactMachineId: 'machine_context' });
        expect(readMachineControlTargetForSessionMock).toHaveBeenCalledWith({
            serverId: 'server_1',
            sessionId: 'session_context',
        });
        expect(machineCapabilitiesDetectMock).toHaveBeenCalledWith(
            'machine_context',
            { requests: [{ id: 'tool.executionRuns' }] },
            expect.objectContaining({ serverId: 'server_1' }),
        );
    });

    it('retains the incumbent session-scoped transport instead of routing it through a machine', async () => {
        sessionExecutionRunStartMock.mockResolvedValue({ runId: 'run_1' });
        sessionExecutionRunListMock.mockResolvedValue({ runs: [] });
        sessionExecutionRunGetMock.mockResolvedValueOnce({ run: { runId: 'run_1', status: 'running' } });
        sessionExecutionRunWaitMock.mockResolvedValueOnce({
            ok: true,
            status: 'succeeded',
            result: { run: { runId: 'run_1', status: 'succeeded' } },
        });
        sessionExecutionRunSendMock.mockResolvedValue({ ok: true });
        sessionExecutionRunStopMock.mockResolvedValue({ ok: true });
        sessionExecutionRunActionMock.mockResolvedValue({ ok: true });
        const deps = createUiExecutionRunActionDeps();
        const opts = { serverId: 'server_1' };

        await deps.executionRunStart('session_1', { intent: 'delegate' }, opts);
        await deps.executionRunList('session_1', {}, opts);
        await deps.executionRunGet('session_1', { runId: 'run_1' }, opts);
        await deps.executionRunStop('session_1', { runId: 'run_1' }, opts);
        await deps.executionRunAction('session_1', { runId: 'run_1', actionId: 'review.apply' }, opts);
        await expect(deps.executionRunWait('session_1', { runId: 'run_1' }, opts))
            .resolves.toEqual({ ok: true, status: 'succeeded', result: { run: { runId: 'run_1', status: 'succeeded' } } });

        expect(sessionExecutionRunStartMock).toHaveBeenCalledWith('session_1', { intent: 'delegate' }, { serverId: 'server_1' });
        expect(sessionExecutionRunListMock).toHaveBeenCalledWith('session_1', {}, { serverId: 'server_1' });
        expect(sessionExecutionRunSendMock).not.toHaveBeenCalled();
        expect(sessionExecutionRunStopMock).toHaveBeenCalledWith('session_1', { runId: 'run_1' }, { serverId: 'server_1' });
        expect(sessionExecutionRunActionMock).toHaveBeenCalledWith(
            'session_1',
            { runId: 'run_1', actionId: 'review.apply' },
            { serverId: 'server_1' },
        );
        expect(sessionExecutionRunWaitMock).toHaveBeenLastCalledWith(
            'session_1',
            { runId: 'run_1' },
            { serverId: 'server_1' },
        );
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('carries the exact capability witness into the canonical Session Run-start owner', async () => {
        sessionExecutionRunStartMock.mockResolvedValue({ runId: 'run_1' });
        const deps = createUiExecutionRunActionDeps();

        await deps.executionRunStart('session_1', { intent: 'delegate' }, {
            serverId: 'server_1',
            exactMachineId: 'machine_admitted',
        });

        expect(sessionExecutionRunStartMock).toHaveBeenCalledWith(
            'session_1',
            { intent: 'delegate' },
            { serverId: 'server_1', expectedMachineId: 'machine_admitted' },
        );
    });
});
