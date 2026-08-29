import { describe, expect, it, vi } from 'vitest';
import type {
    ConnectedServiceDaemonAuthBridgeRefreshResult,
} from '@/daemon/connectedServices/daemonAuthBridgeTypes';

import type {
    ConnectedServiceProviderRuntimeAuthAdapter,
    ConnectedServiceRuntimeAuthAdapterResult,
} from '@/daemon/connectedServices/runtimeAuth/types';
import { createSessionHandleAuthService } from './auth';

function createRuntimeAuthAdapter(
    refreshActiveProfile: ConnectedServiceProviderRuntimeAuthAdapter['refreshActiveProfile'],
): ConnectedServiceProviderRuntimeAuthAdapter {
    return {
        classifyRuntimeAuthFailure: () => null,
        materializeActiveProfile: async () => ({}),
        canHotApply: () => ({}),
        hotApply: async () => ({}),
        probeQuota: async () => ({}),
        refreshActiveProfile,
    };
}

function daemonRefreshResult(value: unknown): ConnectedServiceDaemonAuthBridgeRefreshResult {
    // Deliberately bypass the typed control contract to exercise malformed daemon responses.
    return value as ConnectedServiceDaemonAuthBridgeRefreshResult;
}

function runtimeAuthAdapterResult(value: unknown): ConnectedServiceRuntimeAuthAdapterResult {
    // Deliberately bypass the author contract only in malformed-result tests.
    return value as ConnectedServiceRuntimeAuthAdapterResult;
}

describe('createSessionHandleAuthService runtime auth refresh', () => {
    it('host-stamps the bound Session Agent identity on author refresh requests', async () => {
        const refreshActiveProfile = vi.fn(async () => ({
            status: 'refreshed' as const,
            result: { accessToken: 'fresh' },
        }));
        const resolveAdapter = vi.fn(async () => createRuntimeAuthAdapter(refreshActiveProfile));
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'codex',
            resolveAdapter,
        });

        await expect(auth.services.refreshRuntimeAuth({
            serviceId: 'openai-codex',
            selection: { kind: 'profile', profileId: 'work' },
        })).resolves.toMatchObject({ status: 'refreshed' });

        expect(resolveAdapter).toHaveBeenCalledWith('codex');
    });
    it('forwards refresh intent and failed-token proof to the provider adapter', async () => {
        const refreshActiveProfile = vi.fn<
            ConnectedServiceProviderRuntimeAuthAdapter['refreshActiveProfile']
        >(async () => ({
            status: 'refreshed' as const,
            result: { accessToken: 'fresh' },
        }));
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'codex',
            resolveAdapter: async () => createRuntimeAuthAdapter(refreshActiveProfile),
        });

        await expect(auth.services.refreshRuntimeAuth({
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
            target: { agentId: 'codex' },
            selection: expect.objectContaining({ serviceId: 'happier.agent.codex/openai-codex' }),
        }));
        const refreshInput = refreshActiveProfile.mock.calls[0]?.[0];
        expect(refreshInput).not.toHaveProperty('failingAccessTokenFingerprint');
        expect(refreshInput).not.toHaveProperty('reason');
    });

    it('keeps the host-owned target environment out of the Agent adapter', async () => {
        const refreshActiveProfile = vi.fn<
            ConnectedServiceProviderRuntimeAuthAdapter['refreshActiveProfile']
        >(async () => ({ status: 'unsupported' as const }));
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'claude',
            resolveAdapter: async () => createRuntimeAuthAdapter(refreshActiveProfile),
        });

        await auth.services.refreshRuntimeAuth({
            serviceId: 'claude-subscription',
            selection: { kind: 'profile', profileId: 'work' },
        });

        const input = refreshActiveProfile.mock.calls[0]?.[0];
        expect(input).not.toHaveProperty('targetMaterializedEnv');
        expect(input).not.toHaveProperty('env');
        expect(input).not.toHaveProperty('materializedEnv');
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
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'pi',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => runtimeAuthAdapterResult(adapterResult)),
        });

        await expect(auth.services.refreshRuntimeAuth({
            serviceId: 'openai',
            refreshAttemptId: 'runtime-auth-attempt-1',
            selection: { kind: 'profile', profileId: 'work' },
        })).resolves.toEqual(expected);
    });

    it('rejects non-portable provider refresh payloads at the session service boundary', async () => {
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'pi',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => runtimeAuthAdapterResult({
                status: 'refreshed',
                result: () => 'credential-bearing closure',
            })),
        });

        await expect(auth.services.refreshRuntimeAuth({
            serviceId: 'openai',
            refreshAttemptId: 'runtime-auth-attempt-1',
            selection: { kind: 'profile', profileId: 'work' },
        })).resolves.toEqual({
            status: 'failed',
            reason: 'runtime_auth_refresh_invalid_result',
        });
    });

    it('normalizes provider failures into the strict public error contract', async () => {
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'pi',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => runtimeAuthAdapterResult({
                status: 'failed',
                reason: 'provider_refresh_failed',
                error: Object.assign(new Error('credential expired'), {
                    code: 'credential_expired',
                }),
            })),
        });

        await expect(auth.services.refreshRuntimeAuth({
            serviceId: 'openai',
            refreshAttemptId: 'runtime-auth-attempt-1',
            selection: { kind: 'profile', profileId: 'work' },
        })).resolves.toEqual({
            status: 'failed',
            reason: 'provider_refresh_failed',
            error: {
                name: 'Error',
                message: 'credential expired',
                code: 'credential_expired',
            },
        });
    });

    it('preserves only an exact matching adapter pending attempt', async () => {
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'pi',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => ({
                status: 'pending',
                refreshAttemptId: 'runtime-auth-attempt-1',
            })),
        });

        await expect(auth.services.refreshRuntimeAuth({
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
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'codex',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => ({
                    status: 'unsupported',
                    reason: 'provider_refresh_unavailable',
                })),
            refreshViaDaemon,
        });

        await expect(auth.services.refreshRuntimeAuth({
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
                serviceId: 'happier.agent.codex/openai-codex',
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
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'codex',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => ({ status: 'unsupported' })),
            refreshViaDaemon: async () => daemonRefreshResult(daemonResult),
        });

        await expect(auth.services.refreshRuntimeAuth({
            serviceId: 'openai-codex',
            refreshAttemptId: 'runtime-auth-attempt-1',
            selection: { kind: 'profile', profileId: 'work' },
            expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        })).resolves.toEqual(expected);
    });

    it('maps a daemon authorization rejection to unavailable instead of refresh success or provider failure', async () => {
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'codex',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => ({ status: 'unsupported' })),
            refreshViaDaemon: async () => {
                throw new Error('connected_service_session_refresh_forbidden');
            },
        });

        await expect(auth.services.refreshRuntimeAuth({
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
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'codex',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => ({
                status: 'unsupported',
                reason: 'provider_refresh_unavailable',
            })),
            refreshViaDaemon,
        });

        await expect(auth.services.refreshRuntimeAuth({
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
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'codex',
            resolveAdapter: async () => createRuntimeAuthAdapter(async () => ({ status: 'unsupported' })),
            refreshViaDaemon,
        });

        const settlement = auth.services.refreshRuntimeAuth({
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
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'opencode',
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

    it('omits a non-portable recovery report from the strict session result', async () => {
        const reportFailure = vi.fn(async () => ({
            handled: true,
            report: null,
            statusCode: null,
            statusMessage: null,
            retry: () => undefined,
        }));
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'opencode',
            resolveAdapter: vi.fn(),
            reportFailure,
        });

        await expect(auth.services.refreshRuntimeAuth({
            serviceId: 'openai-codex',
            classification: {
                kind: 'auth_expired',
                serviceId: 'openai-codex',
                connectedServiceRecovery: 'available',
            },
        })).resolves.toEqual({
            status: 'unavailable',
            reason: 'runtime_auth_selection_unavailable',
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
        const auth = createSessionHandleAuthService({
            readSessionId: async () => 'happy-session-1',
            readAgentId: async () => 'claude',
            resolveAdapter,
            reportFailure,
        });

        await expect(auth.services.refreshRuntimeAuth({
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
