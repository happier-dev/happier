import { TransferChunkEnvelopeSchema, type PromptRegistryConfiguredSourceV1, type TransferEndpointCandidate } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { type ChunkDownloadProgress, downloadInChunks } from './chunkTransferClient';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';
import { digest } from '@/platform/digest';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from './transferChunkEncryption';
import { resolveBulkTransferJsonMaxBytes } from './resolveBulkTransferJsonMaxBytes';
import type { BulkTransferFileDestination } from './downloadBulkPayloadToFile';

type DirectTransferExportPrepareRequest =
    | Readonly<{
        t: 'prompt_asset_download_v1';
        assetTypeId: string;
        scope: 'user' | 'project';
        externalRef: Record<string, unknown>;
    }>
    | Readonly<{
        t: 'prompt_registry_download_v1';
        sourceId: string;
        itemId: string;
        configuredSources: readonly PromptRegistryConfiguredSourceV1[];
    }>
    | Readonly<{
        t: 'workspace_file_download_v1';
        workingDirectory: string;
        path: string;
        asZip: boolean;
    }>;

type DirectTransferExportPrepareResponse =
    | Readonly<{
        success: true;
        transferId: string;
        endpointCandidates: readonly TransferEndpointCandidate[];
        expiresAt: number;
        name?: string;
        sizeBytes?: number;
    }>
    | Readonly<{
        success: false;
        error: string;
        errorCode?: string;
    }>;

type DirectTransferOpenResponse = Readonly<{
    transferId: string;
    manifestHash: string;
    totalChunks: number;
}>;

type DirectTransferJsonDownloadResponse<TPayload> =
    | Readonly<{ ok: true; payload: TPayload }>
    | Readonly<{ ok: false; error: string }>;

type DirectTransferFileDownloadResponse =
    | Readonly<{ ok: true; name: string; sizeBytes: number }>
    | Readonly<{ ok: false; error: string }>;

type DirectTransferFailureResponse = Readonly<{
    success: false;
    error: string;
    errorCode?: string;
}>;

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDirectTransferExportPrepareSuccess(value: unknown): value is Extract<DirectTransferExportPrepareResponse, { success: true }> {
    return isObject(value)
        && typeof value.transferId === 'string'
        && Array.isArray(value.endpointCandidates)
        && typeof value.expiresAt === 'number'
        && (value.name === undefined || typeof value.name === 'string')
        && (value.sizeBytes === undefined || typeof value.sizeBytes === 'number');
}

function isDirectTransferOpenResponse(value: unknown): value is DirectTransferOpenResponse {
    return isObject(value)
        && typeof value.transferId === 'string'
        && typeof value.manifestHash === 'string'
        && typeof value.totalChunks === 'number';
}

function extractDirectPeerRequestAuth(candidate: TransferEndpointCandidate): Readonly<{
    requestUrl: string;
    authorizationHeader?: string;
}> {
    const authorizationToken = typeof candidate.authorizationToken === 'string'
        ? candidate.authorizationToken.trim()
        : '';
    const parsed = new URL(candidate.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Invalid direct peer endpoint candidate');
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    if (segments.length !== 3 || segments[0] !== 'machine-transfers' || segments[1] !== 'direct' || segments[2].length === 0) {
        throw new Error('Invalid direct peer endpoint candidate');
    }
    return {
        requestUrl: parsed.toString(),
        ...(authorizationToken
            ? { authorizationHeader: `Bearer ${authorizationToken}` }
            : {}),
    };
}

function buildDirectExportEndpoint(baseUrl: string, suffix: 'open' | 'chunks', sequence?: number): string {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname}/${suffix}${typeof sequence === 'number' ? `/${sequence}` : ''}`;
    return url.toString();
}

function concatenateChunks(chunks: readonly Uint8Array[]): Uint8Array {
    const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function computeManifestHash(payload: Uint8Array): Promise<string> {
    const payloadCopy = new Uint8Array(new ArrayBuffer(payload.byteLength));
    payloadCopy.set(payload);
    const digestBytes = await digest('SHA-256', payloadCopy);
    return `sha256:${bytesToHex(digestBytes)}`;
}

async function cleanupFailedDestination(destination: BulkTransferFileDestination): Promise<void> {
    if (destination.cleanup) {
        await destination.cleanup();
        return;
    }

    await destination.close();
}

export async function downloadBulkPayloadViaDirectExportToDestination(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    request: DirectTransferExportPrepareRequest;
    destination: BulkTransferFileDestination;
    onInit?: ((init: Readonly<{ name: string; sizeBytes: number }>) => Promise<void | DirectTransferFailureResponse>) | null;
    onProgress?: ((progress: ChunkDownloadProgress) => void) | null;
    signal?: AbortSignal | null;
}>): Promise<DirectTransferFileDownloadResponse> {
    const prepare = await callGuardedMachineRpcWithPolicy<DirectTransferExportPrepareResponse, DirectTransferExportPrepareRequest>({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
        payload: params.request,
    });

    if (prepare.success !== true) {
        await cleanupFailedDestination(params.destination);
        return {
            ok: false,
            error: prepare.error,
        };
    }
    if (!isDirectTransferExportPrepareSuccess(prepare)) {
        await cleanupFailedDestination(params.destination);
        return { ok: false, error: 'Direct export prepare returned an unsupported response' };
    }
    if (prepare.endpointCandidates.length === 0) {
        await cleanupFailedDestination(params.destination);
        return { ok: false, error: 'Direct export endpoints unavailable' };
    }
    if (typeof prepare.name !== 'string' || typeof prepare.sizeBytes !== 'number' || !Number.isFinite(prepare.sizeBytes) || prepare.sizeBytes < 0) {
        await cleanupFailedDestination(params.destination);
        return { ok: false, error: 'Direct export prepare returned invalid file metadata' };
    }

    if (params.onInit) {
        const sideEffect = await params.onInit({ name: prepare.name, sizeBytes: prepare.sizeBytes });
        if (sideEffect && sideEffect.success === false) {
            await cleanupFailedDestination(params.destination);
            return { ok: false, error: sideEffect.error };
        }
    }

    const recipientKeyPair = createTransferRecipientKeyPair();

    for (const candidate of prepare.endpointCandidates) {
        try {
            const streamedChunks: Uint8Array[] = [];
            const { requestUrl, authorizationHeader } = extractDirectPeerRequestAuth(candidate);
            const openHeaders = {
                'content-type': 'application/json',
                ...(authorizationHeader ? { authorization: authorizationHeader } : {}),
            };

            const openResponse = await runtimeFetch(buildDirectExportEndpoint(requestUrl, 'open'), {
                method: 'POST',
                headers: openHeaders,
                body: JSON.stringify({
                    recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                }),
                credentials: 'same-origin',
            });
            const openJson = await openResponse.json();
            if (!isDirectTransferOpenResponse(openJson) || openJson.transferId !== prepare.transferId) {
                throw new Error('Direct export open returned invalid metadata');
            }

            const download = await downloadInChunks({
                init: async () => ({
                    success: true as const,
                    downloadId: prepare.transferId,
                    chunkSizeBytes: 1,
                    sizeBytes: prepare.sizeBytes,
                }),
                readChunk: async ({ index }) => {
                    const chunkResponse = await runtimeFetch(buildDirectExportEndpoint(requestUrl, 'chunks', index), {
                        method: 'GET',
                        headers: authorizationHeader ? { authorization: authorizationHeader } : undefined,
                        credentials: 'same-origin',
                    });
                    const chunkJson = await chunkResponse.json();
                    const parsedChunk = TransferChunkEnvelopeSchema.safeParse(chunkJson);
                    if (
                        !parsedChunk.success
                        || parsedChunk.data.transferId !== prepare.transferId
                        || parsedChunk.data.sequence !== index
                        || !parsedChunk.data.encryptedDataKeyEnvelopeBase64
                    ) {
                        throw new Error('Direct export chunk returned invalid payload');
                    }

                    return {
                        success: true as const,
                        payloadBase64: parsedChunk.data.payloadBase64,
                        encryptedDataKeyEnvelopeBase64: parsedChunk.data.encryptedDataKeyEnvelopeBase64,
                        isLast: index + 1 >= openJson.totalChunks,
                    };
                },
                finalize: async () => ({ success: true as const }),
                recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
                writeBytes: async (bytes) => {
                    streamedChunks.push(new Uint8Array(bytes));
                    await params.destination.writeBytes(bytes);
                },
                onProgress: params.onProgress ?? null,
                signal: params.signal ?? null,
            });
            if (!download.ok) {
                await cleanupFailedDestination(params.destination);
                continue;
            }

            const manifestHash = await computeManifestHash(concatenateChunks(streamedChunks));
            if (manifestHash !== openJson.manifestHash) {
                throw new Error('Direct export file manifest mismatch');
            }

            await params.destination.close();
            return {
                ok: true,
                name: prepare.name,
                sizeBytes: download.sizeBytes,
            };
        } catch {
            await cleanupFailedDestination(params.destination);
            continue;
        }
    }

    return { ok: false, error: 'Direct export download unavailable' };
}


export async function downloadBulkJsonPayloadViaDirectExport<TPayload>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    request: DirectTransferExportPrepareRequest;
    parsePayload: (value: unknown) => TPayload | null;
}>): Promise<DirectTransferJsonDownloadResponse<TPayload>> {
    const prepare = await callGuardedMachineRpcWithPolicy<DirectTransferExportPrepareResponse, DirectTransferExportPrepareRequest>({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
        payload: params.request,
    });

    if (prepare.success !== true) {
        return {
            ok: false,
            error: prepare.error,
        };
    }
    if (!isDirectTransferExportPrepareSuccess(prepare)) {
        return { ok: false, error: 'Direct export prepare returned an unsupported response' };
    }
    if (prepare.endpointCandidates.length === 0) {
        return { ok: false, error: 'Direct export endpoints unavailable' };
    }

    const jsonMaxBytes = resolveBulkTransferJsonMaxBytes(null);
    const recipientKeyPair = createTransferRecipientKeyPair();

    for (const candidate of prepare.endpointCandidates) {
        try {
            const { requestUrl, authorizationHeader } = extractDirectPeerRequestAuth(candidate);
            const headers = {
                'content-type': 'application/json',
                ...(authorizationHeader ? { authorization: authorizationHeader } : {}),
            };

            const openResponse = await runtimeFetch(buildDirectExportEndpoint(requestUrl, 'open'), {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                }),
                credentials: 'same-origin',
            });
            const openJson = await openResponse.json();
            if (!isDirectTransferOpenResponse(openJson) || openJson.transferId !== prepare.transferId) {
                throw new Error('Direct export open returned invalid metadata');
            }

            const chunks: Uint8Array[] = [];
            let totalBytes = 0;
            for (let sequence = 0; sequence < openJson.totalChunks; sequence += 1) {
                const chunkResponse = await runtimeFetch(buildDirectExportEndpoint(requestUrl, 'chunks', sequence), {
                    method: 'GET',
                    headers: authorizationHeader ? { authorization: authorizationHeader } : undefined,
                    credentials: 'same-origin',
                });
                const chunkJson = await chunkResponse.json();
                const parsedChunk = TransferChunkEnvelopeSchema.safeParse(chunkJson);
                if (
                    !parsedChunk.success
                    || parsedChunk.data.transferId !== prepare.transferId
                    || parsedChunk.data.sequence !== sequence
                    || !parsedChunk.data.encryptedDataKeyEnvelopeBase64
                ) {
                    throw new Error('Direct export chunk returned invalid payload');
                }

                const chunk = await decryptEncryptedTransferChunkEnvelope({
                    transferId: prepare.transferId,
                    sequence,
                    payloadBase64: parsedChunk.data.payloadBase64,
                    encryptedDataKeyEnvelopeBase64: parsedChunk.data.encryptedDataKeyEnvelopeBase64,
                    recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
                });
                totalBytes += chunk.byteLength;
                if (totalBytes > jsonMaxBytes) {
                    return { ok: false, error: `Downloaded JSON payload exceeds max allowed bytes (${jsonMaxBytes})` };
                }
                chunks.push(chunk);
            }

            const payloadBytes = new Uint8Array(totalBytes);
            let offset = 0;
            for (const chunk of chunks) {
                payloadBytes.set(chunk, offset);
                offset += chunk.byteLength;
            }

            const manifestHash = await computeManifestHash(payloadBytes);
            if (manifestHash !== openJson.manifestHash) {
                throw new Error('Direct export payload manifest mismatch');
            }

            const parsedJson = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(payloadBytes));
            const parsedPayload = params.parsePayload(parsedJson);
            if (parsedPayload === null) {
                return {
                    ok: false,
                    error: 'Downloaded transfer payload returned an unsupported response',
                };
            }
            return { ok: true, payload: parsedPayload };
        } catch {
            continue;
        }
    }

    return { ok: false, error: 'Direct export download unavailable' };
}
