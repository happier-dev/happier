import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';

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
            kind: 'http';
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
    }>;

export type DirectTransferImportChunkResponse =
    | Readonly<{ success: true }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

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

async function readJsonResponse<T>(response: Response): Promise<T> {
    return await response.json() as T;
}

function buildDirectImportEndpoint(baseUrl: string, suffix: 'chunks' | 'finalize' | 'abort', sequence?: number): string {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname}/${suffix}${typeof sequence === 'number' ? `/${sequence}` : ''}`;
    return url.toString();
}

function validateDirectImportEndpointCandidate(candidateUrl: string): string {
    const parsed = new URL(candidateUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Invalid direct import endpoint candidate');
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    if (segments.length !== 4 || segments[0] !== 'machine-transfers' || segments[1] !== 'direct' || segments[2] !== 'imports' || segments[3].length === 0) {
        throw new Error('Invalid direct import endpoint candidate');
    }
    return parsed.toString();
}

export async function prepareDirectImportSession(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    request: DirectTransferImportOpenRequest;
    preferScoped?: boolean;
}>): Promise<
    | Readonly<{ success: true; session: PreparedDirectImportSession }>
    | Readonly<{ success: false; error: string; errorCode?: string }>
> {
    const prepare = await callGuardedMachineRpcWithPolicy<DirectTransferImportPrepareResponse, DirectTransferImportOpenRequest>({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        ...(typeof params.preferScoped === 'boolean' ? { preferScoped: params.preferScoped } : {}),
        method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
        payload: params.request,
    });

    if (prepare.success !== true) {
        return prepare;
    }
    if (!isDirectTransferImportPrepareSuccess(prepare)) {
        return { success: false, error: 'Direct import prepare returned an unsupported response' };
    }

    const uploadId = prepare.uploadId.trim();
    const chunkSizeBytes = Math.floor(prepare.chunkSizeBytes);
    const recipientPublicKeyBase64 = prepare.recipientPublicKeyBase64.trim();
    if (!uploadId || chunkSizeBytes <= 0 || !recipientPublicKeyBase64) {
        return { success: false, error: 'Direct import prepare returned invalid session metadata' };
    }

    const baseUrls: string[] = [];
    for (const candidate of prepare.endpointCandidates) {
        if (candidate.kind !== 'http') {
            continue;
        }

        try {
            baseUrls.push(validateDirectImportEndpointCandidate(candidate.url));
        } catch {
            continue;
        }
    }

    if (baseUrls.length === 0) {
        return { success: false, error: 'Direct import endpoints unavailable' };
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

async function putJson<T>(url: string, input: Readonly<{ body: unknown }>): Promise<T> {
    const response = await runtimeFetch(url, {
        method: 'PUT',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify(input.body),
        credentials: 'same-origin',
    });
    return await readJsonResponse<T>(response);
}

export async function sendDirectImportChunk(params: Readonly<{
    baseUrl: string;
    index: number;
    payloadBase64: string;
    encryptedDataKeyEnvelopeBase64: string;
}>): Promise<DirectTransferImportChunkResponse> {
    return await putJson<DirectTransferImportChunkResponse>(
        buildDirectImportEndpoint(params.baseUrl, 'chunks', params.index),
        {
            body: {
                payloadBase64: params.payloadBase64,
                encryptedDataKeyEnvelopeBase64: params.encryptedDataKeyEnvelopeBase64,
            },
        },
    );
}

export async function finalizeDirectImportSession(baseUrl: string): Promise<DirectTransferImportFinalizeResponse> {
    return await readJsonResponse<DirectTransferImportFinalizeResponse>(
        await runtimeFetch(buildDirectImportEndpoint(baseUrl, 'finalize'), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            credentials: 'same-origin',
        }),
    );
}

export async function abortDirectImportSession(baseUrl: string): Promise<void> {
    await runtimeFetch(buildDirectImportEndpoint(baseUrl, 'abort'), {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        credentials: 'same-origin',
    });
}
