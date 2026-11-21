import {
    DaemonPluginUiArtifactBytesReadRequestSchema,
    DaemonPluginUiArtifactBytesReadResponseSchema,
    type DaemonPluginUiArtifactBytesReadResponse,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginUiArtifactDigestV1 } from '@happier-dev/protocol/plugins/ui';
import { decodeBase64 } from '@/encryption/base64';
import { downloadBulkPayloadViaDirectExportToDestination } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferExportDownload';
import { resolveMachineCarrierRoute } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/machineCarrierHttpLease';
import { logPluginSurfaceDiagnostic, readPluginSurfaceTransferFailureCodes } from '@/components/plugins/shared/pluginSurfaceDiagnosticLog';

import type {
    PluginArtifactDaemonTransport,
    PluginArtifactFileSet,
    PluginArtifactSourceCandidate,
} from './artifactLease';
import { PluginArtifactSourceError } from './artifactLease';
import type { PluginAccountAvailabilityReader } from './reader';

export type PluginArtifactDaemonFamily = 'reactNative' | 'hostedWeb';

export type PluginArtifactDaemonByteFetcher = (input: Readonly<{
    transport: PluginArtifactDaemonTransport;
    family: PluginArtifactDaemonFamily;
    digest: PluginUiArtifactDigestV1;
    signal?: AbortSignal;
}>) => Promise<DaemonPluginUiArtifactBytesReadResponse & Readonly<{ failureReason?: string }>>;

function unavailableArtifactBytes(diagnostic: string): DaemonPluginUiArtifactBytesReadResponse {
    return DaemonPluginUiArtifactBytesReadResponseSchema.parse({
        ok: false,
        code: 'artifact_unavailable',
        diagnostics: [diagnostic],
    });
}

/** The incumbent finite carrier owns route selection, encrypted chunks and cleanup. */
export const fetchPluginArtifactBytesViaMachineTransfer: PluginArtifactDaemonByteFetcher = async (input) => {
    const unavailableTransfer = (failure: unknown) => {
        const transferFailure = readPluginSurfaceTransferFailureCodes(failure);
        const failureReason = transferFailure.outcomeCode ?? transferFailure.osCode;
        logPluginSurfaceDiagnostic({ pluginId: null, contributionId: null, surfaceId: null }, {
            artifactFailure: 'artifact_bytes_fetch_failed',
            artifactDigest: input.digest,
            artifactFamily: input.family,
            transferFailure,
        });
        return { ...unavailableArtifactBytes('artifact_bytes_fetch_failed'), ...(failureReason ? { failureReason } : {}) };
    };
    try {
        const payload = DaemonPluginUiArtifactBytesReadRequestSchema.parse({
            artifactFamily: input.family,
            machineId: input.transport.machineId,
            cacheIdentity: { artifactDigest: input.digest },
        });
        const route = await resolveMachineCarrierRoute(input.transport.machineId, input.transport.serverId, { homeRpcFallback: 'required' });
        if (route.kind === 'unavailable') return unavailableArtifactBytes('artifact_bytes_rpc_unavailable');
        let bytes = new Uint8Array(0);
        let offset = 0;
        const downloaded = await downloadBulkPayloadViaDirectExportToDestination({
            machineId: input.transport.machineId,
            serverId: route.serverId,
            request: { t: 'plugin_ui_artifact_download_v1', request: payload },
            // Artifact JSON is an exact byte set, not a file preview. The
            // prepared transfer's declared size owns allocation and validation.
            onInit: async ({ sizeBytes }) => { bytes = new Uint8Array(sizeBytes); offset = 0; },
            destination: {
                writeBytes: async chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; },
                close: async () => {},
                cleanup: async () => { bytes = new Uint8Array(0); offset = 0; },
            },
            acquirePreparedCarrier: async ({ operationId }) => await route.acquire({
                operationId, ...(input.signal ? { signal: input.signal } : {}),
            }),
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!downloaded.ok) return unavailableTransfer(downloaded);
        try {
            const parsed = DaemonPluginUiArtifactBytesReadResponseSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
            return parsed.success ? parsed.data : unavailableArtifactBytes('artifact_bytes_response_invalid');
        } catch {
            return unavailableArtifactBytes('artifact_bytes_response_invalid');
        }
    } catch (error) {
        return unavailableTransfer(error);
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
 * The daemon byte source for every Artifact family and consumer: it asks the
 * admitted byte suppliers for the selected digest's file set. It decides
 * nothing about currentness or admission; the lease verifies the returned bytes.
 */
export function createPluginArtifactDaemonSource(input: Readonly<{
    family: PluginArtifactDaemonFamily;
    fetchArtifactBytes?: PluginArtifactDaemonByteFetcher;
    /** Current Account advertisements supply byte routes, never execution authority. */
    availability?: Readonly<{ reader: PluginAccountAvailabilityReader; serverId: string }>;
} & (
    | { transport: PluginArtifactDaemonTransport; transports?: never }
    | { transports: readonly PluginArtifactDaemonTransport[]; transport?: never }
)>): PluginArtifactSourceCandidate {
    const fetchArtifactBytes = input.fetchArtifactBytes ?? fetchPluginArtifactBytesViaMachineTransfer;
    return Object.freeze({
        kind: 'daemon' as const,
        fetch: async ({ artifact, signal }) => {
            const availability = input.availability;
            const inventory = availability?.reader.readMaterializations();
            const advertised = availability && inventory?.kind === 'available' ? inventory.materializations.filter(materialization => (
                materialization.pluginId === artifact.pluginId
                && materialization.uiArtifacts.some(slot => slot.artifactId === artifact.artifactId
                    && slot.tier === artifact.tier && slot.platform === artifact.platform && slot.artifactDigest === artifact.digest)
            )).map(materialization => ({ machineId: materialization.machineId, serverId: availability.serverId })) : [];
            const seen = new Set<string>();
            const transports = [...(input.transports ?? [input.transport]), ...advertised].filter(transport => {
                const key = JSON.stringify([transport.serverId, transport.machineId]);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            let failure: PluginArtifactSourceError | undefined;
            for (const transport of transports) {
                if (signal?.aborted) return null;
                const response = await fetchArtifactBytes({
                    transport,
                    family: input.family,
                    digest: artifact.digest,
                    ...(signal ? { signal } : {}),
                });
                if (signal?.aborted) return null;
                if (!response.ok) {
                    for (const diagnostic of response.diagnostics) {
                        switch (diagnostic) {
                            case 'artifact_bytes_rpc_unavailable':
                            case 'artifact_bytes_response_invalid':
                            case 'plugin_host_access_disclosure_mismatch':
                                failure ??= new PluginArtifactSourceError(diagnostic);
                                break;
                            case 'artifact_bytes_fetch_failed':
                                failure ??= new PluginArtifactSourceError(diagnostic, response.failureReason);
                                break;
                        }
                    }
                    continue;
                }
                const files = decodeDaemonFileSet(response, input.family, artifact.digest);
                if (files) return files;
            }
            if (failure) throw failure;
            return null;
        },
    });
}
