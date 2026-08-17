import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

const callGuardedMachineRpcWithPolicyMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: callGuardedMachineRpcWithPolicyMock,
}));

import { fetchHostedWebExactArtifactBytesViaMachineRpc } from './hostedWebArtifactDaemonTransport';

const identity = {
    pluginId: 'com.acme.hosted',
    contributionId: 'hosted-renderer',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    platform: 'web' as const,
    projectionGeneration: 9,
} as const;

const origin = {
    serverIdentityId: 'server-identity-a',
    materializationRef: {
        machineId: 'machine-a',
        materializationId: 'install-a',
        pluginId: identity.pluginId,
    },
} as const;

describe('hosted-web Artifact machine RPC transport', () => {
    beforeEach(() => {
        callGuardedMachineRpcWithPolicyMock.mockReset();
    });

    it('uses the closed hosted-web byte family and its exact projected identity', async () => {
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: ['artifact_not_installed'],
        });

        await expect(fetchHostedWebExactArtifactBytesViaMachineRpc({
            origin,
            serverId: 'server-a',
            identity,
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: ['artifact_not_installed'],
        });

        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledWith({
            machineId: origin.materializationRef.machineId,
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
            payload: {
                artifactFamily: 'hostedWeb',
                machineId: origin.materializationRef.machineId,
                cacheIdentity: identity,
            },
        });
    });

    it('fails closed when a supported older daemon lacks the hosted artifact byte route', async () => {
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            error: 'unsupported by this daemon',
        });

        await expect(fetchHostedWebExactArtifactBytesViaMachineRpc({
            origin,
            serverId: 'server-a',
            identity,
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: ['hosted_web_artifact_bytes_rpc_unavailable'],
        });
    });
});
