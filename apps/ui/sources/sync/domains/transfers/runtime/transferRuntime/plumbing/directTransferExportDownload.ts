import {
    isSafeDirectTransferEndpointCandidate,
    normalizeDirectPeerTransferEndpointBaseUrl,
    TransferChunkEnvelopeSchema,
    type PromptRegistryConfiguredSourceV1,
    type TransferEndpointCandidate,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { type ChunkDownloadProgress, downloadInChunks } from './chunkTransferClient';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';
import { readBoundedResponseBody } from '@/utils/system/readBoundedResponseBody';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from './transferChunkEncryption';
import { cleanupBulkTransferDestination } from './cleanupBulkTransferDestination';
import { resolveBulkTransferJsonMaxBytes } from './resolveBulkTransferJsonMaxBytes';
import type { BulkTransferFileDestination } from './bulkTransferFileDestination';
import { createTransferManifestHasher } from './transferManifestHasher';
import {
    createDirectTransferRequestAbortSignal,
    resolveDirectTransferRequestTimeoutMs,
} from './directTransferRequestDeadline';

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
    sizeBytes?: number;
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

type DirectTransferPrepareResult =
    | Readonly<{
        ok: true;
        prepare: Extract<DirectTransferExportPrepareResponse, { success: true }>;
    }>
    | Readonly<{
        ok: false;
        error: string;
    }>;

const DIRECT_TRANSFER_OPEN_RESPONSE_MAX_BYTES = 8 * 1024;
// Match the direct receiver's existing default request-work ceiling. The UI has no
// need to admit the daemon's larger configuration hard-max as one browser operation.
const DIRECT_TRANSFER_MAX_TOTAL_CHUNKS = 1_000_000;
// The direct producer caps plaintext chunks at 512 KiB. One MiB leaves ample room for
// base64 expansion, the encrypted data-key envelope, and JSON framing without admitting
// the broader multi-transport protocol envelope ceiling at this direct HTTP boundary.
const DIRECT_TRANSFER_CHUNK_RESPONSE_MAX_BYTES = 1024 * 1024;

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
        && value.transferId.length > 0
        && typeof value.manifestHash === 'string'
        && value.manifestHash.length > 0
        && Number.isSafeInteger(value.totalChunks)
        && (value.totalChunks as number) > 0
        && (
            value.sizeBytes === undefined
            || (Number.isSafeInteger(value.sizeBytes) && (value.sizeBytes as number) >= 0)
        );
}

function isDirectTransferChunkCountConsistent(totalChunks: number, maxPlaintextBytes: number): boolean {
    return Number.isSafeInteger(maxPlaintextBytes)
        && maxPlaintextBytes >= 0
        && totalChunks <= DIRECT_TRANSFER_MAX_TOTAL_CHUNKS
        && totalChunks <= Math.max(1, maxPlaintextBytes);
}

function toDirectTransferExportPrepareFailure(error: unknown): DirectTransferPrepareResult {
    return {
        ok: false,
        error: error instanceof Error ? error.message : 'Direct export unavailable',
    };
}

async function prepareDirectTransferExport(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    request: DirectTransferExportPrepareRequest;
    timeoutMs?: number | null;
    signal?: AbortSignal | null;
}>): Promise<DirectTransferPrepareResult> {
    try {
        const requestTimeoutMs = resolveDirectTransferRequestTimeoutMs(params.timeoutMs);
        const prepare = await callGuardedMachineRpcWithPolicy<DirectTransferExportPrepareResponse, DirectTransferExportPrepareRequest>({
            machineId: params.machineId,
            ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
            timeoutMs: requestTimeoutMs,
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
            payload: params.request,
            signal: params.signal ?? undefined,
        });

        if (prepare.success !== true) {
            return {
                ok: false,
                error: prepare.error,
            };
        }
        if (!isDirectTransferExportPrepareSuccess(prepare)) {
            return {
                ok: false,
                error: 'Direct export prepare returned an unsupported response',
            };
        }
        const endpointCandidates = prepare.endpointCandidates.filter(isSafeDirectTransferEndpointCandidate);
        if (endpointCandidates.length === 0) {
            return {
                ok: false,
                error: 'Direct export endpoints unavailable',
            };
        }

        return {
            ok: true,
            prepare: {
                ...prepare,
                endpointCandidates,
            },
        };
    } catch (error) {
        return toDirectTransferExportPrepareFailure(error);
    }
}

function extractDirectPeerRequestAuth(candidate: TransferEndpointCandidate): Readonly<{
    requestUrl: string;
    authorizationHeader?: string;
}> {
    const authorizationToken = typeof candidate.authorizationToken === 'string'
        ? candidate.authorizationToken.trim()
        : '';
    const requestUrl = normalizeDirectPeerTransferEndpointBaseUrl(candidate.url);
    return {
        requestUrl,
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

async function resetBulkTransferDestinationAfterCandidateFailure(destination: BulkTransferFileDestination): Promise<void> {
    if (destination.cleanup) {
        await destination.cleanup();
    }
}

async function runtimeFetchJsonWithDirectTransferTimeout(
    url: string,
    init: RequestInit,
    params: Readonly<{
        timeoutMs: number;
        maxBodyBytes: number;
        signal?: AbortSignal | null;
    }>,
): Promise<unknown> {
    const requestSignal = createDirectTransferRequestAbortSignal(params);
    try {
        const response = await runtimeFetch(url, {
            ...init,
            signal: requestSignal.signal,
        });
        if (!response.ok) {
            throw new Error(`Direct export request failed with status ${response.status}`);
        }
        const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
        if (contentType !== 'application/json') {
            throw new Error('Direct export response returned an unsupported content type');
        }
        const body = await readBoundedResponseBody({
            response,
            maxBytes: params.maxBodyBytes,
            signal: requestSignal.signal,
        });
        const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
        return JSON.parse(text) as unknown;
    } finally {
        requestSignal.cleanup();
    }
}

export async function downloadBulkPayloadViaDirectExportToDestination(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    request: DirectTransferExportPrepareRequest;
    destination: BulkTransferFileDestination;
    cleanupOnFailure?: boolean;
    onInit?: ((init: Readonly<{ name: string; sizeBytes: number }>) => Promise<void | DirectTransferFailureResponse>) | null;
    timeoutMs?: number | null;
    onProgress?: ((progress: ChunkDownloadProgress) => void) | null;
    signal?: AbortSignal | null;
}>): Promise<DirectTransferFileDownloadResponse> {
    async function cleanupFailedDestination(): Promise<void> {
        if (params.cleanupOnFailure === false) {
            return;
        }
        await cleanupBulkTransferDestination(params.destination);
    }

    async function returnCanceled(): Promise<DirectTransferFileDownloadResponse> {
        await cleanupFailedDestination();
        return { ok: false, error: 'Download canceled' };
    }

    if (params.signal?.aborted) {
        return await returnCanceled();
    }

    const prepared = await prepareDirectTransferExport(params);
    if (!prepared.ok) {
        await cleanupFailedDestination();
        return {
            ok: false,
            error: prepared.error,
        };
    }
    const prepare = prepared.prepare;
    if (typeof prepare.name !== 'string' || typeof prepare.sizeBytes !== 'number' || !Number.isFinite(prepare.sizeBytes) || prepare.sizeBytes < 0) {
        await cleanupFailedDestination();
        return { ok: false, error: 'Direct export prepare returned invalid file metadata' };
    }
    const preparedName = prepare.name;
    const preparedSizeBytes = prepare.sizeBytes;

    const initializeDestination = async (): Promise<DirectTransferFailureResponse | null> => {
        if (!params.onInit) return null;
        try {
            const sideEffect = await params.onInit({ name: preparedName, sizeBytes: preparedSizeBytes });
            if (sideEffect && sideEffect.success === false) {
                return { success: false, error: sideEffect.error };
            }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Direct export download unavailable',
            };
        }
        return null;
    };

    const initialDestinationFailure = await initializeDestination();
    if (initialDestinationFailure) {
        await cleanupFailedDestination();
        return { ok: false, error: initialDestinationFailure.error };
    }
    if (params.signal?.aborted) {
        return await returnCanceled();
    }

    const recipientKeyPair = createTransferRecipientKeyPair();
    const requestTimeoutMs = resolveDirectTransferRequestTimeoutMs(params.timeoutMs);

    for (const [index, candidate] of prepare.endpointCandidates.entries()) {
        const hasMoreCandidates = index + 1 < prepare.endpointCandidates.length;
        try {
            const manifestHasher = createTransferManifestHasher();
            const { requestUrl, authorizationHeader } = extractDirectPeerRequestAuth(candidate);
            const openHeaders = {
                'x-happier-transfer-recipient-public-key': recipientKeyPair.recipientPublicKeyBase64,
                ...(authorizationHeader ? { authorization: authorizationHeader } : {}),
            };

            const openJson = await runtimeFetchJsonWithDirectTransferTimeout(
                buildDirectExportEndpoint(requestUrl, 'open'),
                {
                    method: 'POST',
                    headers: openHeaders,
                    credentials: 'same-origin',
                },
                {
                    timeoutMs: requestTimeoutMs,
                    maxBodyBytes: DIRECT_TRANSFER_OPEN_RESPONSE_MAX_BYTES,
                    signal: params.signal ?? null,
                },
            );
            if (
                !isDirectTransferOpenResponse(openJson)
                || openJson.transferId !== prepare.transferId
                || (openJson.sizeBytes !== undefined && openJson.sizeBytes !== preparedSizeBytes)
                || !isDirectTransferChunkCountConsistent(openJson.totalChunks, preparedSizeBytes)
            ) {
                throw new Error('Direct export open returned invalid metadata');
            }

            let writtenPlaintextBytes = 0;
            const download = await downloadInChunks({
                init: async () => ({
                    success: true as const,
                    downloadId: prepare.transferId,
                    chunkSizeBytes: 1,
                    sizeBytes: prepare.sizeBytes,
                }),
                readChunk: async ({ index }) => {
                    const chunkJson = await runtimeFetchJsonWithDirectTransferTimeout(
                        buildDirectExportEndpoint(requestUrl, 'chunks', index),
                        {
                            method: 'GET',
                            headers: {
                                'x-happier-transfer-recipient-public-key': recipientKeyPair.recipientPublicKeyBase64,
                                ...(authorizationHeader ? { authorization: authorizationHeader } : {}),
                            },
                            credentials: 'same-origin',
                        },
                        {
                            timeoutMs: requestTimeoutMs,
                            maxBodyBytes: DIRECT_TRANSFER_CHUNK_RESPONSE_MAX_BYTES,
                            signal: params.signal ?? null,
                        },
                    );
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
                    if (writtenPlaintextBytes + bytes.byteLength > preparedSizeBytes) {
                        throw new Error('Downloaded size exceeded expected size');
                    }
                    manifestHasher.update(bytes);
                    await params.destination.writeBytes(bytes);
                    writtenPlaintextBytes += bytes.byteLength;
                },
                onProgress: params.onProgress ?? null,
                signal: params.signal ?? null,
            });
            if (!download.ok) {
                if (params.signal?.aborted) {
                    return await returnCanceled();
                }
                if (hasMoreCandidates) {
                    await resetBulkTransferDestinationAfterCandidateFailure(params.destination);
                    const resetFailure = await initializeDestination();
                    if (resetFailure) {
                        await cleanupFailedDestination();
                        return { ok: false, error: resetFailure.error };
                    }
                    continue;
                }
                break;
            }

            const manifestHash = manifestHasher.digestManifestHash();
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
            if (params.signal?.aborted) {
                return await returnCanceled();
            }
            if (hasMoreCandidates) {
                await resetBulkTransferDestinationAfterCandidateFailure(params.destination);
                const resetFailure = await initializeDestination();
                if (resetFailure) {
                    await cleanupFailedDestination();
                    return { ok: false, error: resetFailure.error };
                }
                continue;
            }
            break;
        }
    }

    await cleanupFailedDestination();
    return { ok: false, error: 'Direct export download unavailable' };
}


export async function downloadBulkJsonPayloadViaDirectExport<TPayload>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    request: DirectTransferExportPrepareRequest;
    parsePayload: (value: unknown) => TPayload | null;
    timeoutMs?: number | null;
}>): Promise<DirectTransferJsonDownloadResponse<TPayload>> {
    const prepared = await prepareDirectTransferExport(params);
    if (!prepared.ok) {
        return {
            ok: false,
            error: prepared.error,
        };
    }
    const prepare = prepared.prepare;

    const jsonMaxBytes = resolveBulkTransferJsonMaxBytes(null);
    const recipientKeyPair = createTransferRecipientKeyPair();
    const requestTimeoutMs = resolveDirectTransferRequestTimeoutMs(params.timeoutMs);

    for (const candidate of prepare.endpointCandidates) {
        try {
            const { requestUrl, authorizationHeader } = extractDirectPeerRequestAuth(candidate);
            const headers = {
                'x-happier-transfer-recipient-public-key': recipientKeyPair.recipientPublicKeyBase64,
                ...(authorizationHeader ? { authorization: authorizationHeader } : {}),
            };

            const openJson = await runtimeFetchJsonWithDirectTransferTimeout(
                buildDirectExportEndpoint(requestUrl, 'open'),
                {
                    method: 'POST',
                    headers,
                    credentials: 'same-origin',
                },
                {
                    timeoutMs: requestTimeoutMs,
                    maxBodyBytes: DIRECT_TRANSFER_OPEN_RESPONSE_MAX_BYTES,
                },
            );
            if (!isDirectTransferOpenResponse(openJson) || openJson.transferId !== prepare.transferId) {
                throw new Error('Direct export open returned invalid metadata');
            }
            if (openJson.sizeBytes !== undefined && openJson.sizeBytes > jsonMaxBytes) {
                return { ok: false, error: `Downloaded JSON payload exceeds max allowed bytes (${jsonMaxBytes})` };
            }
            const aggregateSizeBound = openJson.sizeBytes ?? jsonMaxBytes;
            if (!isDirectTransferChunkCountConsistent(openJson.totalChunks, aggregateSizeBound)) {
                throw new Error('Direct export open returned invalid metadata');
            }

            const chunks: Uint8Array[] = [];
            let totalBytes = 0;
            for (let sequence = 0; sequence < openJson.totalChunks; sequence += 1) {
                const chunkJson = await runtimeFetchJsonWithDirectTransferTimeout(
                        buildDirectExportEndpoint(requestUrl, 'chunks', sequence),
                        {
                            method: 'GET',
                            headers: {
                                'x-happier-transfer-recipient-public-key': recipientKeyPair.recipientPublicKeyBase64,
                                ...(authorizationHeader ? { authorization: authorizationHeader } : {}),
                            },
                            credentials: 'same-origin',
                        },
                        {
                            timeoutMs: requestTimeoutMs,
                            maxBodyBytes: DIRECT_TRANSFER_CHUNK_RESPONSE_MAX_BYTES,
                        },
                );
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
                const nextTotalBytes = totalBytes + chunk.byteLength;
                if (nextTotalBytes > jsonMaxBytes) {
                    return { ok: false, error: `Downloaded JSON payload exceeds max allowed bytes (${jsonMaxBytes})` };
                }
                if (nextTotalBytes > aggregateSizeBound) {
                    throw new Error('Direct export payload exceeded its declared size');
                }
                totalBytes = nextTotalBytes;
                chunks.push(chunk);
            }
            if (openJson.sizeBytes !== undefined && totalBytes !== openJson.sizeBytes) {
                throw new Error('Direct export payload did not match its declared size');
            }

            const payloadBytes = new Uint8Array(totalBytes);
            let offset = 0;
            for (const chunk of chunks) {
                payloadBytes.set(chunk, offset);
                offset += chunk.byteLength;
            }

            const manifestHasher = createTransferManifestHasher();
            manifestHasher.update(payloadBytes);
            const manifestHash = manifestHasher.digestManifestHash();
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
