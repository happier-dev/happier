import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeaturesResponse } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRootLayoutFeaturesResponse } from '@/dev/testkit';

import { callGuardedMachineRpcWithPolicy, isGuardedMachineRpcMethod } from './guardedMachineRpc';

type GetReadyServerFeaturesInput = Readonly<{ timeoutMs?: number; force?: boolean; serverId?: string }>;
const getReadyServerFeaturesMock = vi.fn<(input: GetReadyServerFeaturesInput) => Promise<FeaturesResponse | null>>();
vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (input: GetReadyServerFeaturesInput) => getReadyServerFeaturesMock(input),
}));

type MachineRpcWithServerScopeInput = Readonly<{
    machineId: string;
    serverId?: string;
    method: string;
    payload: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
    preferScoped?: boolean;
    skipTransferPolicyEvaluation?: boolean;
}>;
const machineRpcWithServerScopeMock = vi.fn<(input: MachineRpcWithServerScopeInput) => Promise<{ ok: true }>>(
    async () => ({ ok: true }),
);
vi.mock('./serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (input: MachineRpcWithServerScopeInput) => machineRpcWithServerScopeMock(input),
}));

describe('guardedMachineRpc', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('recognizes guarded methods', () => {
        expect(isGuardedMachineRpcMethod(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT)).toBe(true);
        expect(isGuardedMachineRpcMethod(RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT)).toBe(true);
        expect(isGuardedMachineRpcMethod(RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE)).toBe(true);
        expect(isGuardedMachineRpcMethod(RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT)).toBe(true);
        expect(isGuardedMachineRpcMethod(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE)).toBe(true);
        expect(isGuardedMachineRpcMethod(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT)).toBe(true);
        expect(isGuardedMachineRpcMethod(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT)).toBe(true);
        expect(isGuardedMachineRpcMethod(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ)).toBe(true);
        expect(isGuardedMachineRpcMethod(RPC_METHODS.LIST_DIRECTORY)).toBe(false);
        expect(isGuardedMachineRpcMethod('ripgrep')).toBe(false);
        expect(isGuardedMachineRpcMethod('daemon.bulkTransfer.start')).toBe(false);
        expect(isGuardedMachineRpcMethod('daemon.ping')).toBe(false);
    });

    it('fails closed: forces scoped route when server features are unavailable', async () => {
        getReadyServerFeaturesMock.mockResolvedValueOnce(null);

        await callGuardedMachineRpcWithPolicy({
            machineId: 'm1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
            payload: { kind: 'prompt-assets', id: 'asset-a' },
        });

        expect(getReadyServerFeaturesMock).toHaveBeenCalledWith({
            timeoutMs: 500,
            serverId: 'server-a',
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
            preferScoped: true,
        }));
    });

    it('allows direct route (does not force scoped) when transfer is enabled', async () => {
        getReadyServerFeaturesMock.mockResolvedValueOnce(createRootLayoutFeaturesResponse({
            features: {
                machines: {
                    transfer: {
                        enabled: true,
                        directPeer: { enabled: true },
                        serverRouted: { enabled: true },
                    },
                },
            },
        }));

        await callGuardedMachineRpcWithPolicy({
            machineId: 'm1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
            payload: { kind: 'prompt-assets', id: 'asset-a' },
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
        }));
        const call = machineRpcWithServerScopeMock.mock.calls.at(-1)?.[0];
        expect(call?.preferScoped).not.toBe(true);
    });

    it('fails closed: forces scoped route when transfer is disabled', async () => {
        getReadyServerFeaturesMock.mockResolvedValueOnce(createRootLayoutFeaturesResponse({
            features: {
                machines: {
                    transfer: {
                        enabled: false,
                        directPeer: { enabled: true },
                        serverRouted: { enabled: true },
                    },
                },
            },
        }));

        await callGuardedMachineRpcWithPolicy({
            machineId: 'm1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
            payload: { kind: 'prompt-assets', id: 'asset-a' },
        });

        const call = machineRpcWithServerScopeMock.mock.calls.at(-1)?.[0];
        expect(call?.preferScoped).toBe(true);
    });

    it('fails closed: forces scoped route when transfer policy evaluation throws', async () => {
        getReadyServerFeaturesMock.mockRejectedValueOnce(new Error('boom'));

        await callGuardedMachineRpcWithPolicy({
            machineId: 'm1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
            payload: { kind: 'prompt-assets', id: 'asset-a' },
        });

        const call = machineRpcWithServerScopeMock.mock.calls.at(-1)?.[0];
        expect(call?.preferScoped).toBe(true);
    });

    it('does not consult transfer policy for non-guarded methods', async () => {
        getReadyServerFeaturesMock.mockResolvedValueOnce(null);

        await callGuardedMachineRpcWithPolicy({
            machineId: 'm1',
            serverId: 'server-a',
            method: 'daemon.ping',
            payload: undefined,
        });

        expect(getReadyServerFeaturesMock).not.toHaveBeenCalled();
        const call = machineRpcWithServerScopeMock.mock.calls.at(-1)?.[0];
        expect(call?.method).toBe('daemon.ping');
        expect(call?.preferScoped).not.toBe(true);
    });

    it('forwards caller cancellation without changing guarded route policy', async () => {
        getReadyServerFeaturesMock.mockResolvedValueOnce(createRootLayoutFeaturesResponse({
            features: {
                machines: {
                    transfer: {
                        enabled: true,
                        directPeer: { enabled: true },
                        serverRouted: { enabled: true },
                    },
                },
            },
        }));
        const controller = new AbortController();

        await callGuardedMachineRpcWithPolicy({
            machineId: 'm1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
            payload: { t: 'session_file_upload_v1' },
            timeoutMs: 37,
            signal: controller.signal,
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
            timeoutMs: 37,
            signal: controller.signal,
        }));
        const call = machineRpcWithServerScopeMock.mock.calls.at(-1)?.[0];
        expect(call?.preferScoped).toBe(true);
    });
});
