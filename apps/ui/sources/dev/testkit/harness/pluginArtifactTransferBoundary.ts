import {
    DaemonPluginUiArtifactBytesReadRequestSchema,
    DaemonPluginUiArtifactBytesReadResponseSchema,
    type DaemonPluginUiArtifactBytesReadRequest,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { MachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { PreparedTransferRpcRequestV1Schema, PreparedTransferRpcResponseV1Schema } from '@happier-dev/protocol/machines/transfer/preparedTransferRpcV1';
import { createTransferManifestHasher } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferManifestHasher';
import { createEncryptedTransferChunkEnvelope } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';

/** Real finite-transfer declaration, without an Iroh/native transport dependency. */
export const pluginArtifactTransferDaemonState = MachinePublishedDaemonStateV1Schema.parse({
    status: 'running', transfer: { supported: { import: true, export: true }, listenerClasses: {
        loopback_http: { enabled: false, configured: false, active: false },
        tailscale_serve_https: { enabled: false, configured: false, active: false },
    }, lifecycle: { mode: 'lazy_idle_shutdown', version: 1 } },
});

type BoundaryRequest = Readonly<{ method: string; machineId: string; payload: unknown }>;

/**
 * External daemon boundary for composed Artifact consumers. Preparation carries
 * only a capability; the real downloader, Home phase adapter and chunk codec run.
 */
export function createPluginArtifactTransferBoundary(readArtifact: (
    request: Readonly<{ method: string; machineId: string; payload: DaemonPluginUiArtifactBytesReadRequest }>,
) => unknown | Promise<unknown>) {
    // Match transferRuntimeConfig's prepared direct-export default, including large bundles.
    const chunkSizeBytes = 256 * 1024;
    const transfers = new Map<string, Readonly<{ bytes: Uint8Array; manifestHash: string; authorizationToken: string }>>();
    const requests: BoundaryRequest[] = [];
    let nextTransferId = 0;
    const methods = new Set<string>([
        RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
        RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE,
        RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
        RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
        RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE,
        RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
    ]);
    const methodName = (method: string) => method.slice(method.lastIndexOf(':') + 1);
    return {
        requests,
        handles: (method: string) => methods.has(methodName(method)),
        request: async (request: BoundaryRequest): Promise<unknown> => {
            requests.push(request);
            const method = methodName(request.method);
            if (method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE) {
                if (request.payload && typeof request.payload === 'object' && 'transferId' in request.payload
                    && typeof request.payload.transferId === 'string') transfers.delete(request.payload.transferId);
                return { success: true };
            }
            if (method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE) {
                const payload = request.payload;
                if (!payload || typeof payload !== 'object' || !('t' in payload) || payload.t !== 'plugin_ui_artifact_download_v1'
                    || !('request' in payload)) throw new Error('Expected an Artifact finite-transfer request');
                const artifactRequest = DaemonPluginUiArtifactBytesReadRequestSchema.parse(payload.request);
                const response = DaemonPluginUiArtifactBytesReadResponseSchema.parse(await readArtifact({ ...request, payload: artifactRequest }));
                const bytes = new TextEncoder().encode(JSON.stringify(response));
                const hash = createTransferManifestHasher();
                hash.update(bytes);
                const transferId = `plugin-artifact-fixture-${++nextTransferId}`;
                const authorizationToken = `artifact-token-${nextTransferId}`;
                const manifestHash = hash.digestManifestHash();
                transfers.set(transferId, { bytes, manifestHash, authorizationToken });
                const expiresAt = Date.now() + DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier;
                return { success: true, transferId, name: 'plugin-ui-artifact.json', sizeBytes: bytes.length, expiresAt,
                    endpointCandidates: [{ kind: 'http',
                        url: `http://127.0.0.1:46001/machine-transfers/direct/${Buffer.from(transferId).toString('base64url')}`,
                        authorizationToken, expiresAt }] };
            }
            const phase = PreparedTransferRpcRequestV1Schema.parse(request.payload);
            const encodedId = phase.path.split('/')[3];
            const transferId = Buffer.from(encodedId ?? '', 'base64url').toString();
            const transfer = transfers.get(transferId);
            if (!transfer || phase.authorizationToken !== transfer.authorizationToken) throw new Error('Unknown Artifact transfer capability');
            let body: unknown;
            if (method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT) {
                body = { transferId, totalChunks: Math.ceil(transfer.bytes.length / chunkSizeBytes), sizeBytes: transfer.bytes.length, manifestHash: transfer.manifestHash };
            } else if (method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK) {
                if (!phase.recipientPublicKeyBase64) throw new Error('Missing Artifact transfer recipient');
                const sequence = Number(phase.path.split('/').at(-1));
                const chunk = transfer.bytes.subarray(sequence * chunkSizeBytes, (sequence + 1) * chunkSizeBytes);
                body = { transferId, kind: 'chunk', sequence, ...await createEncryptedTransferChunkEnvelope({
                    transferId, sequence, payload: chunk, recipientPublicKeyBase64: phase.recipientPublicKeyBase64,
                }) };
            } else {
                body = { success: true };
                transfers.delete(transferId);
            }
            return PreparedTransferRpcResponseV1Schema.parse({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        },
    };
}
