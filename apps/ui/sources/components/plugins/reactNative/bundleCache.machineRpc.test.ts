import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

const callGuardedMachineRpcWithPolicyMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: callGuardedMachineRpcWithPolicyMock,
}));

import { fetchReactNativeInstalledArtifactBytesViaMachineRpc } from './bundleCache';

const identity = {
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    artifactDigest: `sha256:${'b'.repeat(64)}`,
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.83.4',
    expoRuntimeVersion: '0.2.0-native',
    hermesVersion: '0.15.0',
    platform: 'ios',
    channel: 'internal',
    nativeCapabilitiesDigest: `sha256:${'c'.repeat(64)}`,
    projectionGeneration: 12,
} as const;

describe('React Native installed-artifact machine RPC', () => {
    beforeEach(() => {
        callGuardedMachineRpcWithPolicyMock.mockReset();
    });

    it('reads bytes from the projection-owning machine through the guarded route', async () => {
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: ['artifact_not_installed'],
        });

        await expect(fetchReactNativeInstalledArtifactBytesViaMachineRpc({
            machineId: 'machine-1',
            serverId: 'server-1',
            identity,
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: ['artifact_not_installed'],
        });
        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
            payload: expect.objectContaining({
                machineId: 'machine-1',
                cacheIdentity: identity,
            }),
        }));
    });

    it('fails closed when an older daemon does not expose the artifact-byte method', async () => {
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            error: 'unsupported by this daemon',
        });

        await expect(fetchReactNativeInstalledArtifactBytesViaMachineRpc({
            machineId: 'machine-1',
            serverId: 'server-1',
            identity,
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: ['react_native_artifact_bytes_rpc_unavailable'],
        });
    });
});
