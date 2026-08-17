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

    it('calls the strict V1 restart RPC with daemon-published aggregate guards', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            status: 'restarted',
            sessionId: 's1',
        });

        const { restartSessionRunnerOnCurrentRuntime } = await import('./sessionRunnerRestart');
        await expect(restartSessionRunnerOnCurrentRuntime({
            runtimeState,
            serverId: 'server-1',
        })).resolves.toMatchObject({ status: 'restarted' });

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

    it('forces one Provider binding recovery through attested V2 without widening V1', async () => {
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
            runnerProcessIdentity: {
                pid: 123,
                processStartTimeMs: 1_700_000_000_000,
            },
        })).resolves.toMatchObject({ status: 'restarted' });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2,
            payload: expect.objectContaining({
                v: 2,
                sessionId: 's1',
                mode: 'force_current_cli',
                reason: 'provider_binding_change_recovery',
                expectedRunnerProcessIdentity: {
                    pid: 123,
                    processStartTimeMs: 1_700_000_000_000,
                },
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

    it('returns typed unsupported before effect when recovery V2 is unavailable', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'METHOD_NOT_FOUND',
        });

        const { restartSessionRunnerForProviderBindingChange } = await import('./sessionRunnerRestart');
        await expect(restartSessionRunnerForProviderBindingChange({
            runtimeState,
            runnerProcessIdentity: {
                pid: 123,
                processStartTimeMs: 1_700_000_000_000,
            },
        })).resolves.toMatchObject({
            status: 'unsupported_daemon',
            reasonCode: 'unsupported_daemon_version',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2,
        }));
    });

    it('does not attempt recovery without the V2 process-start witness', async () => {
        const { restartSessionRunnerForProviderBindingChange } = await import('./sessionRunnerRestart');
        await expect(restartSessionRunnerForProviderBindingChange({
            runtimeState,
            runnerProcessIdentity: null,
        })).resolves.toMatchObject({
            status: 'unsupported_daemon',
            reasonCode: 'unsupported_daemon_version',
        });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('fetches the strict V2 daemon status envelope with the exact runner witness', async () => {
        const runnerProcessIdentity = {
            pid: 123,
            processStartTimeMs: 1_700_000_000_000,
        } as const;
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            v: 2,
            state: runtimeState,
            runnerProcessIdentity,
        });

        const { getSessionRunnerRuntimeStatusSnapshot } = await import('./sessionRunnerRestart');
        await expect(getSessionRunnerRuntimeStatusSnapshot({
            sessionId: 's1',
            machineId: 'm1',
            serverId: 'server-1',
        })).resolves.toEqual({ state: runtimeState, runnerProcessIdentity });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'm1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET,
            payload: { sessionId: 's1' },
        });
    });

    it('falls back to strict V1 status with unknown active truth when V2 is unsupported', async () => {
        const { getSessionRunnerRuntimeStatusSnapshot } = await import('./sessionRunnerRestart');

        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'METHOD_NOT_FOUND',
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce(runtimeState);
        await expect(getSessionRunnerRuntimeStatusSnapshot({
            sessionId: 's1',
            machineId: 'm1',
        })).resolves.toEqual({ state: runtimeState, runnerProcessIdentity: null });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET,
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET,
        }));
    });

    it('fails a malformed V2 witness closed and retains only a valid V1 aggregate', async () => {
        const { getSessionRunnerRuntimeStatusSnapshot } = await import('./sessionRunnerRestart');

        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            v: 2,
            state: runtimeState,
            runnerProcessIdentity: { pid: 123 },
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce(runtimeState);
        await expect(getSessionRunnerRuntimeStatusSnapshot({
            sessionId: 's1',
            machineId: 'm1',
        })).resolves.toEqual({ state: runtimeState, runnerProcessIdentity: null });
    });

    it('returns null when neither V2 nor V1 supplies a valid status', async () => {
        const { getSessionRunnerRuntimeStatusSnapshot } = await import('./sessionRunnerRestart');

        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true });
        await expect(getSessionRunnerRuntimeStatusSnapshot({
            sessionId: 's1',
            machineId: 'm1',
        })).resolves.toBeNull();
    });

    it('fails closed without throwing for invalid restart responses or missing machine identity', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ nope: true });

        const { restartSessionRunnerOnCurrentRuntime } = await import('./sessionRunnerRestart');
        await expect(restartSessionRunnerOnCurrentRuntime({ runtimeState })).resolves.toMatchObject({
            ok: false,
            status: 'partial_failure',
            sessionId: 's1',
        });
        await expect(restartSessionRunnerOnCurrentRuntime({
            runtimeState: { ...runtimeState, machineId: null },
        })).resolves.toMatchObject({
            ok: false,
            status: 'unsupported_daemon',
            sessionId: 's1',
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    });

    it('does not call the daemon without the V1 runner identity guards', async () => {
        const { restartSessionRunnerOnCurrentRuntime } = await import('./sessionRunnerRestart');

        await expect(restartSessionRunnerOnCurrentRuntime({
            runtimeState: {
                ...runtimeState,
                runner: { ...runtimeState.runner, runtimeId: null },
            },
        })).resolves.toMatchObject({
            ok: false,
            status: 'version_unknown',
            reasonCode: 'runner_entrypoint_unknown',
        });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });
});
