import { describe, expect, it, vi } from 'vitest';
import type {
    ConnectedServiceDaemonAuthBridgeRefreshResult,
} from '@/daemon/connectedServices/daemonAuthBridgeTypes';

import type { ConnectedServiceProviderRuntimeAuthAdapter } from '@/daemon/connectedServices/runtimeAuth/types';
import { createSessionScopedAuthServices } from './auth';

function createRuntimeAuthAdapter(
    refreshActiveProfile: ConnectedServiceProviderRuntimeAuthAdapter['refreshActiveProfile'],
): ConnectedServiceProviderRuntimeAuthAdapter {
    return {
        classifyRuntimeAuthFailure: () => null,
        materializeActiveProfile: async () => ({}),
        canHotApply: () => ({}),
        hotApply: async () => ({}),
        recoverAfterRuntimeAuthSwitch: async () => ({}),
        probeQuota: async () => ({}),
        refreshActiveProfile,
    };
}

function daemonRefreshResult(value: unknown): ConnectedServiceDaemonAuthBridgeRefreshResult {
    // Deliberately bypass the typed control contract to exercise malformed daemon responses.
    return value as ConnectedServiceDaemonAuthBridgeRefreshResult;
}

describe('createSessionScopedAuthServices runtime auth refresh', () => {
    it('forwards refresh intent and failed-token proof to the provider adapter', async () => {
        const refreshActiveProfile = vi.fn(async () => ({
            status: 'refreshed' as const,
            result: { accessToken: 'fresh' },
        }));
        const auth = createSessionScopedAuthServices({
            readSessionId: async () => 'happy-session-1',
            resolveAdapter: async () => createRuntimeAuthAdapter(refreshActiveProfile),
        });

        await expect(auth.services.refreshRuntimeAuth({
            agentId: 'codex',
            serviceId: 'openai-codex',
            refreshAttemptId: 'codex-refresh-attempt-1',
            selection: { kind: 'profile', profileId: 'work' },
            failingAccessTokenFingerprint: 'sha256:failed',
            expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            reason: 'chatgpt_auth_tokens_refresh',
        })).resolves.toEqual({
            status: 'refreshed',
            result: { accessToken: 'fresh' },
        });

        expect(refreshActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
            failingAccessTokenFingerprint: 'sha256:failed',
            expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            reason: 'chatgpt_auth_tokens_refresh',
        }));
    });

    it.each([
        {
            name: 'unavailable',
            adapterResult: { status: 'unavailable', reason: 'provider_refresh_unavailable' },
            expected: { status: 'unavailable', reason: 'provider_refresh_unavailable' },
        },
        {
            name: 'failed',
            adapterResult: { status: 'failed', reason: 'provider_refresh_failed' },
            expected: { status: 'failed', reason: 'provider_refresh_failed' },
        },
        {
            name: 'available without refresh proof',
            adapterResult: { status: 'available', activeProfiles: ['work'] },
            expected: { status: 'unavailable', reason: 'runtime_auth_refresh_not_proven' },
        },
        {
            name: 'malformed raw credential payload',
            adapterResult: { accessToken: 'unproven-token' },
            expected: { status: 'failed', reason: 'runtime_auth_refresh_invalid_result' },
        },
        {
            name: 'mismatched pending attempt',
            adapterResult: { status: 'pending', refreshAttemptId: 'different-attempt' },
            expected: { status: 'failed', reason: 'runtime_auth_refresh_attempt_mismatch' },
        },
    ])('fails closed for an adapter $name result', async ({ adapterResult, expected }) => {
        const auth = createSessionScopedAuthServices({
            readSessionId: async () => 'happy-session-1',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => adapterResult),
        });

        await expect(auth.services.refreshRuntimeAuth({
            agentId: 'pi',
            serviceId: 'openai',
            refreshAttemptId: 'runtime-auth-attempt-1',
            selection: { kind: 'profile', profileId: 'work' },
        })).resolves.toEqual(expected);
    });

    it('preserves only an exact matching adapter pending attempt', async () => {
        const auth = createSessionScopedAuthServices({
            readSessionId: async () => 'happy-session-1',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => ({
                status: 'pending',
                refreshAttemptId: 'runtime-auth-attempt-1',
            })),
        });

        await expect(auth.services.refreshRuntimeAuth({
            agentId: 'pi',
            serviceId: 'openai',
            refreshAttemptId: 'runtime-auth-attempt-1',
            selection: { kind: 'profile', profileId: 'work' },
        })).resolves.toEqual({
            status: 'pending',
            refreshAttemptId: 'runtime-auth-attempt-1',
        });
    });

    it('does not misreport an adapter unsupported result as a successful refresh', async () => {
        const refreshViaDaemon = vi.fn(async () => ({
            status: 'refreshed' as const,
            result: {
                accessToken: 'fresh',
                chatgptAccountId: 'acct-1',
                chatgptPlanType: 'plus',
            },
        }));
        const auth = createSessionScopedAuthServices({
            readSessionId: async () => 'happy-session-1',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => ({
                    status: 'unsupported',
                    reason: 'provider_refresh_unavailable',
                })),
            refreshViaDaemon,
        });

        await expect(auth.services.refreshRuntimeAuth({
            agentId: 'codex',
            serviceId: 'openai-codex',
            refreshAttemptId: 'codex-refresh-attempt-1',
            selection: { kind: 'profile', profileId: 'work' },
            planType: 'plus',
            failingAccessTokenFingerprint: 'sha256:failed',
            expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            reason: 'chatgpt_auth_tokens_refresh',
        })).resolves.toEqual({
            status: 'refreshed',
            result: {
                accessToken: 'fresh',
                chatgptAccountId: 'acct-1',
                chatgptPlanType: 'plus',
            },
        });
        expect(refreshViaDaemon).toHaveBeenCalledWith({
            sessionId: 'happy-session-1',
            serviceId: 'openai-codex',
            refreshAttemptId: 'codex-refresh-attempt-1',
            selection: {
                kind: 'profile',
                profileId: 'work',
                serviceId: 'openai-codex',
                planType: 'plus',
            },
            planType: 'plus',
            failingAccessTokenFingerprint: 'sha256:failed',
            expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            reason: 'chatgpt_auth_tokens_refresh',
        }, { timeoutMs: 120_000 });
    });

    it.each([
        {
            name: 'unavailable',
            daemonResult: { status: 'unavailable', reason: 'connected_service_session_refresh_forbidden' },
            expected: { status: 'unavailable', reason: 'connected_service_session_refresh_forbidden' },
        },
        {
            name: 'failed',
            daemonResult: { status: 'failed', reason: 'connected_service_refresh_failed' },
            expected: { status: 'failed', reason: 'connected_service_refresh_failed' },
        },
        {
            name: 'malformed raw credential payload',
            daemonResult: { accessToken: 'unproven-token' },
            expected: { status: 'failed', reason: 'runtime_auth_refresh_invalid_result' },
        },
        {
            name: 'mismatched pending attempt',
            daemonResult: { status: 'pending', refreshAttemptId: 'different-attempt' },
            expected: { status: 'failed', reason: 'runtime_auth_refresh_attempt_mismatch' },
        },
    ])('fails closed for a daemon $name result', async ({ daemonResult, expected }) => {
        const auth = createSessionScopedAuthServices({
            readSessionId: async () => 'happy-session-1',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => ({ status: 'unsupported' })),
            refreshViaDaemon: async () => daemonRefreshResult(daemonResult),
        });

        await expect(auth.services.refreshRuntimeAuth({
            agentId: 'codex',
            serviceId: 'openai-codex',
            refreshAttemptId: 'runtime-auth-attempt-1',
            selection: { kind: 'profile', profileId: 'work' },
            expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        })).resolves.toEqual(expected);
    });

    it('maps a daemon authorization rejection to unavailable instead of refresh success or provider failure', async () => {
        const auth = createSessionScopedAuthServices({
            readSessionId: async () => 'happy-session-1',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => ({ status: 'unsupported' })),
            refreshViaDaemon: async () => {
                throw new Error('connected_service_session_refresh_forbidden');
            },
        });

        await expect(auth.services.refreshRuntimeAuth({
            agentId: 'codex',
            serviceId: 'openai-codex',
            refreshAttemptId: 'runtime-auth-attempt-1',
            selection: { kind: 'profile', profileId: 'work' },
            expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        })).resolves.toEqual({
            status: 'unavailable',
            reason: 'connected_service_session_refresh_forbidden',
        });
    });

    it('has zero daemon effect when the caller aborts before daemon admission', async () => {
        const refreshViaDaemon = vi.fn();
        const controller = new AbortController();
        controller.abort(new Error('caller deadline'));
        const auth = createSessionScopedAuthServices({
            readSessionId: async () => 'happy-session-1',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => ({
                status: 'unsupported',
                reason: 'provider_refresh_unavailable',
            })),
            refreshViaDaemon,
        });

        await expect(auth.services.refreshRuntimeAuth({
            agentId: 'codex',
            serviceId: 'openai-codex',
            refreshAttemptId: 'codex-refresh-attempt-aborted',
            selection: { kind: 'profile', profileId: 'work' },
            expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        }, { signal: controller.signal })).rejects.toThrow('caller deadline');
        expect(refreshViaDaemon).not.toHaveBeenCalled();
    });

    it('observes canonical daemon settlement after admission even when the caller aborts locally', async () => {
        const daemonSettlement = {
            resolve: (_value: ConnectedServiceDaemonAuthBridgeRefreshResult): void => {
                throw new Error('daemon settlement resolver not initialized');
            },
        };
        const refreshViaDaemon = vi.fn(() => new Promise<ConnectedServiceDaemonAuthBridgeRefreshResult>((resolve) => {
            daemonSettlement.resolve = resolve;
        }));
        const controller = new AbortController();
        const auth = createSessionScopedAuthServices({
            readSessionId: async () => 'happy-session-1',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => ({ status: 'unsupported' })),
            refreshViaDaemon,
        });

        const settlement = auth.services.refreshRuntimeAuth({
            agentId: 'codex',
            serviceId: 'openai-codex',
            refreshAttemptId: 'runtime-auth-attempt-admitted',
            selection: { kind: 'profile', profileId: 'work' },
            expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        }, { signal: controller.signal });
        await vi.waitFor(() => expect(refreshViaDaemon).toHaveBeenCalledOnce());
        controller.abort(new Error('caller detached after admission'));
        daemonSettlement.resolve({
            status: 'refreshed',
            result: { accessToken: 'authoritative-token' },
        });

        await expect(settlement).resolves.toEqual({
            status: 'refreshed',
            result: { accessToken: 'authoritative-token' },
        });
    });

    it('reports connected-service runtime-auth classifications when selection is missing but recovery context is present', async () => {
        const recovery = {
            handled: true,
            report: null,
            statusCode: null,
            statusMessage: null,
            ok: true,
        };
        const reportFailure = vi.fn(async () => recovery);
        const resolveAdapter = vi.fn();
        const auth = createSessionScopedAuthServices({
            readSessionId: async () => 'happy-session-1',
            resolveAdapter,
            reportFailure,
        });
        const classification = {
            kind: 'auth_expired',
            limitCategory: 'auth_invalid',
            serviceId: 'openai-codex',
            profileId: 'codex-profile',
            groupId: null,
            resetsAtMs: null,
            retryAfterMs: null,
            planType: null,
            connectedServiceRecovery: 'available',
            rateLimits: null,
            source: 'structured_provider_error',
        };

        await expect(auth.services.refreshRuntimeAuth({
            agentId: 'opencode',
            serviceId: 'openai-codex',
            classification,
        })).resolves.toEqual({
            status: 'unavailable',
            reason: 'runtime_auth_selection_unavailable',
            recovery,
        });

        expect(resolveAdapter).not.toHaveBeenCalled();
        expect(reportFailure).toHaveBeenCalledWith({
            sessionId: 'happy-session-1',
            classification,
        });
    });

    it('does not report native runtime-auth classifications to connected-service recovery when selection is missing', async () => {
        const reportFailure = vi.fn(async () => ({
            handled: true,
            report: null,
            statusCode: null,
            statusMessage: null,
            ok: true,
        }));
        const resolveAdapter = vi.fn();
        const auth = createSessionScopedAuthServices({
            readSessionId: async () => 'happy-session-1',
            resolveAdapter,
            reportFailure,
        });

        await expect(auth.services.refreshRuntimeAuth({
            agentId: 'claude',
            serviceId: 'claude-subscription',
            classification: {
                kind: 'auth_expired',
                serviceId: 'claude-subscription',
                profileId: null,
                groupId: null,
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'unavailable',
            reason: 'runtime_auth_selection_unavailable',
        });

        expect(resolveAdapter).not.toHaveBeenCalled();
        expect(reportFailure).not.toHaveBeenCalled();
    });
});
