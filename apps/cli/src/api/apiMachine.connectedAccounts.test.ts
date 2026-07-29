import { describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/api/types';
import type {
    ConnectedAccountDaemonCommand,
    ConnectedAccountDaemonRuntime,
} from '@/daemon/connectedServices/ConnectedAccountDaemonRuntime';

import { ApiMachineClient } from './apiMachine';

const CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD =
    'daemon.connectedAccounts.authentication.command';
const CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD =
    'daemon.connectedAccounts.control.command';
const service = Object.freeze({ pluginId: 'acme.accounts', localId: 'work' });

function createMachine(): Machine {
    return {
        id: 'machine-test',
        encryptionKey: new Uint8Array(32).fill(7),
        encryptionVariant: 'legacy',
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

function connectedAccountRuntimeRegistrar(client: ApiMachineClient): Readonly<{
    registerConnectedAccountDaemonRuntime(runtime: ConnectedAccountDaemonRuntime): void;
}> {
    return client as unknown as Readonly<{
        registerConnectedAccountDaemonRuntime(runtime: ConnectedAccountDaemonRuntime): void;
    }>;
}

function rpcInvoker(client: ApiMachineClient): Readonly<{
    invokeLocal(
        method: string,
        params: unknown,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<unknown>;
}> {
    return (client as unknown as Readonly<{
        rpcHandlerManager: {
            invokeLocal(
                method: string,
                params: unknown,
                options?: Readonly<{ signal?: AbortSignal }>,
            ): Promise<unknown>;
        };
    }>).rpcHandlerManager;
}

describe('ApiMachineClient connected-account authentication command', () => {
    it('fails typed when the owning daemon runtime is unavailable', async () => {
        const client = new ApiMachineClient('token', createMachine());

        await expect(rpcInvoker(client).invokeLocal(
            CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
            {
                v: 1,
                machineId: 'machine-test',
                command: {
                    operation: 'beginConnect',
                    service,
                    modeId: 'manual',
                },
            },
        )).resolves.toEqual({
            status: 'unavailable',
            code: 'connected_account_daemon_runtime_unavailable',
        });
    });

    it.each<Readonly<{
        command: ConnectedAccountDaemonCommand;
        response: Awaited<ReturnType<ConnectedAccountDaemonRuntime['execute']>>;
    }>>([
        {
            command: {
                operation: 'beginConnect',
                service,
                modeId: 'manual',
                expectedConfigurationRevision: 'configuration-1',
            },
            response: { status: 'awaitingManual', attemptId: 'attempt-1' },
        },
        {
            command: {
                operation: 'beginReconnect',
                account: { service, accountId: 'account-a' },
                expectedConfigurationRevision: 'configuration-2',
            },
            response: { status: 'awaitingManual', attemptId: 'attempt-2' },
        },
        {
            command: {
                operation: 'continueConnect',
                attemptId: 'attempt-1',
                expectedConfigurationRevision: 'configuration-3',
            },
            response: { status: 'starting', attemptId: 'attempt-1' },
        },
        {
            command: {
                operation: 'submitManual',
                attemptId: 'attempt-1',
                fields: { token: 'candidate' },
            },
            response: { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'account-a' } },
        },
        {
            command: {
                operation: 'completeOAuth',
                attemptId: 'attempt-1',
                completion: {
                    code: 'callback-code',
                    callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                    state: 'state-1',
                },
            },
            response: { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'account-a' } },
        },
        {
            command: { operation: 'pollDevice', attemptId: 'attempt-1' },
            response: { status: 'pending', attemptId: 'attempt-1', retryAfterMs: 5_000 },
        },
        {
            command: { operation: 'resumeDevice', attemptId: 'attempt-1' },
            response: { status: 'awaitingDeviceAuthorization', attemptId: 'attempt-1' },
        },
        {
            command: { operation: 'reconcile', attemptId: 'attempt-1' },
            response: {
                status: 'outcomeUnknown',
                attemptId: 'attempt-1',
                diagnostic: { code: 'provider_response_lost' },
            },
        },
        {
            command: { operation: 'cancel', attemptId: 'attempt-1' },
            response: { status: 'cancelled', attemptId: 'attempt-1' },
        },
        {
            command: { operation: 'read', attemptId: 'attempt-1' },
            response: { status: 'awaitingManual', attemptId: 'attempt-1' },
        },
    ])('routes $command.operation to the one registered daemon runtime', async ({ command, response }) => {
        const execute = vi.fn(async () => response);
        const client = new ApiMachineClient('token', createMachine());
        connectedAccountRuntimeRegistrar(client).registerConnectedAccountDaemonRuntime({
            execute,
            control: vi.fn(),
        });
        const controller = new AbortController();

        await expect(rpcInvoker(client).invokeLocal(
            CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
            { v: 1, machineId: 'machine-test', command },
            { signal: controller.signal },
        )).resolves.toEqual(response);
        expect(execute).toHaveBeenCalledWith(command, { signal: controller.signal });
    });

    it('routes strict service description through the same daemon owner', async () => {
        const control = vi.fn(async () => ({
            status: 'described' as const,
            service,
            descriptor: {
                id: 'work',
                title: 'Acme Work',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual',
                        kind: 'manual' as const,
                        outcomeReconciliation: 'none' as const,
                        fields: [{
                            id: 'token',
                            title: 'Token',
                            schema: { type: 'string' as const },
                            secret: true,
                        }],
                    }],
                },
            },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            accounts: [],
        }));
        const client = new ApiMachineClient('token', createMachine());
        connectedAccountRuntimeRegistrar(client).registerConnectedAccountDaemonRuntime({
            execute: vi.fn(),
            control,
        });

        await expect(rpcInvoker(client).invokeLocal(
            CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
            {
                v: 1,
                machineId: 'machine-test',
                command: {
                    operation: 'describeService',
                    service,
                },
            },
        )).resolves.toMatchObject({
            status: 'described',
            service,
            generation: 'generation-1',
        });
        expect(control).toHaveBeenCalledWith({
            operation: 'describeService',
            service,
        }, { signal: expect.any(AbortSignal) });
    });

    it('routes strict account revocation and preserves its settled result', async () => {
        const account = {
            service,
            accountId: 'account-1',
        };
        const control = vi.fn(async () => ({
            status: 'revoked' as const,
            account,
            remoteStatus: 'remoteUnsupported' as const,
        }));
        const client = new ApiMachineClient('token', createMachine());
        connectedAccountRuntimeRegistrar(client).registerConnectedAccountDaemonRuntime({
            execute: vi.fn(),
            control,
        });

        await expect(rpcInvoker(client).invokeLocal(
            CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
            {
                v: 1,
                machineId: 'machine-test',
                command: {
                    operation: 'revokeAccount',
                    account,
                    cleanupGroupReferences: true,
                },
            },
        )).resolves.toEqual({
            status: 'revoked',
            account,
            remoteStatus: 'remoteUnsupported',
        });
        expect(control).toHaveBeenCalledWith({
            operation: 'revokeAccount',
            account,
            cleanupGroupReferences: true,
        }, { signal: expect.any(AbortSignal) });
    });

    it('rejects a command routed to a different machine without invoking provider work', async () => {
        const execute = vi.fn();
        const client = new ApiMachineClient('token', createMachine());
        connectedAccountRuntimeRegistrar(client).registerConnectedAccountDaemonRuntime({
            execute,
            control: vi.fn(),
        });

        await expect(rpcInvoker(client).invokeLocal(
            CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
            {
                v: 1,
                machineId: 'machine-other',
                command: {
                    operation: 'beginConnect',
                    service,
                    modeId: 'manual',
                },
            },
        )).resolves.toEqual({
            status: 'unavailable',
            code: 'connected_account_daemon_owner_unavailable',
        });
        expect(execute).not.toHaveBeenCalled();
    });
});
