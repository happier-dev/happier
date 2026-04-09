import {
    normalizeDirectPeerTransferEndpointBaseUrl,
    TransferChunkEnvelopeSchema,
    type PromptRegistryConfiguredSourceV1,
    type TransferEndpointCandidate,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { type ChunkDownloadProgress, downloadInChunks } from './chunkTransferClient';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';
import { digest } from '@/platform/digest';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from './transferChunkEncryption';
import { cleanupBulkTransferDestination } from './cleanupBulkTransferDestination';
import { resolveBulkTransferJsonMaxBytes } from './resolveBulkTransferJsonMaxBytes';
import type { BulkTransferFileDestination } from './bulkTransferFileDestination';
import { mergeTransferChunks } from './mergeTransferChunks';

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

type DirectTransferPrepareResult =
    | Readonly<{
        ok: true;
        prepare: Extract<DirectTransferExportPrepareResponse, { success: true }>;
    }>
    | Readonly<{
        ok: false;
        error: string;
    }>;

const DEFAULT_DIRECT_TRANSFER_REQUEST_TIMEOUT_MS = 5_000;

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseOptionalPositiveInt(value: unknown): number | null {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return null;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return Math.floor(parsed);
}

function resolveDirectTransferRequestTimeoutMs(timeoutMs: number | null | undefined): number {
    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        return Math.floor(timeoutMs);
    }

    return (
        parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_REQUEST_TIMEOUT_MS)
        ?? DEFAULT_DIRECT_TRANSFER_REQUEST_TIMEOUT_MS
    );
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
}>): Promise<DirectTransferPrepareResult> {
    try {
        const requestTimeoutMs = resolveDirectTransferRequestTimeoutMs(params.timeoutMs);
        const prepare = await callGuardedMachineRpcWithPolicy<DirectTransferExportPrepareResponse, DirectTransferExportPrepareRequest>({
            machineId: params.machineId,
            ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
            timeoutMs: requestTimeoutMs,
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
            return {
                ok: false,
                error: 'Direct export prepare returned an unsupported response',
            };
        }
        if (prepare.endpointCandidates.length === 0) {
            return {
                ok: false,
                error: 'Direct export endpoints unavailable',
            };
        }

        return {
            ok: true,
            prepare,
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

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function computeManifestHash(payload: Uint8Array): Promise<string> {
    const payloadCopy = new Uint8Array(new ArrayBuffer(payload.byteLength));
    payloadCopy.set(payload);
    const digestBytes = await digest('SHA-256', payloadCopy);
    return `sha256:${bytesToHex(digestBytes)}`;
}

async function resetBulkTransferDestinationAfterCandidateFailure(destination: BulkTransferFileDestination): Promise<void> {
    if (destination.cleanup) {
        await destination.cleanup();
    }
}

function createTimedAbortSignal(params: Readonly<{
    timeoutMs: number;
    signal?: AbortSignal | null;
}>): Readonly<{
    signal: AbortSignal;
    cleanup: () => void;
}> {
    const controller = new AbortController();
    const abortFromParent = () => {
        controller.abort(params.signal?.reason);
    };

    if (params.signal) {
        if (params.signal.aborted) {
            controller.abort(params.signal.reason);
        } else {
            params.signal.addEventListener('abort', abortFromParent, { once: true });
        }
    }

    const timeoutId = setTimeout(() => {
        controller.abort(new Error('Direct export request timed out'));
    }, params.timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeoutId);
            params.signal?.removeEventListener('abort', abortFromParent);
        },
    };
}

async function runtimeFetchWithDirectTransferTimeout(
    url: string,
    init: RequestInit,
    params: Readonly<{
        timeoutMs: number;
        signal?: AbortSignal | null;
    }>,
): Promise<Response> {
    const requestSignal = createTimedAbortSignal(params);
    try {
        return await runtimeFetch(url, {
            ...init,
            signal: requestSignal.signal,
        });
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

    if (params.onInit) {
        try {
            const sideEffect = await params.onInit({ name: prepare.name, sizeBytes: prepare.sizeBytes });
            if (sideEffect && sideEffect.success === false) {
                await cleanupFailedDestination();
                return { ok: false, error: sideEffect.error };
            }
        } catch (error) {
            await cleanupFailedDestination();
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Direct export download unavailable',
            };
        }
    }

    const recipientKeyPair = createTransferRecipientKeyPair();
    const requestTimeoutMs = resolveDirectTransferRequestTimeoutMs(params.timeoutMs);

    for (const [index, candidate] of prepare.endpointCandidates.entries()) {
        const hasMoreCandidates = index + 1 < prepare.endpointCandidates.length;
        try {
            const streamedChunks: Uint8Array[] = [];
            const { requestUrl, authorizationHeader } = extractDirectPeerRequestAuth(candidate);
            const openHeaders = {
                'x-happier-transfer-recipient-public-key': recipientKeyPair.recipientPublicKeyBase64,
                ...(authorizationHeader ? { authorization: authorizationHeader } : {}),
            };

            const openResponse = await runtimeFetchWithDirectTransferTimeout(
                buildDirectExportEndpoint(requestUrl, 'open'),
                {
                    method: 'POST',
                    headers: openHeaders,
                    credentials: 'same-origin',
                },
                {
                    timeoutMs: requestTimeoutMs,
                    signal: params.signal ?? null,
                },
            );
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
                    const chunkResponse = await runtimeFetchWithDirectTransferTimeout(
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
                            signal: params.signal ?? null,
                        },
                    );
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
                if (hasMoreCandidates) {
                    await resetBulkTransferDestinationAfterCandidateFailure(params.destination);
                    continue;
                }
                break;
            }

            const manifestHash = await computeManifestHash(mergeTransferChunks(streamedChunks));
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
            if (hasMoreCandidates) {
                await resetBulkTransferDestinationAfterCandidateFailure(params.destination);
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

            const openResponse = await runtimeFetchWithDirectTransferTimeout(
                buildDirectExportEndpoint(requestUrl, 'open'),
                {
                    method: 'POST',
                    headers,
                    credentials: 'same-origin',
                },
                {
                    timeoutMs: requestTimeoutMs,
                },
            );
            const openJson = await openResponse.json();
            if (!isDirectTransferOpenResponse(openJson) || openJson.transferId !== prepare.transferId) {
                throw new Error('Direct export open returned invalid metadata');
            }

            const chunks: Uint8Array[] = [];
            let totalBytes = 0;
            for (let sequence = 0; sequence < openJson.totalChunks; sequence += 1) {
                const chunkResponse = await runtimeFetchWithDirectTransferTimeout(
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
                    },
                );
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
