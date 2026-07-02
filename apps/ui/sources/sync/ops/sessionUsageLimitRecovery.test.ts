import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());
const storageState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => sessionRpcWithServerScopeMock(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeMock(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => storageState.current,
    },
}));

describe('sessionUsageLimitRecovery ops', () => {
    beforeEach(() => {
        sessionRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
        storageState.current = {};
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
    });

    it('arms wait-and-resume through the session-scoped usage-limit RPC lane', async () => {
        sessionRpcWithServerScopeMock.mockResolvedValue({ ok: true, status: 'waiting', sessionId: 'session-1' });
        const { sessionUsageLimitWaitResumeEnable } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitWaitResumeEnable('session-1', {
            issueFingerprint: 'usage-limit:session-1:1',
            remember: true,
            resumePromptMode: 'off',
        })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'session-1' });

        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
            payload: {
                sessionId: 'session-1',
                issueFingerprint: 'usage-limit:session-1:1',
                remember: true,
                resumePromptMode: 'off',
            },
        });
    });

    it('passes the custom resume prompt mode through the wait-and-resume payload', async () => {
        sessionRpcWithServerScopeMock.mockResolvedValue({ ok: true, status: 'waiting', sessionId: 'session-1' });
        const { sessionUsageLimitWaitResumeEnable } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitWaitResumeEnable('session-1', {
            issueFingerprint: 'usage-limit:session-1:1',
            remember: true,
            resumePromptMode: 'custom',
        })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'session-1' });

        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
            payload: {
                sessionId: 'session-1',
                issueFingerprint: 'usage-limit:session-1:1',
                remember: true,
                resumePromptMode: 'custom',
            },
        });
    });

    it('normalizes nested wait-and-resume recovery status responses', async () => {
        sessionRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, recovery: { status: 'waiting' } });
        const { sessionUsageLimitWaitResumeEnable } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitWaitResumeEnable('session-1', {
            issueFingerprint: 'usage-limit:session-1:1',
            remember: true,
        })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'session-1' });
    });

    it('uses an explicit route server id when one is provided', async () => {
        sessionRpcWithServerScopeMock.mockResolvedValue({ ok: true, status: 'waiting', sessionId: 'session-1' });
        const { sessionUsageLimitWaitResumeEnable } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitWaitResumeEnable(
            'session-1',
            {
                issueFingerprint: 'usage-limit:session-1:2',
                remember: false,
            },
            { serverId: 'server-route' },
        )).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'session-1' });

        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-route',
            method: SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
            payload: {
                sessionId: 'session-1',
                issueFingerprint: 'usage-limit:session-1:2',
                remember: false,
            },
        });
    });

    it('checks recovery immediately through the generic usage-limit RPC lane', async () => {
        sessionRpcWithServerScopeMock.mockResolvedValue({ ok: true, status: 'ready' });
        const { sessionUsageLimitCheckNow } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitCheckNow('session-1')).resolves.toEqual({
            ok: true,
            status: 'ready',
            sessionId: 'session-1',
        });

        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
            payload: { sessionId: 'session-1' },
        });
    });

    it('normalizes successful rate-limited check-now responses with retry metadata', async () => {
        sessionRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            status: 'rate_limited',
            retryAfterMs: 4_000,
        });
        const { sessionUsageLimitCheckNow } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitCheckNow('session-1')).resolves.toEqual({
            ok: false,
            status: 'rate_limited',
            sessionId: 'session-1',
            errorCode: 'session_usage_limit_recovery_rate_limited',
            retryAfterMs: 4_000,
        });
    });

    it('checks inactive sessions through the daemon-scoped usage-limit control', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: false,
                    metadata: {
                        machineId: 'machine-1',
                        path: '/repo',
                    },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'ready' });
        const { sessionUsageLimitCheckNow } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitCheckNow('session-1')).resolves.toEqual({
            ok: true,
            status: 'ready',
            sessionId: 'session-1',
        });

        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
            payload: { sessionId: 'session-1' },
        });
    });

    it('refreshes stale inactive machine targets before falling check-now back to session RPC', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: false,
                    metadata: {
                        host: 'workstation.local',
                        path: '/repo',
                    },
                },
            },
            machines: {},
        };
        const refreshMachineTargets = vi.fn(async () => {
            storageState.current = {
                ...storageState.current,
                machines: {
                    'machine-1': {
                        id: 'machine-1',
                        active: true,
                        metadata: { host: 'workstation.local' },
                    },
                },
            };
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'ready' });
        const { sessionUsageLimitCheckNow } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitCheckNow('session-1', { refreshMachineTargets })).resolves.toEqual({
            ok: true,
            status: 'ready',
            sessionId: 'session-1',
        });

        expect(refreshMachineTargets).toHaveBeenCalledTimes(1);
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
            payload: { sessionId: 'session-1' },
        });
    });

    it('refreshes stale inactive machine targets for daemon-only usage-limit controls', async () => {
        const installStaleInactiveSession = () => {
            storageState.current = {
                sessions: {
                    'session-1': {
                        active: false,
                        metadata: {
                            host: 'workstation.local',
                            path: '/repo',
                        },
                    },
                },
                machines: {},
            };
        };
        const refreshMachineTargets = vi.fn(async () => {
            storageState.current = {
                ...storageState.current,
                machines: {
                    'machine-1': {
                        id: 'machine-1',
                        active: true,
                        metadata: { host: 'workstation.local' },
                    },
                },
            };
        });
        const {
            sessionUsageLimitSwitchAccountNow,
            sessionUsageLimitWaitResumeCancel,
            sessionUsageLimitWaitResumeEnable,
        } = await import('./sessionUsageLimitRecovery');

        installStaleInactiveSession();
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'waiting' });
        await expect(sessionUsageLimitWaitResumeEnable('session-1', {
            issueFingerprint: 'usage-limit:session-1:1',
            remember: false,
        }, { refreshMachineTargets })).resolves.toEqual({
            ok: true,
            status: 'waiting',
            sessionId: 'session-1',
        });

        installStaleInactiveSession();
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'cancelled' });
        await expect(sessionUsageLimitWaitResumeCancel('session-1', {
            issueFingerprint: 'usage-limit:session-1:1',
        }, { refreshMachineTargets })).resolves.toEqual({
            ok: true,
            status: 'cancelled',
            sessionId: 'session-1',
        });

        installStaleInactiveSession();
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'waiting' });
        await expect(sessionUsageLimitSwitchAccountNow('session-1', {
            provider: 'codex',
            refreshMachineTargets,
        })).resolves.toEqual({
            ok: true,
            status: 'waiting',
            sessionId: 'session-1',
        });

        expect(refreshMachineTargets).toHaveBeenCalledTimes(3);
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(3);
    });

    it('routes active switch-account recovery through session RPC before daemon fallback', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: true,
                    metadata: {
                        machineId: 'machine-1',
                        path: '/repo',
                    },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        sessionRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'switch_observed', sessionId: 'session-1' });
        const { sessionUsageLimitSwitchAccountNow } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitSwitchAccountNow('session-1', {
            provider: ' codex ',
            serverId: 'server-route',
        })).resolves.toEqual({ ok: true, status: 'switch_observed', sessionId: 'session-1' });

        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-route',
            method: SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
            payload: {
                sessionId: 'session-1',
                provider: 'codex',
                operation: 'switch_account_now',
            },
        });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('retries switch-account through daemon machine RPC when stale active session RPC is method-not-found', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: true,
                    metadata: {
                        machineId: 'machine-1',
                        path: '/repo',
                    },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        sessionRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'waiting', sessionId: 'session-1' });
        const { sessionUsageLimitSwitchAccountNow } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitSwitchAccountNow('session-1', {
            provider: ' codex ',
            serverId: 'server-route',
        })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'session-1' });

        const payload = {
            sessionId: 'session-1',
            provider: 'codex',
            operation: 'switch_account_now',
        };
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-route',
            method: SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
            payload,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-route',
            method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
            payload,
        });
    });

    it('retries switch-account through daemon machine RPC when stale active session RPC times out', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: true,
                    metadata: {
                        machineId: 'machine-1',
                        path: '/repo',
                    },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        sessionRpcWithServerScopeMock.mockRejectedValueOnce(new Error('operation has timed out'));
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'waiting', sessionId: 'session-1' });
        const { sessionUsageLimitSwitchAccountNow } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitSwitchAccountNow('session-1', {
            provider: ' codex ',
            serverId: 'server-route',
        })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'session-1' });

        const payload = {
            sessionId: 'session-1',
            provider: 'codex',
            operation: 'switch_account_now',
        };
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-route',
            method: SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
            payload,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-route',
            method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
            payload,
        });
    });

    it('normalizes nested switch-now daemon envelopes and preserves typed diagnostics', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: false,
                    metadata: {
                        machineId: 'machine-1',
                        path: '/repo',
                    },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        const uxDiagnostic = {
            code: 'recovery_retry_scheduled',
            failurePhase: 'runtime_auth_recovery',
            source: 'usage_limit_recovery',
            serviceId: 'openai',
            agentId: 'codex',
            retryable: true,
            suggestedActions: ['retry'],
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            result: {
                ok: true,
                status: 'switch_attempted',
                result: { status: 'switched' },
                uxDiagnostic,
            },
        });
        const { sessionUsageLimitSwitchAccountNow } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitSwitchAccountNow('session-1', {
            provider: ' codex ',
            serverId: 'server-route',
        })).resolves.toEqual({
            ok: true,
            status: 'switch_applied',
            sessionId: 'session-1',
            uxDiagnostic,
        });
    });

    it('checks stale-inactive live sessions through the session-scoped RPC lane when no daemon machine target exists', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: false,
                    metadata: {
                        path: '/repo',
                    },
                },
            },
            machines: {},
        };
        sessionRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'resumed' });
        const { sessionUsageLimitCheckNow } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitCheckNow('session-1')).resolves.toEqual({
            ok: true,
            status: 'resumed',
            sessionId: 'session-1',
        });

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
            payload: { sessionId: 'session-1' },
        });
    });

    it('forwards check-now provider hints to active session and daemon fallback RPCs', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: true,
                    metadata: {
                        machineId: 'machine-1',
                        path: '/repo',
                    },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        sessionRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'ready' });
        const { sessionUsageLimitCheckNow } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitCheckNow('session-1', { provider: ' codex ' })).resolves.toEqual({
            ok: true,
            status: 'ready',
            sessionId: 'session-1',
        });

        const payload = { sessionId: 'session-1', provider: 'codex' };
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({ payload }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({ payload }));
    });

    it('retries check-now through daemon machine RPC when stale active session RPC is method-not-found', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: true,
                    metadata: {
                        machineId: 'machine-1',
                        path: '/repo',
                    },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        sessionRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'ready' });
        const { sessionUsageLimitCheckNow } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitCheckNow('session-1')).resolves.toEqual({
            ok: true,
            status: 'ready',
            sessionId: 'session-1',
        });

        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
            payload: { sessionId: 'session-1' },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
            payload: { sessionId: 'session-1' },
        });
    });

    it('keeps the session-scoped RPC error when stale active fallback has no daemon machine target', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: true,
                    metadata: {
                        path: '/repo',
                    },
                },
            },
            machines: {},
        };
        sessionRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );
        const { sessionUsageLimitCheckNow } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitCheckNow('session-1')).resolves.toEqual({
            ok: false,
            status: 'session_unreachable',
            sessionId: 'session-1',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        });

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('retries enable through daemon machine RPC when stale active session RPC reports session-rpc-failed', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: true,
                    metadata: {
                        machineId: 'machine-1',
                        path: '/repo',
                    },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        sessionRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: false,
            error: 'session_rpc_failed',
            errorCode: 'session_rpc_failed',
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'waiting' });
        const { sessionUsageLimitWaitResumeEnable } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitWaitResumeEnable('session-1', {
            issueFingerprint: 'usage-limit:session-1:1',
            remember: true,
        })).resolves.toEqual({
            ok: true,
            status: 'waiting',
            sessionId: 'session-1',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
            payload: {
                sessionId: 'session-1',
                issueFingerprint: 'usage-limit:session-1:1',
                remember: true,
            },
        });
    });

    it('retries cancel through daemon machine RPC when stale active session RPC reports method-not-available', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: true,
                    metadata: {
                        machineId: 'machine-1',
                        path: '/repo',
                    },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        sessionRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: false,
            error: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'cancelled', sessionId: 'session-1' });
        const { sessionUsageLimitWaitResumeCancel } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitWaitResumeCancel('session-1', {
            issueFingerprint: 'usage-limit:session-1:1',
        })).resolves.toEqual({ ok: true, status: 'cancelled', sessionId: 'session-1' });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
            payload: {
                sessionId: 'session-1',
                issueFingerprint: 'usage-limit:session-1:1',
            },
        });
    });

    it('normalizes nested cancel recovery status responses', async () => {
        sessionRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, recovery: { status: 'cancelled' } });
        const { sessionUsageLimitWaitResumeCancel } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitWaitResumeCancel('session-1', {
            issueFingerprint: 'usage-limit:session-1:1',
        })).resolves.toEqual({ ok: true, status: 'cancelled', sessionId: 'session-1' });
    });
});
