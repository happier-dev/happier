import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const prepareAccountSettingsForDaemonSpawnIfNeededMock = vi.hoisted(() => vi.fn(async (_hint?: unknown) => ({})));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeMock(params),
}));

vi.mock('@/sync/ops/accountSettingsDaemonSpawnPreparation', () => ({
    prepareAccountSettingsForDaemonSpawnIfNeeded: (hint: unknown) =>
        prepareAccountSettingsForDaemonSpawnIfNeededMock(hint),
}));

describe('setSessionConnectedServiceAuthBinding', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        prepareAccountSettingsForDaemonSpawnIfNeededMock.mockReset();
        prepareAccountSettingsForDaemonSpawnIfNeededMock.mockResolvedValue({});
    });

    it('routes existing-session auth switches through the L4 daemon switch contract', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            action: 'restart_requested',
            normalizedBindings: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            },
            continuityByServiceId: { anthropic: 'restart_rematerialize' },
            warnings: [],
        });

        const { setSessionConnectedServiceAuthBinding, SESSION_CONNECTED_SERVICE_AUTH_SWITCH_MACHINE_RPC_METHOD } = await import('./sessionAuthSwitch');

        await expect(setSessionConnectedServiceAuthBinding({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            },
            expectedGroupGenerationByServiceId: { anthropic: 4 },
        })).resolves.toEqual({
            ok: true,
            action: 'restart_requested',
            normalizedBindings: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            },
            continuityByServiceId: { anthropic: 'restart_rematerialize' },
            warnings: [],
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: SESSION_CONNECTED_SERVICE_AUTH_SWITCH_MACHINE_RPC_METHOD,
            timeoutMs: 210_000,
            onIssued: expect.any(Function),
            payload: {
                sessionId: 'session-1',
                agentId: 'claude',
                bindings: {
                    v: 1,
                    bindingsByServiceId: {
                        anthropic: {
                            source: 'connected',
                            selection: 'profile',
                            profileId: 'work',
                        },
                    },
                },
                expectedGroupGenerationByServiceId: { anthropic: 4 },
            },
        });
    });

    it('prepares account settings and forwards the freshness hint for auth-switch continuity', async () => {
        prepareAccountSettingsForDaemonSpawnIfNeededMock.mockResolvedValueOnce({
            accountSettingsVersionHint: 42,
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            action: 'restart_requested',
            normalizedBindings: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'happier',
                    },
                },
            },
            continuityByServiceId: { 'openai-codex': 'restart_rematerialize' },
            warnings: [],
        });

        const { setSessionConnectedServiceAuthBinding } = await import('./sessionAuthSwitch');

        await setSessionConnectedServiceAuthBinding({
            sessionId: 'session-1',
            agentId: 'codex',
            machineId: 'machine-1',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'happier',
                    },
                },
            },
        });

        expect(prepareAccountSettingsForDaemonSpawnIfNeededMock).toHaveBeenCalledWith(undefined);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                accountSettingsVersionHint: 42,
            }),
        }));
    });

    it('passes rematerialize requests through the shared daemon auth-switch RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            action: 'restart_requested',
            normalizedBindings: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            },
            continuityByServiceId: { anthropic: 'restart_rematerialize' },
            warnings: [],
        });

        const { setSessionConnectedServiceAuthBinding } = await import('./sessionAuthSwitch');

        await expect(setSessionConnectedServiceAuthBinding({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            },
            rematerializeServiceId: 'anthropic',
        })).resolves.toEqual(expect.objectContaining({
            ok: true,
            action: 'restart_requested',
        }));

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                rematerializeServiceId: 'anthropic',
            }),
        }));
    });

    it('preserves daemon failure details for unsupported service responses', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'unsupported_service',
            serviceId: 'openai-codex',
        });

        const { setSessionConnectedServiceAuthBinding } = await import('./sessionAuthSwitch');

        await expect(setSessionConnectedServiceAuthBinding({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'codex-profile',
                    },
                },
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'unsupported_service',
            serviceId: 'openai-codex',
        });
    });
});
