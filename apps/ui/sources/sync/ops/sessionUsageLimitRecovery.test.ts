import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('sessionUsageLimitRecovery', () => {
    afterEach(() => {
        sessionRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
        storageState.current = {};
    });

    it('enables wait-resume through the preferred session RPC scope', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        sessionRpcWithServerScopeMock
            .mockResolvedValueOnce({ ok: true, recovery: { status: 'waiting' } })
            .mockResolvedValueOnce({ ok: true, status: 'ready' });

        const { sessionUsageLimitWaitResumeEnable } = await import('./sessionUsageLimitRecovery');
        const response = await sessionUsageLimitWaitResumeEnable('session-1', {
            issueFingerprint: 'usage-limit:codex:turn-1:1:no-reset',
            rememberPreference: true,
            resumePromptMode: 'off',
        });

        expect(resolvePreferredServerIdForSessionIdMock).toHaveBeenCalledWith('session-1');
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
            payload: {
                sessionId: 'session-1',
                issueFingerprint: 'usage-limit:codex:turn-1:1:no-reset',
                rememberPreference: true,
                resumePromptMode: 'off',
            },
        });
        expect(response).toEqual({ ok: true, status: 'waiting' });
    });

    it('forwards the custom resume prompt mode through the wait-resume enable payload', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        sessionRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, recovery: { status: 'waiting' } });

        const { sessionUsageLimitWaitResumeEnable } = await import('./sessionUsageLimitRecovery');
        await sessionUsageLimitWaitResumeEnable('session-1', {
            resumePromptMode: 'custom',
        });

        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                sessionId: 'session-1',
                resumePromptMode: 'custom',
            }),
        }));
    });

    it('cancels wait-resume and checks current availability through usage-limit RPC methods', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        sessionRpcWithServerScopeMock
            .mockResolvedValueOnce({ ok: true, recovery: { status: 'cancelled' } })
            .mockResolvedValueOnce({ ok: true, recovery: { status: 'ready' } });

        const {
            sessionUsageLimitCheckNow,
            sessionUsageLimitWaitResumeCancel,
        } = await import('./sessionUsageLimitRecovery');

        await expect(sessionUsageLimitWaitResumeCancel('session-1', {
            issueFingerprint: 'issue-a',
            armedAtMs: 1,
            runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
        })).resolves.toEqual({
            ok: true,
            status: 'cancelled',
        });
        await expect(sessionUsageLimitCheckNow('session-1')).resolves.toEqual({
            ok: true,
            status: 'ready',
        });

        expect(sessionRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, {
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
            payload: {
                sessionId: 'session-1',
                issueFingerprint: 'issue-a',
                armedAtMs: 1,
                runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
            },
        });
        expect(sessionRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, {
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
            payload: { sessionId: 'session-1' },
        });
    });

    it('checks inactive sessions through the daemon-scoped usage-limit control', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
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
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
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

    it('refreshes an unverified metadata-direct machine target before daemon recovery', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
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
            machines: {},
        };
        const refreshMachineTargets = vi.fn(async () => {
            storageState.current = {
                ...storageState.current,
                machines: {
                    'machine-1': { id: 'machine-1', active: true },
                },
            };
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'waiting' });

        const { sessionUsageLimitSwitchAccountNow } = await import('./sessionUsageLimitRecovery');
        await expect(sessionUsageLimitSwitchAccountNow('session-1', {
            provider: 'claude',
            refreshMachineTargets,
        })).resolves.toEqual({
            ok: true,
            status: 'waiting',
        });

        expect(refreshMachineTargets).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
            payload: {
                sessionId: 'session-1',
                provider: 'claude',
                operation: 'switch_account_now',
            },
        });
    });

    it('refreshes stale inactive machine targets for daemon-only usage-limit controls', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
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
            issueFingerprint: 'usage-limit:codex:turn-1:1:no-reset',
            rememberPreference: false,
        }, { refreshMachineTargets })).resolves.toEqual({
            ok: true,
            status: 'waiting',
        });

        installStaleInactiveSession();
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'cancelled' });
        await expect(sessionUsageLimitWaitResumeCancel('session-1', { issueFingerprint: 'issue-a', armedAtMs: 1 }, { refreshMachineTargets })).resolves.toEqual({
            ok: true,
            status: 'cancelled',
        });

        installStaleInactiveSession();
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'waiting' });
        await expect(sessionUsageLimitSwitchAccountNow('session-1', {
            provider: 'codex',
            refreshMachineTargets,
        })).resolves.toEqual({
            ok: true,
            status: 'waiting',
        });

        expect(refreshMachineTargets).toHaveBeenCalledTimes(3);
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(3);
    });

    it('falls back from inert active wait-resume success to daemon recovery when a real machine result is available', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
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
            ok: true,
            recovery: {
                status: 'waiting',
                resetAtMs: null,
                nextCheckAtMs: null,
                maxAttempts: 0,
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            status: 'waiting',
            sessionId: 'session-1',
            retryAfterMs: 30_000,
        });

        const { sessionUsageLimitWaitResumeEnable } = await import('./sessionUsageLimitRecovery');
        await expect(sessionUsageLimitWaitResumeEnable('session-1', {
            issueFingerprint: 'usage-limit:codex:turn-1:1:no-reset',
            rememberPreference: false,
            resumePromptMode: 'standard',
        })).resolves.toEqual({
            ok: true,
            status: 'waiting',
            retryAfterMs: 30_000,
        });

        const payload = {
            sessionId: 'session-1',
            issueFingerprint: 'usage-limit:codex:turn-1:1:no-reset',
            resumePromptMode: 'standard',
        };
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({ payload }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({ payload }));
    });

    it('surfaces inert inactive wait-resume success as unsupported instead of waiting', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        storageState.current = {
            sessions: {
                'session-1': {
                    active: false,
                    metadata: { machineId: 'machine-1', path: '/repo' },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            recovery: {
                status: 'waiting',
                resetAtMs: null,
                nextCheckAtMs: null,
                maxAttempts: 0,
            },
        });

        const { sessionUsageLimitWaitResumeEnable } = await import('./sessionUsageLimitRecovery');
        await expect(sessionUsageLimitWaitResumeEnable('session-1')).resolves.toEqual({
            ok: false,
            status: 'unsupported',
            error: 'session_usage_limit_recovery_inert_waiting',
            errorCode: 'session_usage_limit_recovery_inert_waiting',
        });
    });

    it('routes active switch-account recovery through session RPC before daemon fallback', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
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
            resumePromptMode: 'off',
            serverId: 'server-route',
        })).resolves.toEqual({
            ok: true,
            status: 'waiting',
        });

        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-route',
            method: SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
            payload: {
                sessionId: 'session-1',
                provider: 'codex',
                operation: 'switch_account_now',
                resumePromptMode: 'off',
            },
        });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('normalizes daemon-wrapped switch-account recovery success results', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        storageState.current = {
            sessions: {
                'session-1': {
                    active: false,
                    metadata: { machineId: 'machine-1', path: '/repo' },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            result: {
                status: 'switch_attempted',
                result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
            },
        });

        const { sessionUsageLimitSwitchAccountNow } = await import('./sessionUsageLimitRecovery');
        await expect(sessionUsageLimitSwitchAccountNow('session-1', { provider: 'codex' })).resolves.toEqual({
            ok: true,
            status: 'waiting',
        });
    });

    it('maps protocol switch-applied recovery results to the waiting presentation status', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: false,
                    metadata: { machineId: 'machine-1', path: '/repo' },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            status: 'switch_applied',
            sessionId: 'session-1',
        });

        const { sessionUsageLimitSwitchAccountNow } = await import('./sessionUsageLimitRecovery');
        await expect(sessionUsageLimitSwitchAccountNow('session-1', { provider: 'codex' })).resolves.toEqual({
            ok: true,
            status: 'waiting',
        });
    });

    it('normalizes daemon-wrapped switch-account no-eligible-member results', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: false,
                    metadata: { machineId: 'machine-1', path: '/repo' },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            result: {
                status: 'switch_attempted',
                result: { status: 'no_eligible_member' },
            },
        });

        const { sessionUsageLimitSwitchAccountNow } = await import('./sessionUsageLimitRecovery');
        await expect(sessionUsageLimitSwitchAccountNow('session-1', { provider: 'codex' })).resolves.toEqual({
            ok: false,
            status: 'exhausted',
            error: 'session_usage_limit_recovery_control_no_eligible_member',
            errorCode: 'session_usage_limit_recovery_control_no_eligible_member',
        });
    });

    it('preserves daemon-wrapped runtime-auth recovery diagnostics during switch-account recovery', async () => {
        const uxDiagnostic = {
            code: 'recovery_retry_scheduled',
            failurePhase: 'runtime_auth_recovery',
            source: 'runtime_auth_recovery',
            retryable: true,
            diagnostics: { reason: 'generation_apply_failed', nextRetryAtMs: 12_000 },
            suggestedActions: [],
        };
        storageState.current = {
            sessions: {
                'session-1': {
                    active: false,
                    metadata: { machineId: 'machine-1', path: '/repo' },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            result: {
                status: 'recovery_retry_scheduled',
                uxDiagnostic,
                recovery: { status: 'scheduled', nextRetryAtMs: 12_000 },
            },
        });

        const { sessionUsageLimitSwitchAccountNow } = await import('./sessionUsageLimitRecovery');
        await expect(sessionUsageLimitSwitchAccountNow('session-1', { provider: 'codex' })).resolves.toEqual({
            ok: true,
            status: 'waiting',
            uxDiagnostic,
        });
    });

    it('preserves typed malformed protocol recovery results', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: false,
                    metadata: { machineId: 'machine-1', path: '/repo' },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: false,
            status: 'malformed_response',
            sessionId: 'session-1',
            errorCode: 'malformed_session_usage_limit_recovery_operation_result',
            diagnostics: { status: 'broken' },
        });

        const { sessionUsageLimitCheckNow } = await import('./sessionUsageLimitRecovery');
        await expect(sessionUsageLimitCheckNow('session-1')).resolves.toEqual({
            ok: false,
            status: 'malformed_response',
            error: 'malformed_session_usage_limit_recovery_operation_result',
            errorCode: 'malformed_session_usage_limit_recovery_operation_result',
            diagnostics: { status: 'broken' },
        });
    });

    it('preserves check-now rate-limit retry metadata from the daemon response', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: false,
                    metadata: { machineId: 'machine-1', path: '/repo' },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: false,
            error: 'probe_rate_limited',
            errorCode: 'probe_rate_limited',
            retryAfterMs: 4_000,
        });

        const { sessionUsageLimitCheckNow } = await import('./sessionUsageLimitRecovery');
        await expect(sessionUsageLimitCheckNow('session-1')).resolves.toEqual({
            ok: false,
            status: 'rate_limited',
            error: 'probe_rate_limited',
            errorCode: 'probe_rate_limited',
            retryAfterMs: 4_000,
        });
    });

    it('normalizes successful rate-limited daemon check-now responses', async () => {
        storageState.current = {
            sessions: {
                'session-1': {
                    active: false,
                    metadata: { machineId: 'machine-1', path: '/repo' },
                },
            },
            machines: {
                'machine-1': { id: 'machine-1', active: true },
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            status: 'rate_limited',
            retryAfterMs: 4_000,
        });

        const { sessionUsageLimitCheckNow } = await import('./sessionUsageLimitRecovery');
        await expect(sessionUsageLimitCheckNow('session-1')).resolves.toEqual({
            ok: false,
            status: 'rate_limited',
            error: 'session_usage_limit_recovery_rate_limited',
            errorCode: 'session_usage_limit_recovery_rate_limited',
            retryAfterMs: 4_000,
        });
    });

    it('checks a stale-inactive live session through session RPC when no daemon machine target is available', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
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
        });

        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
            payload: { sessionId: 'session-1' },
        });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('retries switch-account through daemon machine RPC when stale active session RPC is method-not-found', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
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
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'switch_observed', sessionId: 'session-1' });

        const { sessionUsageLimitSwitchAccountNow } = await import('./sessionUsageLimitRecovery');
        await expect(sessionUsageLimitSwitchAccountNow('session-1', { provider: ' codex ' })).resolves.toEqual({
            ok: true,
            status: 'waiting',
        });

        const payload = { sessionId: 'session-1', provider: 'codex', operation: 'switch_account_now' as const };
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({ payload }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({ payload }));
    });

    it('retries switch-account through daemon machine RPC when stale active session RPC times out', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
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
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, status: 'switch_observed', sessionId: 'session-1' });

        const { sessionUsageLimitSwitchAccountNow } = await import('./sessionUsageLimitRecovery');
        await expect(sessionUsageLimitSwitchAccountNow('session-1', { provider: ' codex ' })).resolves.toEqual({
            ok: true,
            status: 'waiting',
        });

        const payload = { sessionId: 'session-1', provider: 'codex', operation: 'switch_account_now' as const };
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({ payload }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({ payload }));
    });

    it('forwards check-now provider hints to active session and daemon fallback RPCs', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
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
        });

        const payload = { sessionId: 'session-1', provider: 'codex' };
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({ payload }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({ payload }));
    });

    it('retries check-now through daemon machine RPC when stale active session RPC is method-not-found', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
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

    it('keeps the live session check-now error when daemon fallback has no machine target', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
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
        sessionRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: false,
            error: 'unsupported_session_runtime_method:session.usageLimit.checkNow',
            errorCode: 'unsupported_session_runtime_method',
        });

        const { sessionUsageLimitCheckNow } = await import('./sessionUsageLimitRecovery');
        await expect(sessionUsageLimitCheckNow('session-1')).resolves.toEqual({
            ok: false,
            status: 'unsupported',
            error: 'unsupported_session_runtime_method',
            errorCode: 'unsupported_session_runtime_method',
        });

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('retries enable through daemon machine RPC when stale active session RPC reports session-rpc-failed', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
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
            issueFingerprint: 'usage-limit:codex:turn-1:1:no-reset',
            rememberPreference: true,
        })).resolves.toEqual({
            ok: true,
            status: 'waiting',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
            payload: {
                sessionId: 'session-1',
                issueFingerprint: 'usage-limit:codex:turn-1:1:no-reset',
                rememberPreference: true,
            },
        });
    });

    it('retries cancel through daemon machine RPC when stale active session RPC reports method-not-available', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
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
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true });

        const { sessionUsageLimitWaitResumeCancel } = await import('./sessionUsageLimitRecovery');
        await expect(sessionUsageLimitWaitResumeCancel('session-1', { issueFingerprint: 'issue-a', armedAtMs: 1 })).resolves.toEqual({
            ok: false,
            status: 'malformed_response',
            error: 'malformed_session_usage_limit_recovery_operation_result',
            errorCode: 'malformed_session_usage_limit_recovery_operation_result',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-owned',
            method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
            payload: { sessionId: 'session-1', issueFingerprint: 'issue-a', armedAtMs: 1 },
        });
    });
});
