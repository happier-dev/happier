import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import {
    RPC_METHODS,
    SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
} from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

const runtimeState = {
    v: 1,
    sessionId: 's1',
    machineId: 'm1',
    daemonId: 'd1',
    observedAtMs: 1_700_000_000_000,
    runner: {
        pid: 123,
        runtimeId: 'runner-runtime-old',
        cliVersion: '1.0.0',
        entrypointVersion: 'entry-old',
        processCommandHash: 'hash-old',
        entrypointSource: 'process_command',
        startedBy: 'daemon',
        startingMode: 'remote',
    },
    daemon: {
        cliVersion: '1.1.0',
        startedWithCliVersion: '1.1.0',
        currentEntrypointVersion: 'runner-runtime-new',
        currentEntrypointSource: 'packaged_runtime',
    },
    versionState: 'stale',
    statusSource: 'daemon_tracking',
    plannedRestart: {
        supported: true,
        eligible: true,
        disabledReason: null,
    },
} as const;

describe('session runner restart op', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('calls the daemon session-runner restart RPC with daemon-published identity guards', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            status: 'restarted',
            sessionId: 's1',
        });

        const { restartSessionRunnerOnCurrentRuntime } = await import('./sessionRunnerRestart');
        const result = await restartSessionRunnerOnCurrentRuntime({
            runtimeState,
            serverId: 'server-1',
        });

        expect(result.status).toBe('restarted');
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'm1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                sessionId: 's1',
            },
            payload: {
                sessionId: 's1',
                mode: 'if_stale',
                reason: 'ui_stale_runner_banner',
                expectedRunnerPid: 123,
                expectedProcessCommandHash: 'hash-old',
                expectedRunnerEntrypointIdentity: 'runner-runtime-old',
            },
        });
    });

    it('forces one Provider binding recovery with an exact security-change confirmation', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            status: 'restarted',
            sessionId: 's1',
        });

        const { restartSessionRunnerForProviderBindingChange } = await import('./sessionRunnerRestart');
        await expect(restartSessionRunnerForProviderBindingChange({
            runtimeState,
            serverId: 'server-1',
            launchBinding: {
                v: 1,
                connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
                contributionKey: null,
                connectionRevision: 1,
                protocol: 'openai-responses',
                materialization: 'engineConfig',
                compatibilityFingerprint: 'compatibility:v1:a',
                bindingSecurityFingerprint: 'binding-security:v1:a',
                displaySnapshot: {
                    providerName: 'Gateway',
                    connectionName: 'Work',
                    connectionRole: 'named',
                    connectionDisplayNameMode: 'custom',
                },
            },
            nextBindingSecurityFingerprint: 'binding-security:v1:b',
        })).resolves.toMatchObject({ status: 'restarted' });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                sessionId: 's1',
                mode: 'force_current_cli',
                reason: 'provider_binding_change_recovery',
                providerBindingSecurityChangeConfirmationV1: {
                    v: 1,
                    sessionId: 's1',
                    connectionId: 'pc_gateway',
                    previousBindingSecurityFingerprint: 'binding-security:v1:a',
                    nextBindingSecurityFingerprint: 'binding-security:v1:b',
                },
            }),
        }));
    });

    it('fetches daemon-owned session runner runtime status through the status RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce(runtimeState);

        const { getSessionRunnerRuntimeStatus } = await import('./sessionRunnerRestart');
        await expect(getSessionRunnerRuntimeStatus({
            sessionId: 's1',
            machineId: 'm1',
            serverId: 'server-1',
        })).resolves.toMatchObject({
            sessionId: 's1',
            machineId: 'm1',
            versionState: 'stale',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'm1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET,
            payload: { sessionId: 's1' },
        });
    });

    it('returns null for unsupported or malformed status RPC results', async () => {
        const { getSessionRunnerRuntimeStatus } = await import('./sessionRunnerRestart');

        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'METHOD_NOT_FOUND',
        });
        await expect(getSessionRunnerRuntimeStatus({
            sessionId: 's1',
            machineId: 'm1',
        })).resolves.toBeNull();

        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true });
        await expect(getSessionRunnerRuntimeStatus({
            sessionId: 's1',
            machineId: 'm1',
        })).resolves.toBeNull();
    });

    it('returns unsupported_daemon without throwing for unavailable daemon RPCs', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'METHOD_NOT_FOUND',
        });

        const { restartSessionRunnerOnCurrentRuntime } = await import('./sessionRunnerRestart');
        await expect(restartSessionRunnerOnCurrentRuntime({ runtimeState })).resolves.toEqual(expect.objectContaining({
            ok: false,
            status: 'unsupported_daemon',
            reasonCode: 'unsupported_daemon_version',
            sessionId: 's1',
        }));
    });

    it('fails closed without throwing for invalid daemon responses or missing machine identity', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ nope: true });

        const { restartSessionRunnerOnCurrentRuntime } = await import('./sessionRunnerRestart');
        await expect(restartSessionRunnerOnCurrentRuntime({ runtimeState })).resolves.toEqual(expect.objectContaining({
            ok: false,
            status: 'partial_failure',
            sessionId: 's1',
        }));

        await expect(restartSessionRunnerOnCurrentRuntime({
            runtimeState: { ...runtimeState, machineId: null },
        })).resolves.toEqual(expect.objectContaining({
            ok: false,
            status: 'unsupported_daemon',
            sessionId: 's1',
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    });

    it('does not call the daemon restart RPC without runner identity guards', async () => {
        const { restartSessionRunnerOnCurrentRuntime } = await import('./sessionRunnerRestart');

        await expect(restartSessionRunnerOnCurrentRuntime({
            runtimeState: {
                ...runtimeState,
                runner: {
                    ...runtimeState.runner,
                    runtimeId: null,
                },
            },
        })).resolves.toEqual(expect.objectContaining({
            ok: false,
            status: 'version_unknown',
            reasonCode: 'runner_entrypoint_unknown',
            sessionId: 's1',
        }));
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });
});
