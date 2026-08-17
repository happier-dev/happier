import {
    DaemonPluginUiArtifactBytesReadRequestSchema,
    DaemonPluginUiArtifactBytesReadResponseSchema,
    type DaemonPluginUiArtifactBytesReadResponse,
} from '@happier-dev/protocol';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';

import type { PluginHostedWebExactArtifactByteFetcher } from './hostedWebArtifactLease';

function unavailableArtifactBytes(
    diagnostic: string,
): DaemonPluginUiArtifactBytesReadResponse {
    return DaemonPluginUiArtifactBytesReadResponseSchema.parse({
        ok: false,
        code: 'artifact_unavailable',
        diagnostics: [diagnostic],
    });
}

/**
 * The hosted-web platform transport for Artifact's exact daemon source. It
 * carries the renderer's projection identity over the existing closed byte
 * RPC; it never accepts a loose machine id, URL, or React-Native runtime fact.
 */
export const fetchHostedWebExactArtifactBytesViaMachineRpc: PluginHostedWebExactArtifactByteFetcher = async (input) => {
    if (input.origin.materializationRef.pluginId !== input.identity.pluginId) {
        return unavailableArtifactBytes('hosted_web_artifact_origin_plugin_mismatch');
    }
    try {
        const payload = DaemonPluginUiArtifactBytesReadRequestSchema.parse({
            artifactFamily: 'hostedWeb',
            machineId: input.origin.materializationRef.machineId,
            cacheIdentity: input.identity,
        });
        const raw = await callGuardedMachineRpcWithPolicy<unknown, typeof payload>({
            machineId: input.origin.materializationRef.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
            payload,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return unavailableArtifactBytes('hosted_web_artifact_bytes_rpc_unavailable');
        }
        const parsed = DaemonPluginUiArtifactBytesReadResponseSchema.safeParse(raw);
        if (!parsed.success) {
            return unavailableArtifactBytes('hosted_web_artifact_bytes_response_invalid');
        }
        return parsed.data;
    } catch {
        return unavailableArtifactBytes('hosted_web_artifact_bytes_fetch_failed');
    }
};
