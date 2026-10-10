import {
    DaemonPluginUiArtifactBytesReadRequestSchema,
    DaemonPluginUiArtifactBytesReadResponseSchema,
    type DaemonPluginUiArtifactBytesReadResponse,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginUiArtifactDigestV1 } from '@happier-dev/protocol/plugins/ui';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { decodeBase64 } from '@/encryption/base64';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';

import type {
    PluginArtifactDaemonTransport,
    PluginArtifactFileSet,
    PluginArtifactSourceCandidate,
} from './artifactLease';

export type PluginArtifactDaemonFamily = 'reactNative' | 'hostedWeb';

export type PluginArtifactDaemonByteFetcher = (input: Readonly<{
    transport: PluginArtifactDaemonTransport;
    family: PluginArtifactDaemonFamily;
    digest: PluginUiArtifactDigestV1;
    signal?: AbortSignal;
}>) => Promise<DaemonPluginUiArtifactBytesReadResponse>;

function unavailableArtifactBytes(diagnostic: string): DaemonPluginUiArtifactBytesReadResponse {
    return DaemonPluginUiArtifactBytesReadResponseSchema.parse({
        ok: false,
        code: 'artifact_unavailable',
        diagnostics: [diagnostic],
    });
}

/** The daemon byte RPC: machine route plus the selected digest, nothing else. */
export const fetchPluginArtifactBytesViaMachineRpc: PluginArtifactDaemonByteFetcher = async (input) => {
    try {
        const payload = DaemonPluginUiArtifactBytesReadRequestSchema.parse({
            artifactFamily: input.family,
            machineId: input.transport.machineId,
            cacheIdentity: { artifactDigest: input.digest },
        });
        const raw = await callGuardedMachineRpcWithPolicy<unknown, typeof payload>({
            machineId: input.transport.machineId,
            serverId: input.transport.serverId,
            method: RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
            payload,
            // Artifact work follows the requesting surface's lifetime. A slow
            // read is still pending; only connection/setup uses the RPC budget.
            operationTimeoutMs: null,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (isRpcMethodNotFoundResult(raw)) return unavailableArtifactBytes('artifact_bytes_rpc_unavailable');
        const parsed = DaemonPluginUiArtifactBytesReadResponseSchema.safeParse(raw);
        return parsed.success ? parsed.data : unavailableArtifactBytes('artifact_bytes_response_invalid');
    } catch {
        return unavailableArtifactBytes('artifact_bytes_fetch_failed');
    }
};

function decodeDaemonFileSet(
    response: DaemonPluginUiArtifactBytesReadResponse,
    family: PluginArtifactDaemonFamily,
    digest: PluginUiArtifactDigestV1,
): PluginArtifactFileSet | null {
    if (
        !response.ok
        || response.artifactFamily !== family
        || response.artifact.digest !== digest
        || !response.files?.length
    ) {
        return null;
    }
    const files = new Map<string, Uint8Array>();
    for (const file of response.files) {
        if (files.has(file.relativePath)) return null;
        try {
            files.set(file.relativePath, decodeBase64(file.bytesBase64, 'base64'));
        } catch {
            return null;
        }
    }
    return files;
}

/**
 * The daemon byte source for every Artifact family and consumer: it asks one
 * machine for the selected digest's file set. It decides nothing about
 * currentness or admission; the lease verifies the returned bytes.
 */
export function createPluginArtifactDaemonSource(input: Readonly<{
    transport: PluginArtifactDaemonTransport;
    family: PluginArtifactDaemonFamily;
    fetchArtifactBytes?: PluginArtifactDaemonByteFetcher;
}>): PluginArtifactSourceCandidate {
    const fetchArtifactBytes = input.fetchArtifactBytes ?? fetchPluginArtifactBytesViaMachineRpc;
    return Object.freeze({
        kind: 'daemon' as const,
        fetch: async ({ artifact, signal }) => {
            if (signal?.aborted) return null;
            const response = await fetchArtifactBytes({
                transport: input.transport,
                family: input.family,
                digest: artifact.digest,
                ...(signal ? { signal } : {}),
            });
            return signal?.aborted ? null : decodeDaemonFileSet(response, input.family, artifact.digest);
        },
    });
}
