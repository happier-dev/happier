import {
    DaemonPluginUiArtifactBytesReadRequestSchema,
    DaemonPluginUiArtifactBytesReadResponseSchema,
    isSameDaemonPluginReactNativeCrashBindingTokenV1,
    type DaemonPluginReactNativeCrashBindingTokenV1,
    type DaemonPluginUiArtifactBytesReadResponse,
} from '@happier-dev/protocol';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    resolveNativeReactNativeHostRuntimeIdentity,
    resolveReactNativeWebLoaderCapability,
} from '@/components/plugins/reactNative/hostRuntimeIdentity';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';

import type { PluginReactNativeExactArtifactByteFetcher } from './reactNativeArtifactLease';

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
 * The React Native platform transport for Artifact's exact-daemon source. It
 * receives an Administration-stamped origin and never accepts a loose machine
 * id, so route selection cannot become a renderer-local fallback.
 */
export const fetchReactNativeExactArtifactBytesViaMachineRpc: PluginReactNativeExactArtifactByteFetcher = async (input) => {
    if (input.origin.materializationRef.pluginId !== input.identity.pluginId) {
        return unavailableArtifactBytes('react_native_artifact_origin_plugin_mismatch');
    }
    try {
        const reactNativeHostRuntimeIdentity = resolveNativeReactNativeHostRuntimeIdentity();
        const reactNativeWebLoaderCapability = resolveReactNativeWebLoaderCapability();
        const payload = input.artifactOwnerKind === 'renderer'
            ? DaemonPluginUiArtifactBytesReadRequestSchema.parse({
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'renderer',
                machineId: input.origin.materializationRef.machineId,
                cacheIdentity: input.identity,
                crashStateToken: input.crashStateToken,
                ...(reactNativeHostRuntimeIdentity ? { reactNativeHostRuntimeIdentity } : {}),
                ...(reactNativeWebLoaderCapability ? { reactNativeWebLoaderCapability } : {}),
            })
            : input.artifactOwnerKind === 'voiceProvider'
                ? DaemonPluginUiArtifactBytesReadRequestSchema.parse({
                    artifactFamily: 'reactNative',
                    artifactOwnerKind: 'voiceProvider',
                    machineId: input.origin.materializationRef.machineId,
                    cacheIdentity: input.identity,
                    ...(reactNativeHostRuntimeIdentity ? { reactNativeHostRuntimeIdentity } : {}),
                    ...(reactNativeWebLoaderCapability ? { reactNativeWebLoaderCapability } : {}),
                })
                : DaemonPluginUiArtifactBytesReadRequestSchema.parse({
                    artifactFamily: 'reactNative',
                    artifactOwnerKind: 'collectionMigrations',
                    machineId: input.origin.materializationRef.machineId,
                    cacheIdentity: input.identity,
                    ...(reactNativeHostRuntimeIdentity ? { reactNativeHostRuntimeIdentity } : {}),
                    ...(reactNativeWebLoaderCapability ? { reactNativeWebLoaderCapability } : {}),
                });
        const raw = await callGuardedMachineRpcWithPolicy<unknown, typeof payload>({
            machineId: input.origin.materializationRef.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
            payload,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return unavailableArtifactBytes('react_native_artifact_bytes_rpc_unavailable');
        }
        const parsed = DaemonPluginUiArtifactBytesReadResponseSchema.safeParse(raw);
        if (!parsed.success) {
            return unavailableArtifactBytes('react_native_artifact_bytes_response_invalid');
        }
        if (!parsed.data.ok) return parsed.data;
        if (
            parsed.data.artifactFamily !== 'reactNative'
            || parsed.data.artifactOwnerKind !== input.artifactOwnerKind
        ) {
            return unavailableArtifactBytes('react_native_artifact_bytes_response_owner_mismatch');
        }
        if (
            input.artifactOwnerKind === 'renderer'
            && (
                parsed.data.artifactOwnerKind !== 'renderer'
                || !isSameDaemonPluginReactNativeCrashBindingTokenV1(
                    parsed.data.crashStateToken,
                    input.crashStateToken,
                )
            )
        ) {
            return unavailableArtifactBytes('react_native_artifact_bytes_response_crash_state_mismatch');
        }
        return parsed.data;
    } catch {
        return unavailableArtifactBytes('react_native_artifact_bytes_fetch_failed');
    }
};
