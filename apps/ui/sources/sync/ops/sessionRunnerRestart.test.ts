import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeMock(params),
}));

describe('sessionRunnerRestart', () => {
    afterEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('calls the daemon-owned session-runner restart RPC with expected runner identity', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            status: 'restarted',
            sessionId: 's1',
        });

        const { restartStaleSessionRunner } = await import('./sessionRunnerRestart');

        await expect(restartStaleSessionRunner({
            sessionId: 's1',
            machineId: 'machine-1',
            serverId: 'server-1',
            expectedRunnerPid: 123,
            expectedProcessCommandHash: 'hash-old',
            expectedRunnerEntrypointIdentity: 'version:cli-old',
        })).resolves.toEqual({
            ok: true,
            status: 'restarted',
            sessionId: 's1',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
            payload: {
                sessionId: 's1',
                mode: 'if_stale',
                reason: 'ui_stale_runner_banner',
                expectedRunnerPid: 123,
                expectedProcessCommandHash: 'hash-old',
                expectedRunnerEntrypointIdentity: 'version:cli-old',
            },
            authorization: {
                kind: 'session.write',
                sessionId: 's1',
            },
        });
    });

    it('forces the current runner to restart after a session configuration change', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            status: 'restarted',
            sessionId: 's1',
        });

        const { restartSessionRunnerForConfiguration } = await import('./sessionRunnerRestart');

        await expect(restartSessionRunnerForConfiguration({
            sessionId: 's1',
            machineId: 'machine-1',
            serverId: 'server-1',
            expectedRunnerPid: 123,
        })).resolves.toEqual({
            ok: true,
            status: 'restarted',
            sessionId: 's1',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
            payload: {
                sessionId: 's1',
                mode: 'force_current_cli',
                reason: 'ui_stale_runner_banner',
                expectedRunnerPid: 123,
            },
            authorization: {
                kind: 'session.write',
                sessionId: 's1',
            },
        });
    });

    it('normalizes daemon restart statuses and fails closed on malformed results', async () => {
        const { normalizeRestartSessionRunnerResult } = await import('./sessionRunnerRestart');

        expect(normalizeRestartSessionRunnerResult({
            ok: true,
            status: 'restarted',
            sessionId: 's1',
        }, 's1')).toEqual({ ok: true, status: 'restarted', sessionId: 's1' });

        expect(normalizeRestartSessionRunnerResult({
            ok: false,
            status: 'runner_identity_changed',
            sessionId: 's1',
        }, 's1')).toEqual({ ok: false, status: 'runner_identity_changed', sessionId: 's1' });

        expect(normalizeRestartSessionRunnerResult({ ok: true, status: 'surprise' }, 's1')).toEqual({
            ok: false,
            status: 'failure',
            sessionId: 's1',
            error: 'malformed_session_runner_restart_result',
        });
    });

    it('maps canonical daemon skip and failure statuses into UI states', async () => {
        const { normalizeRestartSessionRunnerResult } = await import('./sessionRunnerRestart');

        expect(normalizeRestartSessionRunnerResult({
            ok: false,
            status: 'not_tracked',
            sessionId: 's1',
        }, 's1')).toEqual({ ok: false, status: 'ineligible', sessionId: 's1' });

        expect(normalizeRestartSessionRunnerResult({
            ok: false,
            status: 'busy',
            sessionId: 's1',
        }, 's1')).toEqual({ ok: false, status: 'busy', sessionId: 's1' });

        expect(normalizeRestartSessionRunnerResult({
            ok: false,
            status: 'spawn_failed',
            sessionId: 's1',
        }, 's1')).toEqual({ ok: false, status: 'failure', sessionId: 's1' });
    });

    it('reports unsupported daemon when the restart RPC is unavailable', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );

        const { restartStaleSessionRunner } = await import('./sessionRunnerRestart');

        await expect(restartStaleSessionRunner({
            sessionId: 's1',
            machineId: 'machine-1',
            expectedRunnerPid: 123,
            expectedProcessCommandHash: 'hash-old',
            expectedRunnerEntrypointIdentity: 'version:cli-old',
        })).resolves.toEqual({
            ok: false,
            status: 'unsupported_daemon',
            sessionId: 's1',
            error: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        });
    });

    it('preserves typed non-destructive refresh unsupported instead of generic ineligible', async () => {
        const { normalizeRestartSessionRunnerResult } = await import('./sessionRunnerRestart');
        expect(normalizeRestartSessionRunnerResult({
            ok: false,
            status: 'ineligible',
            sessionId: 'sess-1',
            reasonCode: 'non_destructive_refresh_unsupported',
        }, 'fallback')).toEqual({
            ok: false,
            status: 'refresh_unsupported',
            sessionId: 'sess-1',
        });
    });

    it('fetches daemon-owned session runner runtime status through the status RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            v: 1,
            sessionId: 's1',
            machineId: 'machine-1',
            daemonId: 'daemon-1',
            observedAtMs: 123,
            runner: {
                pid: 123,
                runtimeId: 'version:cli-old',
                cliVersion: 'cli-old',
                entrypointVersion: 'cli-old',
                processCommandHash: 'hash-old',
                entrypointSource: 'process_command',
                startedBy: 'daemon',
                startingMode: 'remote',
            },
            daemon: {
                cliVersion: 'cli-new',
                startedWithCliVersion: 'cli-new',
                currentEntrypointVersion: 'version:cli-new',
                currentEntrypointSource: 'launch_spec',
            },
            versionState: 'stale',
            statusSource: 'daemon_tracking',
            plannedRestart: { supported: true, eligible: true, disabledReason: null },
        });

        const { getSessionRunnerRuntimeStatus } = await import('./sessionRunnerRestart');

        await expect(getSessionRunnerRuntimeStatus({
            sessionId: 's1',
            machineId: 'machine-1',
            serverId: 'server-1',
        })).resolves.toMatchObject({
            sessionId: 's1',
            machineId: 'machine-1',
            versionState: 'stale',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET,
            payload: { sessionId: 's1' },
        });
    });

    it('fails closed when daemon status RPC is unavailable or malformed', async () => {
        const { getSessionRunnerRuntimeStatus } = await import('./sessionRunnerRestart');

        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );
        await expect(getSessionRunnerRuntimeStatus({
            sessionId: 's1',
            machineId: 'machine-1',
        })).resolves.toBeNull();

        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true });
        await expect(getSessionRunnerRuntimeStatus({
            sessionId: 's1',
            machineId: 'machine-1',
        })).resolves.toBeNull();
    });
});

function makeRuntimeState(overrides: Readonly<{
    pid?: number | null;
    versionState?: 'current' | 'stale' | 'unknown';
    processCommandHash?: string | null;
}> = {}) {
    return {
        v: 1 as const,
        sessionId: 's1',
        machineId: 'machine-1',
        daemonId: 'daemon-1',
        observedAtMs: 123,
        runner: {
            pid: overrides.pid === undefined ? 123 : overrides.pid,
            runtimeId: 'version:cli-old',
            cliVersion: 'cli-old',
            entrypointVersion: 'cli-old',
            processCommandHash: overrides.processCommandHash === undefined ? 'hash-old' : overrides.processCommandHash,
            entrypointSource: 'process_command' as const,
            startedBy: 'daemon' as const,
            startingMode: 'remote' as const,
        },
        daemon: {
            cliVersion: 'cli-new',
            startedWithCliVersion: 'cli-new',
            currentEntrypointVersion: 'version:cli-new',
            currentEntrypointSource: 'launch_spec' as const,
        },
        versionState: overrides.versionState ?? 'stale',
        statusSource: 'daemon_tracking' as const,
        plannedRestart: { supported: true, eligible: true, disabledReason: null },
    };
}

describe('didSessionRunnerRestartLand', () => {
    it('treats a runner now on the current CLI as landed', async () => {
        const { didSessionRunnerRestartLand } = await import('./sessionRunnerRestart');
        expect(didSessionRunnerRestartLand({
            state: makeRuntimeState({ versionState: 'current', pid: 123 }),
            expectedRunnerPid: 123,
        })).toBe(true);
    });

    it('treats a replaced runner PID as landed even before version is re-attested', async () => {
        const { didSessionRunnerRestartLand } = await import('./sessionRunnerRestart');
        expect(didSessionRunnerRestartLand({
            state: makeRuntimeState({ versionState: 'unknown', pid: 456 }),
            expectedRunnerPid: 123,
        })).toBe(true);
    });

    it('does not treat the unchanged stale runner as landed', async () => {
        const { didSessionRunnerRestartLand } = await import('./sessionRunnerRestart');
        expect(didSessionRunnerRestartLand({
            state: makeRuntimeState({ versionState: 'stale', pid: 123 }),
            expectedRunnerPid: 123,
        })).toBe(false);
        expect(didSessionRunnerRestartLand({ state: null, expectedRunnerPid: 123 })).toBe(false);
    });
});

describe('didForcedSessionRunnerRestartLand', () => {
    it('requires the targeted runner PID to be replaced', async () => {
        const { didForcedSessionRunnerRestartLand } = await import('./sessionRunnerRestart');
        expect(didForcedSessionRunnerRestartLand({
            state: makeRuntimeState({ versionState: 'current', pid: 123 }),
            expectedRunnerPid: 123,
        })).toBe(false);
        expect(didForcedSessionRunnerRestartLand({
            state: makeRuntimeState({ versionState: 'current', pid: 456 }),
            expectedRunnerPid: 123,
        })).toBe(true);
    });
});

describe('restartStaleSessionRunnerWithObserve', () => {
    const baseRequest = {
        sessionId: 's1',
        machineId: 'machine-1',
        serverId: 'server-1',
        expectedRunnerPid: 123,
        expectedProcessCommandHash: 'hash-old',
        expectedRunnerEntrypointIdentity: 'version:cli-old',
    } as const;

    it('returns a successful restart without observing', async () => {
        const { restartStaleSessionRunnerWithObserve } = await import('./sessionRunnerRestart');
        const restart = vi.fn(async () => ({ ok: true as const, status: 'restarted' as const, sessionId: 's1' }));
        const getStatus = vi.fn(async () => null);

        await expect(restartStaleSessionRunnerWithObserve(baseRequest, {
            restart,
            getStatus,
            sleep: async () => {},
        })).resolves.toEqual({ ok: true, status: 'restarted', sessionId: 's1' });
        expect(getStatus).not.toHaveBeenCalled();
    });

    it('does not observe definitive negatives such as busy', async () => {
        const { restartStaleSessionRunnerWithObserve } = await import('./sessionRunnerRestart');
        const restart = vi.fn(async () => ({ ok: false as const, status: 'busy' as const, sessionId: 's1' }));
        const getStatus = vi.fn(async () => null);

        await expect(restartStaleSessionRunnerWithObserve(baseRequest, {
            restart,
            getStatus,
            sleep: async () => {},
        })).resolves.toEqual({ ok: false, status: 'busy', sessionId: 's1' });
        expect(getStatus).not.toHaveBeenCalled();
    });

    it('reports success when an ack-lost failure is followed by an observed restart landing', async () => {
        const { restartStaleSessionRunnerWithObserve } = await import('./sessionRunnerRestart');
        const restart = vi.fn(async () => ({
            ok: false as const,
            status: 'failure' as const,
            sessionId: 's1',
            error: 'The operation was aborted due to timeout',
        }));
        // First poll: still the old runner (respawn not finished). Second poll: new runner.
        const getStatus = vi.fn()
            .mockResolvedValueOnce(makeRuntimeState({ versionState: 'stale', pid: 123 }))
            .mockResolvedValueOnce(makeRuntimeState({ versionState: 'current', pid: 456 }));

        await expect(restartStaleSessionRunnerWithObserve(baseRequest, {
            restart,
            getStatus,
            sleep: async () => {},
            observeAttempts: 4,
            observeIntervalMs: 0,
        })).resolves.toEqual({ ok: true, status: 'restarted', sessionId: 's1' });
        expect(getStatus).toHaveBeenCalledTimes(2);
        expect(getStatus).toHaveBeenLastCalledWith({
            sessionId: 's1',
            machineId: 'machine-1',
            serverId: 'server-1',
        });
    });

    it('preserves the failure when the runner never restarts within the observe window', async () => {
        const { restartStaleSessionRunnerWithObserve } = await import('./sessionRunnerRestart');
        const failure = { ok: false as const, status: 'failure' as const, sessionId: 's1' };
        const restart = vi.fn(async () => failure);
        const getStatus = vi.fn(async () => makeRuntimeState({ versionState: 'stale', pid: 123 }));

        await expect(restartStaleSessionRunnerWithObserve(baseRequest, {
            restart,
            getStatus,
            sleep: async () => {},
            observeAttempts: 3,
            observeIntervalMs: 0,
        })).resolves.toEqual(failure);
        expect(getStatus).toHaveBeenCalledTimes(3);
    });
});
