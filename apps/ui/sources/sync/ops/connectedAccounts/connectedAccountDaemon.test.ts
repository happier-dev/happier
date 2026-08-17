import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const activeServerState = vi.hoisted(() => ({
    serverId: 'server-a' as string | null,
    generation: 1,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ ...activeServerState }),
}));

describe('connected-account daemon machine RPC', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        activeServerState.serverId = 'server-a';
        activeServerState.generation = 1;
    });

    it('rejects response shapes outside the daemon wire contract', async () => {
        const { ConnectedAccountAttemptResponseSchema } = await import('./connectedAccountDaemon');

        expect(ConnectedAccountAttemptResponseSchema.safeParse({
            status: 'awaitingOAuth',
            attemptId: 'attempt-1',
            authorizationUrl: 'not-a-url',
            callbackUrl: 'http://127.0.0.1/callback',
        }).success).toBe(false);
        expect(ConnectedAccountAttemptResponseSchema.safeParse({
            status: 'awaitingDeviceAuthorization',
            attemptId: 'attempt-1',
            verificationUri: `https://example.com/${'x'.repeat(8_192)}`,
            pollIntervalMs: 0,
        }).success).toBe(false);
        expect(ConnectedAccountAttemptResponseSchema.safeParse({
            status: 'pending',
            attemptId: 'attempt-1',
            retryAfterMs: 1.5,
        }).success).toBe(false);
    });

    it('routes authentication through the exact server and machine owner', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            status: 'awaitingManual',
            attemptId: 'attempt-1',
        });
        const { runConnectedAccountAuthenticationCommand } = await import('./connectedAccountDaemon');

        await expect(runConnectedAccountAuthenticationCommand({
            serverId: 'server-a',
            machineId: 'machine-1',
            command: {
                operation: 'beginConnect',
                service: { pluginId: 'acme.accounts', localId: 'work' },
                modeId: 'manual',
            },
        })).resolves.toEqual({
            status: 'awaitingManual',
            attemptId: 'attempt-1',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            serverId: 'server-a',
            machineId: 'machine-1',
            method: 'daemon.connectedAccounts.authentication.command',
            payload: {
                v: 1,
                machineId: 'machine-1',
                command: {
                    operation: 'beginConnect',
                    service: { pluginId: 'acme.accounts', localId: 'work' },
                    modeId: 'manual',
                },
            },
        });
    });

    it('rejects an expected active-server basis that does not match the routed server', async () => {
        const { runConnectedAccountAuthenticationCommand } =
            await import('./connectedAccountDaemon');

        await expect(runConnectedAccountAuthenticationCommand({
            serverId: 'server-b',
            machineId: 'machine-1',
            expectedActiveServer: {
                serverId: 'server-a',
                generation: 1,
            },
            command: {
                operation: 'beginConnect',
                service: { pluginId: 'acme.accounts', localId: 'work' },
                modeId: 'manual',
            },
        })).rejects.toMatchObject({
            code: 'STALE_SERVER_GENERATION',
        });

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('rechecks the active-server generation at the exact machine-RPC issuance point', async () => {
        machineRpcWithServerScopeMock.mockImplementationOnce(async (input) => {
            activeServerState.serverId = 'server-b';
            activeServerState.generation = 2;
            input.onIssued?.();
            return {
                status: 'awaitingManual',
                attemptId: 'attempt-1',
            };
        });
        const { runConnectedAccountAuthenticationCommand } =
            await import('./connectedAccountDaemon');

        await expect(runConnectedAccountAuthenticationCommand({
            serverId: 'server-a',
            machineId: 'machine-1',
            expectedActiveServer: {
                serverId: 'server-a',
                generation: 1,
            },
            command: {
                operation: 'beginConnect',
                service: { pluginId: 'acme.accounts', localId: 'work' },
                modeId: 'manual',
            },
        })).rejects.toMatchObject({
            code: 'STALE_SERVER_GENERATION',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(
            expect.objectContaining({
                serverId: 'server-a',
                machineId: 'machine-1',
                onIssued: expect.any(Function),
            }),
        );
    });

    it('sends only the daemon-owned OAuth callback fields and rejects malformed responses', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            status: 'connected',
            attemptId: 'attempt-1',
            account: {
                service: { pluginId: 'acme.accounts', localId: 'work' },
                accountId: 'account-1',
            },
        });
        const { runConnectedAccountAuthenticationCommand } = await import('./connectedAccountDaemon');

        await runConnectedAccountAuthenticationCommand({
            serverId: 'server-a',
            machineId: 'machine-1',
            command: {
                operation: 'completeOAuth',
                attemptId: 'attempt-1',
                completion: {
                    code: 'code-1',
                    callbackUrl: 'http://127.0.0.1/callback',
                    state: 'state-1',
                },
            },
        });

        expect(machineRpcWithServerScopeMock.mock.calls[0]?.[0]).toMatchObject({
            payload: {
                command: {
                    operation: 'completeOAuth',
                    completion: {
                        code: 'code-1',
                        callbackUrl: 'http://127.0.0.1/callback',
                        state: 'state-1',
                    },
                },
            },
        });
        expect(
            machineRpcWithServerScopeMock.mock.calls[0]?.[0].payload.command.completion,
        ).not.toHaveProperty('pkceVerifier');

        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            status: 'awaitingManual',
            attemptId: 'attempt-2',
            secret: 'must-not-pass',
        });
        await expect(runConnectedAccountAuthenticationCommand({
            serverId: 'server-a',
            machineId: 'machine-1',
            command: { operation: 'read', attemptId: 'attempt-2' },
        })).rejects.toThrow();
    });

    it('preserves daemon unavailability as a typed response', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            status: 'unavailable',
            code: 'connected_account_daemon_runtime_unavailable',
        });
        const { runConnectedAccountAuthenticationCommand } = await import('./connectedAccountDaemon');

        await expect(runConnectedAccountAuthenticationCommand({
            serverId: 'server-a',
            machineId: 'machine-1',
            command: {
                operation: 'beginConnect',
                service: { pluginId: 'acme.accounts', localId: 'work' },
                modeId: 'manual',
            },
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'connected_account_daemon_runtime_unavailable',
        });
    });

    it('routes strict descriptor/config control through the same exact owner', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            status: 'described',
            service: { pluginId: 'acme.accounts', localId: 'work' },
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{
                            id: 'token',
                            title: 'Token',
                            schema: { type: 'string', minLength: 1 },
                            secret: true,
                        }],
                    }],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [],
        });
        const { runConnectedAccountControlCommand } = await import('./connectedAccountDaemon');

        await expect(runConnectedAccountControlCommand({
            serverId: 'server-a',
            machineId: 'machine-1',
            command: {
                operation: 'describeService',
                service: { pluginId: 'acme.accounts', localId: 'work' },
            },
        })).resolves.toMatchObject({
            status: 'described',
            service: { pluginId: 'acme.accounts', localId: 'work' },
            descriptor: { id: 'work' },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenLastCalledWith({
            serverId: 'server-a',
            machineId: 'machine-1',
            method: 'daemon.connectedAccounts.control.command',
            payload: {
                v: 1,
                machineId: 'machine-1',
                command: {
                    operation: 'describeService',
                    service: { pluginId: 'acme.accounts', localId: 'work' },
                },
            },
        });

        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            status: 'unavailable',
            code: 'connected_account_configuration_target_unavailable',
            secretRefs: { token: 'must-not-pass' },
        });
        await expect(runConnectedAccountControlCommand({
            serverId: 'server-a',
            machineId: 'machine-1',
            command: {
                operation: 'readConfiguration',
                target: {
                    kind: 'account',
                    account: {
                        service: { pluginId: 'acme.accounts', localId: 'work' },
                        accountId: 'account-1',
                    },
                },
            },
        })).rejects.toThrow();
    });

    it('routes exact-account revoke through the daemon and accepts only strict settlement responses', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            status: 'revoked',
            account: {
                service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
                accountId: 'work',
            },
            remoteStatus: 'remoteUnsupported',
        });
        const { runConnectedAccountControlCommand } = await import('./connectedAccountDaemon');

        await expect(runConnectedAccountControlCommand({
            serverId: 'server-a',
            machineId: 'machine-1',
            command: {
                operation: 'revokeAccount',
                account: {
                    service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
                    accountId: 'work',
                },
                cleanupGroupReferences: false,
            },
        })).resolves.toEqual({
            status: 'revoked',
            account: {
                service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
                accountId: 'work',
            },
            remoteStatus: 'remoteUnsupported',
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenLastCalledWith({
            serverId: 'server-a',
            machineId: 'machine-1',
            method: 'daemon.connectedAccounts.control.command',
            payload: {
                v: 1,
                machineId: 'machine-1',
                command: {
                    operation: 'revokeAccount',
                    account: {
                        service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
                        accountId: 'work',
                    },
                    cleanupGroupReferences: false,
                },
            },
        });

        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            status: 'outcomeUnknown',
            account: {
                service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
                accountId: 'work',
            },
            diagnostic: 'must-not-pass',
        });
        await expect(runConnectedAccountControlCommand({
            serverId: 'server-a',
            machineId: 'machine-1',
            command: {
                operation: 'revokeAccount',
                account: {
                    service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
                    accountId: 'work',
                },
                cleanupGroupReferences: true,
            },
        })).rejects.toThrow();
    });
});
