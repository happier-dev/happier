import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    DIRECT_TRANSFER_SESSION_EXPIRES_AT_HEADER,
    isSafeDirectTransferEndpointCandidate,
    normalizeDirectPeerImportEndpointBaseUrl,
    TransferEndpointCandidateSchema,
} from '@happier-dev/protocol';

import { readBoundedResponseBody } from '@/utils/system/readBoundedResponseBody';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';
import { resolveBulkTransferJsonMaxBytes } from './resolveBulkTransferJsonMaxBytes';
import {
    createDirectTransferRequestAbortSignal,
    resolveDirectTransferRequestTimeoutMs,
} from './directTransferRequestDeadline';

export type DirectTransferImportOpenRequest = Readonly<{
    workingDirectory: string;
    additionalAllowedWriteDirs?: readonly string[];
    sessionRpcTransferMaxBytes?: number | null;
}> & (
    | Readonly<{
        t: 'session_file_upload_v1';
        path: unknown;
        sizeBytes: unknown;
        overwrite: unknown;
        sha256?: unknown;
    }>
    | Readonly<{
        t: 'session_attachment_upload_v1';
        messageLocalId: unknown;
        fileName: unknown;
        sizeBytes: unknown;
        uploadLocation?: 'workspace' | 'os_temp';
        workspaceRootPath?: unknown;
        workspaceRelativeDir?: string;
        vcsIgnoreStrategy?: 'git_info_exclude' | 'gitignore' | 'none';
        vcsIgnoreWritesEnabled?: boolean;
    }>
    | Readonly<{
        t: 'prompt_asset_upload_v1';
        sizeBytes: unknown;
    }>
);

export type DirectTransferImportPrepareResponse =
    | Readonly<{
        success: true;
        uploadId: string;
        destDisplayPath: string;
        expectedSizeBytes: number;
        chunkSizeBytes: number;
        recipientPublicKeyBase64: string;
        expiresAt: number;
        endpointCandidates: readonly Readonly<{
            kind: 'http' | 'https';
            url: string;
            expiresAt: number;
        }>[];
    }>
    | Readonly<{
        success: false;
        error: string;
        errorCode?: string;
    }>;

export type DirectTransferImportFinalizeResponse =
    | Readonly<{
        success: true;
        finalized: Readonly<{
            success: true;
            path: string;
            sizeBytes: number;
            result?: unknown;
        }>;
        sha256: string;
    }>
    | Readonly<{
        success: false;
        error: string;
        errorCode?: string;
        keepSession?: boolean;
        expiresAt?: number;
    }>;

export type DirectTransferImportChunkResponse =
    | Readonly<{ success: true }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

type DirectTransferImportAbortResponse = Readonly<
    | { success: true; aborted?: boolean }
    | { success: false; error: string; errorCode?: string }
>;

export const DIRECT_IMPORT_CLEANUP_FAILED_ERROR_CODE = 'DIRECT_IMPORT_CLEANUP_FAILED';
export const DIRECT_IMPORT_PREPARE_INVALID_ERROR_CODE = 'DIRECT_IMPORT_PREPARE_INVALID';
export const DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE =
    'DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE';
export const DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE_ERROR_CODE =
    'DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE';
export const TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE =
    'TRANSFER_FINALIZE_RECOVERY_REQUIRED';

export function isDirectImportTerminalFinalizeErrorCode(errorCode: unknown): boolean {
    return errorCode === DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE
        || errorCode === DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE_ERROR_CODE
        || errorCode === TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE;
}

const DIRECT_IMPORT_CHUNK_RESPONSE_MAX_BYTES = 8 * 1024;
// Finalize can carry one prompt-asset mutation result whose path/ref originates
// in the bounded bulk JSON request. Keep that budget plus a small control envelope.
const DIRECT_IMPORT_FINALIZE_RESPONSE_ENVELOPE_MAX_BYTES = 8 * 1024;
// Recovery-required is an additive non-precommit response. Keep the status and
// exact body discriminator coupled so ordinary transient 5xx failures stay indeterminate.
const DIRECT_IMPORT_FINALIZE_RECOVERY_REQUIRED_STATUS = 500;

export type PreparedDirectImportSession = Readonly<{
    uploadId: string;
    destDisplayPath: string;
    expectedSizeBytes: number;
    chunkSizeBytes: number;
    recipientPublicKeyBase64: string;
    expiresAt: number;
    baseUrls: readonly string[];
}>;

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDirectTransferImportPrepareSuccess(value: unknown): value is Extract<DirectTransferImportPrepareResponse, { success: true }> {
    return isObject(value)
        && typeof value.uploadId === 'string'
        && typeof value.destDisplayPath === 'string'
        && typeof value.expectedSizeBytes === 'number'
        && typeof value.chunkSizeBytes === 'number'
        && typeof value.recipientPublicKeyBase64 === 'string'
        && typeof value.expiresAt === 'number'
        && Array.isArray(value.endpointCandidates);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
    const allowed = new Set(allowedKeys);
    return Object.keys(value).every((key) => allowed.has(key));
}

function isDirectTransferImportChunkResponse(value: unknown): value is DirectTransferImportChunkResponse {
    if (!isObject(value)) {
        return false;
    }
    if (value.success === true) {
        return hasOnlyKeys(value, ['success']);
    }
    return value.success === false
        && typeof value.error === 'string'
        && (value.errorCode === undefined || typeof value.errorCode === 'string')
        && hasOnlyKeys(value, ['success', 'error', 'errorCode']);
}

function isDirectTransferImportFinalizeResponse(value: unknown): value is DirectTransferImportFinalizeResponse {
    if (!isObject(value)) {
        return false;
    }
    if (value.success === false) {
        return typeof value.error === 'string'
            && (value.errorCode === undefined || typeof value.errorCode === 'string')
            && (value.keepSession === undefined || typeof value.keepSession === 'boolean')
            && hasOnlyKeys(value, ['success', 'error', 'errorCode', 'keepSession']);
    }
    if (value.success !== true || !isObject(value.finalized)) {
        return false;
    }
    return value.finalized.success === true
        && typeof value.finalized.path === 'string'
        && value.finalized.path.length > 0
        && Number.isSafeInteger(value.finalized.sizeBytes)
        && (value.finalized.sizeBytes as number) >= 0
        && hasOnlyKeys(value.finalized, ['success', 'path', 'sizeBytes', 'result'])
        && typeof value.sha256 === 'string'
        && value.sha256.length > 0
        && hasOnlyKeys(value, ['success', 'finalized', 'sha256']);
}

function isDirectTransferImportFinalizeRecoveryRequiredResponse(
    value: unknown,
): value is Extract<DirectTransferImportFinalizeResponse, { success: false }> & Readonly<{
    errorCode: typeof TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE;
    keepSession: true;
}> {
    return isDirectTransferImportFinalizeResponse(value)
        && value.success === false
        && value.error.length > 0
        && value.errorCode === TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE
        && value.keepSession === true;
}

async function cancelResponseBody(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
}

async function readJsonResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
    if (response.status !== 200) {
        await cancelResponseBody(response);
        throw new Error(`Direct import request failed with status ${response.status}`);
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
        await cancelResponseBody(response);
        throw new Error('Direct import response returned an unsupported content type');
    }
    const body = await readBoundedResponseBody({
        response,
        maxBytes,
        signal,
    });
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return JSON.parse(text) as unknown;
}

async function readFinalizeRecoveryRequiredResponse(
    response: Response,
    signal: AbortSignal,
): Promise<Extract<DirectTransferImportFinalizeResponse, { success: false }> | null> {
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
        await cancelResponseBody(response);
        return null;
    }
    try {
        const body = await readBoundedResponseBody({
            response,
            maxBytes: DIRECT_IMPORT_FINALIZE_RESPONSE_ENVELOPE_MAX_BYTES,
            signal,
        });
        const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
        const decoded = JSON.parse(text) as unknown;
        if (!isDirectTransferImportFinalizeRecoveryRequiredResponse(decoded)) {
            return null;
        }
        const expiresAtRaw = response.headers.get(DIRECT_TRANSFER_SESSION_EXPIRES_AT_HEADER);
        const expiresAt = expiresAtRaw === null ? Number.NaN : Number(expiresAtRaw);
        return Number.isSafeInteger(expiresAt) && expiresAt > 0
            ? { ...decoded, expiresAt }
            : decoded;
    } catch {
        return null;
    }
}

function buildDirectImportEndpoint(baseUrl: string, suffix: 'chunks' | 'finalize', sequence?: number): string {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname}/${suffix}${typeof sequence === 'number' ? `/${sequence}` : ''}`;
    return url.toString();
}

export async function abortPreparedDirectImportSessionViaMachineRpc(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    uploadId: string;
    timeoutMs?: number | null;
}>): Promise<Readonly<{ aborted: boolean | null }>> {
    const timeoutMs = resolveDirectTransferRequestTimeoutMs(params.timeoutMs);
    const cleanupRequestSignal = createDirectTransferRequestAbortSignal({ timeoutMs });
    try {
        const response = await callGuardedMachineRpcWithPolicy<
            DirectTransferImportAbortResponse,
            Readonly<{ uploadId: string }>
        >({
            machineId: params.machineId,
            ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
            payload: { uploadId: params.uploadId },
            timeoutMs,
            signal: cleanupRequestSignal.signal,
        });
        if (!isObject(response) || response.success !== true) {
            throw new Error(isObject(response) && typeof response.error === 'string'
                ? response.error
                : 'Direct import abort returned an unsupported response');
        }
        return {
            aborted: typeof response.aborted === 'boolean' ? response.aborted : null,
        };
    } finally {
        cleanupRequestSignal.cleanup();
    }
}

export type DirectImportPrepareFailure = Readonly<{
    success: false;
    error: string;
    errorCode?: string;
}>;

function createDirectImportCleanupFailure(error: unknown): DirectImportPrepareFailure {
    return {
        success: false,
        error: `Direct import cleanup failed: ${error instanceof Error ? error.message : 'abort request failed'}`,
        errorCode: DIRECT_IMPORT_CLEANUP_FAILED_ERROR_CODE,
    };
}

export async function abortOwnedDirectImportSession(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    uploadId: string;
    timeoutMs?: number | null;
}>): Promise<DirectImportPrepareFailure | null> {
    try {
        await abortPreparedDirectImportSessionViaMachineRpc(params);
        return null;
    } catch (error) {
        return createDirectImportCleanupFailure(error);
    }
}

export async function prepareDirectImportSession(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    request: DirectTransferImportOpenRequest;
    timeoutMs?: number | null;
    signal?: AbortSignal | null;
    preferScoped?: boolean;
}>): Promise<
    | Readonly<{ success: true; session: PreparedDirectImportSession }>
    | Readonly<{ success: false; error: string; errorCode?: string }>
> {
    const timeoutMs = resolveDirectTransferRequestTimeoutMs(params.timeoutMs);
    const prepare = await callGuardedMachineRpcWithPolicy<DirectTransferImportPrepareResponse, DirectTransferImportOpenRequest>({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        ...(typeof params.preferScoped === 'boolean' ? { preferScoped: params.preferScoped } : {}),
        method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
        payload: params.request,
        timeoutMs,
        ...(params.signal ? { signal: params.signal } : {}),
    });

    if (!isObject(prepare)) {
        return {
            success: false,
            error: 'Direct import prepare returned an unsupported response',
            errorCode: DIRECT_IMPORT_PREPARE_INVALID_ERROR_CODE,
        };
    }
    if (prepare.success !== true) {
        return typeof prepare.error === 'string'
            ? {
                success: false,
                error: prepare.error,
                ...(typeof prepare.errorCode === 'string' ? { errorCode: prepare.errorCode } : {}),
            }
            : {
                success: false,
                error: 'Direct import prepare returned an unsupported response',
                errorCode: DIRECT_IMPORT_PREPARE_INVALID_ERROR_CODE,
            };
    }

    const uploadId = typeof prepare.uploadId === 'string' ? prepare.uploadId.trim() : '';
    const failOwnedSession = async (failure: DirectImportPrepareFailure): Promise<DirectImportPrepareFailure> => {
        if (!uploadId) {
            return failure;
        }
        return await abortOwnedDirectImportSession({
            machineId: params.machineId,
            ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
            uploadId,
            timeoutMs,
        }) ?? failure;
    };

    if (!isDirectTransferImportPrepareSuccess(prepare)) {
        return await failOwnedSession({
            success: false,
            error: 'Direct import prepare returned invalid session metadata',
            errorCode: DIRECT_IMPORT_PREPARE_INVALID_ERROR_CODE,
        });
    }

    const chunkSizeBytes = Math.floor(prepare.chunkSizeBytes);
    const recipientPublicKeyBase64 = prepare.recipientPublicKeyBase64.trim();
    if (!uploadId || chunkSizeBytes <= 0 || !recipientPublicKeyBase64) {
        return await failOwnedSession({
            success: false,
            error: 'Direct import prepare returned invalid session metadata',
            errorCode: DIRECT_IMPORT_PREPARE_INVALID_ERROR_CODE,
        });
    }

    const baseUrls: string[] = [];
    let hasMalformedEndpointCandidate = false;
    for (const candidate of prepare.endpointCandidates) {
        const parsedCandidate = TransferEndpointCandidateSchema.safeParse(candidate);
        if (!parsedCandidate.success) {
            hasMalformedEndpointCandidate = true;
            continue;
        }
        if (!isSafeDirectTransferEndpointCandidate(parsedCandidate.data)) {
            continue;
        }

        try {
            baseUrls.push(normalizeDirectPeerImportEndpointBaseUrl(parsedCandidate.data.url));
        } catch {
            hasMalformedEndpointCandidate = true;
            continue;
        }
    }

    if (baseUrls.length === 0) {
        return await failOwnedSession(hasMalformedEndpointCandidate
            ? {
                success: false,
                error: 'Direct import prepare returned invalid endpoint metadata',
                errorCode: DIRECT_IMPORT_PREPARE_INVALID_ERROR_CODE,
            }
            : { success: false, error: 'Direct import endpoints unavailable' });
    }

    return {
        success: true,
        session: {
            uploadId,
            destDisplayPath: prepare.destDisplayPath,
            expectedSizeBytes: prepare.expectedSizeBytes,
            chunkSizeBytes,
            recipientPublicKeyBase64,
            expiresAt: prepare.expiresAt,
            baseUrls,
        },
    };
}

async function putJson(url: string, input: Readonly<{
    body: unknown;
    maxResponseBytes: number;
    timeoutMs: number;
    signal?: AbortSignal | null;
}>): Promise<unknown> {
    const requestSignal = createDirectTransferRequestAbortSignal(input);
    try {
        const response = await runtimeFetch(url, {
            method: 'PUT',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify(input.body),
            credentials: 'same-origin',
            signal: requestSignal.signal,
        });
        return await readJsonResponse(response, input.maxResponseBytes, requestSignal.signal);
    } finally {
        requestSignal.cleanup();
    }
}

export async function sendDirectImportChunk(params: Readonly<{
    baseUrl: string;
    index: number;
    payloadBase64: string;
    encryptedDataKeyEnvelopeBase64: string;
    timeoutMs?: number | null;
    signal?: AbortSignal | null;
}>): Promise<DirectTransferImportChunkResponse> {
    const response = await putJson(
        buildDirectImportEndpoint(params.baseUrl, 'chunks', params.index),
        {
            body: {
                payloadBase64: params.payloadBase64,
                encryptedDataKeyEnvelopeBase64: params.encryptedDataKeyEnvelopeBase64,
            },
            maxResponseBytes: DIRECT_IMPORT_CHUNK_RESPONSE_MAX_BYTES,
            timeoutMs: resolveDirectTransferRequestTimeoutMs(params.timeoutMs),
            signal: params.signal ?? null,
        },
    );
    if (!isDirectTransferImportChunkResponse(response)) {
        throw new Error('Direct import chunk returned an unsupported response');
    }
    return response;
}

function createRemoteCommittedResultUnusableFailure(): Extract<
    DirectTransferImportFinalizeResponse,
    { success: false }
> {
    return {
        success: false,
        error: 'Direct import finalize committed but returned an unusable result',
        errorCode: DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE,
    };
}

function createFinalizeOutcomeIndeterminateFailure(): Extract<
    DirectTransferImportFinalizeResponse,
    { success: false }
> {
    return {
        success: false,
        error: 'Direct import finalize outcome is indeterminate after request issuance',
        errorCode: DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE_ERROR_CODE,
    };
}

function isAuthoritativePreCommitFinalizeStatus(status: number): boolean {
    return status === 400 || status === 404 || status === 409;
}

export async function finalizeDirectImportSession(params: Readonly<{
    baseUrl: string;
    timeoutMs?: number | null;
    signal?: AbortSignal | null;
}>): Promise<DirectTransferImportFinalizeResponse> {
    const requestSignal = createDirectTransferRequestAbortSignal({
        timeoutMs: resolveDirectTransferRequestTimeoutMs(params.timeoutMs),
        signal: params.signal ?? null,
    });
    let finalizeRequestIssued = false;
    let authoritativePreCommitResponseObserved = false;
    let remoteFinalizeCommittedByServerContract = false;
    try {
        if (requestSignal.signal.aborted) {
            throw requestSignal.signal.reason;
        }
        const finalizeUrl = buildDirectImportEndpoint(params.baseUrl, 'finalize');
        finalizeRequestIssued = true;
        const response = await runtimeFetch(finalizeUrl, {
            method: 'POST',
            credentials: 'same-origin',
            signal: requestSignal.signal,
        });
        // The pinned direct-import handler awaits target finalization. 400/404/409
        // authoritatively precede commit, while 200 means finalization committed.
        // The additive retained-session recovery response is handled separately below.
        authoritativePreCommitResponseObserved = isAuthoritativePreCommitFinalizeStatus(response.status);
        remoteFinalizeCommittedByServerContract = response.status === 200;
        if (authoritativePreCommitResponseObserved) {
            await cancelResponseBody(response);
            throw new Error(`Direct import request failed with status ${response.status}`);
        }
        if (!remoteFinalizeCommittedByServerContract) {
            if (response.status === DIRECT_IMPORT_FINALIZE_RECOVERY_REQUIRED_STATUS) {
                const recoveryRequired = await readFinalizeRecoveryRequiredResponse(
                    response,
                    requestSignal.signal,
                );
                if (recoveryRequired) {
                    return recoveryRequired;
                }
            } else {
                await cancelResponseBody(response);
            }
            return createFinalizeOutcomeIndeterminateFailure();
        }
        const decoded = await readJsonResponse(
            response,
            resolveBulkTransferJsonMaxBytes(null) + DIRECT_IMPORT_FINALIZE_RESPONSE_ENVELOPE_MAX_BYTES,
            requestSignal.signal,
        );
        if (
            !isDirectTransferImportFinalizeResponse(decoded)
            || decoded.success !== true
        ) {
            if (remoteFinalizeCommittedByServerContract) {
                return createRemoteCommittedResultUnusableFailure();
            }
            throw new Error('Direct import finalize returned an unsupported response');
        }
        return decoded;
    } catch (error) {
        if (remoteFinalizeCommittedByServerContract) {
            return createRemoteCommittedResultUnusableFailure();
        }
        if (finalizeRequestIssued && !authoritativePreCommitResponseObserved) {
            return createFinalizeOutcomeIndeterminateFailure();
        }
        throw error;
    } finally {
        requestSignal.cleanup();
    }
}
