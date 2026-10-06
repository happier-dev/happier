import {
    isSafeDirectTransferEndpointCandidate,
    normalizeDirectPeerTransferEndpointBaseUrl,
    TransferChunkEnvelopeSchema,
    TransferEndpointCandidateSchema,
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
import {
    DirectTransferHttpStatusError,
    DirectTransferRequestTimeoutError,
    isRetryableDirectTransferEndpointError,
} from './directTransferEndpointRetry';
import {
    MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR,
    MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE,
    rebaseMachineCarrierHttpEndpoint,
    type MachineCarrierHttpLease,
    type MachineCarrierHttpRequester,
} from './machineCarrierHttpLease';

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
        confinedToWorkingDirectory?: boolean;
    }>
    | Readonly<{
        t: 'composer_media_stage_inspect_v1';
        sessionId?: string;
        handle: import('@happier-dev/protocol').ComposerContentHandleV1;
        offset: number;
        maxBytes: number;
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
    | Readonly<{ ok: false; error: string; errorCode?: string }>;

export type DirectTransferFileDownloadResponse =
    | Readonly<{ ok: true; name: string; sizeBytes: number }>
    | Readonly<{ ok: false; error: string; errorCode?: string }>;

type DirectTransferFailureResponse = Readonly<{
    success: false;
    error: string;
    errorCode?: string;
}>;

type DirectTransferPrepareResult =
    | Readonly<{
        ok: true;
        prepare: Extract<DirectTransferExportPrepareResponse, { success: true }>;
        releaseExport: () => Promise<void>;
    }>
    | Readonly<{
        ok: false;
        error: string;
        errorCode?: string;
    }>;

const DIRECT_TRANSFER_OPEN_RESPONSE_MAX_BYTES = 8 * 1024;
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
        && totalChunks <= Math.max(1, maxPlaintextBytes);
}

function toDirectTransferExportPrepareFailure(error: unknown): Readonly<{
    ok: false;
    error: string;
    errorCode?: string;
}> {
    return {
        ok: false,
        error: error instanceof Error ? error.message : 'Direct export unavailable',
        ...(error && typeof error === 'object'
            && (error as { errorCode?: unknown }).errorCode === MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE
            ? { errorCode: MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE }
            : {}),
    };
}

async function releasePreparedDirectTransferExport(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    transferId: string;
    timeoutMs?: number | null;
}>): Promise<void> {
    try {
        await callGuardedMachineRpcWithPolicy({
            machineId: params.machineId,
            ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
            timeoutMs: resolveDirectTransferRequestTimeoutMs(params.timeoutMs),
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE,
            payload: { transferId: params.transferId },
        });
    } catch {
        // Older daemons do not expose the release operation. The publication
        // TTL remains the bounded crash/version-skew recovery path.
    }
}

async function prepareDirectTransferExport(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    request: DirectTransferExportPrepareRequest;
    timeoutMs?: number | null;
    signal?: AbortSignal | null;
}>): Promise<DirectTransferPrepareResult> {
    let preparedTransferId: string | null = null;
    let publicationCustodyTransferred = false;
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
        if (typeof prepare.transferId === 'string' && prepare.transferId.length > 0) {
            preparedTransferId = prepare.transferId;
        }
        if (!isDirectTransferExportPrepareSuccess(prepare)) {
            return {
                ok: false,
                error: 'Direct export prepare returned an unsupported response',
            };
        }
        const endpointCandidates: TransferEndpointCandidate[] = [];
        for (const candidate of prepare.endpointCandidates) {
            const parsedCandidate = TransferEndpointCandidateSchema.safeParse(candidate);
            if (!parsedCandidate.success) {
                continue;
            }
            endpointCandidates.push(parsedCandidate.data);
        }
        if (endpointCandidates.length === 0) {
            return { ok: false, error: 'Direct export endpoints unavailable' };
        }

        const result: DirectTransferPrepareResult = {
            ok: true,
            prepare: {
                ...prepare,
                endpointCandidates,
            },
            releaseExport: async () => await releasePreparedDirectTransferExport({
                machineId: params.machineId,
                serverId: params.serverId,
                transferId: prepare.transferId,
                timeoutMs: params.timeoutMs,
            }),
        };
        publicationCustodyTransferred = true;
        return result;
    } catch (error) {
        return toDirectTransferExportPrepareFailure(error);
    } finally {
        if (preparedTransferId && !publicationCustodyTransferred) {
            await releasePreparedDirectTransferExport({
                machineId: params.machineId,
                serverId: params.serverId,
                transferId: preparedTransferId,
                timeoutMs: params.timeoutMs,
            });
        }
    }
}

type DirectTransferCarrierRouteResult =
    | Readonly<{
        ok: true;
        endpointCandidates: readonly TransferEndpointCandidate[];
        request?: MachineCarrierHttpRequester;
        releaseCarrier?: (() => Promise<void> | void) | null;
    }>
    | Readonly<{ ok: false; error: string; errorCode?: string }>;

async function acquirePreparedDirectTransferRoute(params: Readonly<{
    prepare: Extract<DirectTransferExportPrepareResponse, { success: true }>;
    httpOriginOverride?: string | null;
    acquirePreparedCarrier?: ((prepared: Readonly<{ operationId: string }>) => Promise<MachineCarrierHttpLease | null>) | null;
}>): Promise<DirectTransferCarrierRouteResult> {
    let carrier: MachineCarrierHttpLease | null = null;
    try {
        let effectiveOrigin = params.httpOriginOverride ?? null;
        if (params.acquirePreparedCarrier) {
            if (typeof params.prepare.sizeBytes !== 'number' || !Number.isSafeInteger(params.prepare.sizeBytes) || params.prepare.sizeBytes < 0) {
                return { ok: false, error: 'Direct export prepare returned no bounded size' };
            }
            carrier = await params.acquirePreparedCarrier({ operationId: params.prepare.transferId });
            if (carrier?.kind === 'native_http') effectiveOrigin = carrier.localOrigin;
        }

        const endpointCandidates: TransferEndpointCandidate[] = [];
        for (const candidate of params.prepare.endpointCandidates) {
            try {
                const effectiveCandidate = effectiveOrigin
                    ? { ...candidate, url: rebaseMachineCarrierHttpEndpoint(candidate.url, effectiveOrigin) }
                    : candidate;
                if (isSafeDirectTransferEndpointCandidate(effectiveCandidate)) endpointCandidates.push(effectiveCandidate);
            } catch {
                continue;
            }
        }
        if (endpointCandidates.length === 0) {
            if (carrier) await Promise.resolve(carrier.release()).catch(() => undefined);
            return carrier
                ? {
                    ok: false,
                    error: MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR,
                    errorCode: MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE,
                }
                : { ok: false, error: 'Direct export endpoints unavailable' };
        }
        return {
            ok: true,
            endpointCandidates,
            ...(carrier?.kind === 'browser_stream' ? { request: carrier.request } : {}),
            ...(carrier ? { releaseCarrier: carrier.release } : {}),
        };
    } catch (error) {
        if (carrier) await Promise.resolve(carrier.release()).catch(() => undefined);
        return toDirectTransferExportPrepareFailure(error);
    }
}

function extractDirectPeerRequestAuth(candidate: TransferEndpointCandidate, preserveQuery: boolean): Readonly<{
    requestUrl: string;
    authorizationHeader?: string;
}> {
    const authorizationToken = typeof candidate.authorizationToken === 'string'
        ? candidate.authorizationToken.trim()
        : '';
    const normalizedRequestUrl = normalizeDirectPeerTransferEndpointBaseUrl(candidate.url);
    const requestUrl = preserveQuery
        ? `${normalizedRequestUrl}${new URL(candidate.url).search}`
        : normalizedRequestUrl;
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
        request?: MachineCarrierHttpRequester;
    }>,
): Promise<unknown> {
    const requestSignal = createDirectTransferRequestAbortSignal(params);
    try {
        const response = await (params.request ?? runtimeFetch)(url, {
            ...init,
            signal: requestSignal.signal,
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new DirectTransferHttpStatusError(response.status);
        }
        const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
        if (contentType !== 'application/json') {
            await response.body?.cancel().catch(() => undefined);
            throw new Error('Direct export response returned an unsupported content type');
        }
        const body = await readBoundedResponseBody({
            response,
            maxBytes: params.maxBodyBytes,
            signal: requestSignal.signal,
        });
        const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
        return JSON.parse(text) as unknown;
    } catch (error) {
        if (!params.signal?.aborted && requestSignal.signal.aborted) {
            throw new DirectTransferRequestTimeoutError(error);
        }
        throw error;
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
    httpOriginOverride?: string | null;
    acquirePreparedCarrier?: ((prepared: Readonly<{ operationId: string }>) => Promise<MachineCarrierHttpLease | null>) | null;
}>): Promise<DirectTransferFileDownloadResponse> {
    async function cleanupFailedDestination(originalError?: unknown): Promise<void> {
        if (params.cleanupOnFailure === false) {
            return;
        }
        await cleanupBulkTransferDestination(params.destination, originalError);
    }

    async function returnCanceled(): Promise<DirectTransferFileDownloadResponse> {
        await cleanupFailedDestination(new Error('Download canceled'));
        return { ok: false, error: 'Download canceled' };
    }

    if (params.signal?.aborted) {
        return await returnCanceled();
    }

    const prepared = await prepareDirectTransferExport(params);
    if (!prepared.ok) {
        await cleanupFailedDestination(new Error(prepared.error));
        return {
            ok: false,
            error: prepared.error,
            ...(prepared.errorCode ? { errorCode: prepared.errorCode } : {}),
        };
    }
    const prepare = prepared.prepare;
    let carrierRoute: Extract<DirectTransferCarrierRouteResult, { ok: true }> | null = null;
    try {
    if (typeof prepare.name !== 'string' || typeof prepare.sizeBytes !== 'number' || !Number.isFinite(prepare.sizeBytes) || prepare.sizeBytes < 0) {
        await cleanupFailedDestination(new Error('Direct export prepare returned invalid file metadata'));
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
        await cleanupFailedDestination(new Error(initialDestinationFailure.error));
        return { ok: false, error: initialDestinationFailure.error };
    }
    if (params.signal?.aborted) {
        return await returnCanceled();
    }

    const recipientKeyPair = createTransferRecipientKeyPair();
    const requestTimeoutMs = resolveDirectTransferRequestTimeoutMs(params.timeoutMs);
    const acquiredRoute = await acquirePreparedDirectTransferRoute({
        prepare,
        ...(params.httpOriginOverride === undefined ? {} : { httpOriginOverride: params.httpOriginOverride }),
        ...(params.acquirePreparedCarrier === undefined ? {} : { acquirePreparedCarrier: params.acquirePreparedCarrier }),
    });
    if (!acquiredRoute.ok) {
        await cleanupFailedDestination(new Error(acquiredRoute.error));
        return {
            ok: false,
            error: acquiredRoute.error,
            ...(acquiredRoute.errorCode ? { errorCode: acquiredRoute.errorCode } : {}),
        };
    }
    carrierRoute = acquiredRoute;
    const carrierRequest = carrierRoute.request;

    let completed: Extract<DirectTransferFileDownloadResponse, { ok: true }> | null = null;
    for (const [index, candidate] of carrierRoute.endpointCandidates.entries()) {
        const hasMoreCandidates = index + 1 < carrierRoute.endpointCandidates.length;
        try {
            const manifestHasher = createTransferManifestHasher();
            const { requestUrl, authorizationHeader } = extractDirectPeerRequestAuth(candidate, Boolean(params.httpOriginOverride || carrierRoute.releaseCarrier));
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
                    request: carrierRoute.request,
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
                            request: carrierRequest,
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
                break;
            }

            const manifestHash = manifestHasher.digestManifestHash();
            if (manifestHash !== openJson.manifestHash) {
                throw new Error('Direct export file manifest mismatch');
            }

            completed = {
                ok: true,
                name: prepare.name,
                sizeBytes: download.sizeBytes,
            };
            break;
        } catch (error) {
            if (params.signal?.aborted) {
                return await returnCanceled();
            }
            if (hasMoreCandidates && isRetryableDirectTransferEndpointError(error)) {
                await resetBulkTransferDestinationAfterCandidateFailure(params.destination);
                const resetFailure = await initializeDestination();
                if (resetFailure) {
                    await cleanupFailedDestination(new Error(resetFailure.error));
                    return { ok: false, error: resetFailure.error };
                }
                continue;
            }
            break;
        }
    }

    if (completed) {
        try {
            await params.destination.close();
        } catch (error) {
            await cleanupFailedDestination(error);
            throw error;
        }
        return completed;
    }

    await cleanupFailedDestination(new Error(carrierRoute?.releaseCarrier && !params.signal?.aborted
        ? MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR
        : 'Direct export download unavailable'));
    return carrierRoute?.releaseCarrier && !params.signal?.aborted
        ? {
            ok: false,
            error: MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR,
            errorCode: MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE,
        }
        : { ok: false, error: 'Direct export download unavailable' };
    } finally {
        await prepared.releaseExport();
        await Promise.resolve(carrierRoute?.releaseCarrier?.()).catch(() => undefined);
    }
}


export async function downloadBulkJsonPayloadViaDirectExport<TPayload>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    request: DirectTransferExportPrepareRequest;
    parsePayload: (value: unknown) => TPayload | null;
    timeoutMs?: number | null;
    signal?: AbortSignal | null;
    httpOriginOverride?: string | null;
    acquirePreparedCarrier?: ((prepared: Readonly<{ operationId: string }>) => Promise<MachineCarrierHttpLease | null>) | null;
}>): Promise<DirectTransferJsonDownloadResponse<TPayload>> {
    const prepared = await prepareDirectTransferExport(params);
    if (!prepared.ok) {
        return {
            ok: false,
            error: prepared.error,
            ...(prepared.errorCode ? { errorCode: prepared.errorCode } : {}),
        };
    }
    const prepare = prepared.prepare;
    let carrierRoute: Extract<DirectTransferCarrierRouteResult, { ok: true }> | null = null;
    try {

    const jsonMaxBytes = resolveBulkTransferJsonMaxBytes(null);
    const recipientKeyPair = createTransferRecipientKeyPair();
    const requestTimeoutMs = resolveDirectTransferRequestTimeoutMs(params.timeoutMs);
    const acquiredRoute = await acquirePreparedDirectTransferRoute({
        prepare,
        ...(params.httpOriginOverride === undefined ? {} : { httpOriginOverride: params.httpOriginOverride }),
        ...(params.acquirePreparedCarrier === undefined ? {} : { acquirePreparedCarrier: params.acquirePreparedCarrier }),
    });
    if (!acquiredRoute.ok) {
        return {
            ok: false,
            error: acquiredRoute.error,
            ...(acquiredRoute.errorCode ? { errorCode: acquiredRoute.errorCode } : {}),
        };
    }
    carrierRoute = acquiredRoute;

    for (const [index, candidate] of carrierRoute.endpointCandidates.entries()) {
        const hasMoreCandidates = index + 1 < carrierRoute.endpointCandidates.length;
        try {
            const { requestUrl, authorizationHeader } = extractDirectPeerRequestAuth(candidate, Boolean(params.httpOriginOverride || carrierRoute.releaseCarrier));
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
                    signal: params.signal ?? null,
                    request: carrierRoute.request,
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
                            signal: params.signal ?? null,
                            request: carrierRoute.request,
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
        } catch (error) {
            if (params.signal?.aborted || !hasMoreCandidates || !isRetryableDirectTransferEndpointError(error)) {
                break;
            }
        }
    }

    return carrierRoute?.releaseCarrier && !params.signal?.aborted
        ? {
            ok: false,
            error: MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR,
            errorCode: MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE,
        }
        : { ok: false, error: 'Direct export download unavailable' };
    } finally {
        await prepared.releaseExport();
        await Promise.resolve(carrierRoute?.releaseCarrier?.()).catch(() => undefined);
    }
}
