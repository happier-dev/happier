import {
    PromptAssetDeleteRequestSchema,
    PromptAssetDiscoverRequestSchema,
    PromptAssetDiscoverResponseV1Schema,
    PromptAssetListTypesResponseV1Schema,
    PromptAssetMutationResponseV1Schema,
    PromptAssetReadRequestSchema,
    PromptAssetReadResponseV1Schema,
    PromptAssetWriteRequestSchema,
    type PromptAssetDeleteRequest,
    type PromptAssetDiscoverRequest,
    type PromptAssetDiscoverResponseV1,
    type PromptAssetListTypesResponseV1,
    type PromptAssetMutationResponseV1,
    type PromptAssetReadRequest,
    type PromptAssetReadResponseV1,
    type PromptAssetWriteRequest,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { assertRpcResponseWithSuccess } from '@/sync/runtime/assertRpcResponseWithSuccess';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

import { downloadBulkJsonPayload } from './downloadBulkJsonPayload';
import { uploadBulkJsonPayload } from './uploadBulkJsonPayload';
import { resolvePreferScopedForBulkMachineTransfer } from './resolvePreferScopedForBulkMachineTransfer';

type MachinePromptAssetsTransferOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

type PromptAssetDownloadInitResponse =
    | Readonly<{
        success: true;
        downloadId: string;
        chunkSizeBytes: number;
        sizeBytes: number;
        name: string;
    }>
    | Readonly<{
        success: false;
        error: string;
        errorCode?: string;
    }>;

type PromptAssetDownloadChunkResponse =
    | Readonly<{
        success: true;
        payloadBase64?: string;
        encryptedDataKeyEnvelopeBase64?: string;
        contentBase64?: string;
        isLast: boolean;
    }>
    | Readonly<{
        success: false;
        error: string;
        errorCode?: string;
    }>;

type PromptAssetDownloadFinalizeResponse = Readonly<{
    success: boolean;
    error?: string;
    errorCode?: string;
}>;

type PromptAssetUploadInitResponse =
    | Readonly<{
        success: true;
        uploadId: string;
        chunkSizeBytes: number;
        recipientPublicKeyBase64: string;
    }>
    | Readonly<{
        success: false;
        error: string;
        errorCode?: string;
    }>;

type PromptAssetUploadChunkResponse =
    | Readonly<{
        success: true;
    }>
    | Readonly<{
        success: false;
        error: string;
        errorCode?: string;
    }>;

type PromptAssetUploadFinalizeResponse =
    | Readonly<{
        success: true;
        response?: unknown;
    }>
    | Readonly<{
        success: false;
        error: string;
        errorCode?: string;
    }>;

function throwUnsupportedResponse(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}

export async function listDaemonPromptAssetTypes(
    machineId: string,
    opts?: MachinePromptAssetsTransferOpts,
): Promise<PromptAssetListTypesResponseV1> {
    const preferScoped = await resolvePreferScopedForBulkMachineTransfer({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? null,
    });
    const response = await machineRpcWithServerScope<unknown, undefined>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES,
        preferScoped,
        payload: undefined,
    });
    const parsed = PromptAssetListTypesResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES);
    }
    return parsed.data;
}

export async function discoverDaemonPromptAssets(
    machineId: string,
    input: PromptAssetDiscoverRequest,
    opts?: MachinePromptAssetsTransferOpts,
): Promise<PromptAssetDiscoverResponseV1> {
    const payload = PromptAssetDiscoverRequestSchema.parse(input);
    const preferScoped = await resolvePreferScopedForBulkMachineTransfer({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? null,
    });
    const response = await machineRpcWithServerScope<unknown, PromptAssetDiscoverRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER,
        preferScoped,
        payload,
    });
    const parsed = PromptAssetDiscoverResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER);
    }
    return parsed.data;
}

export async function deleteDaemonPromptAsset(
    machineId: string,
    input: PromptAssetDeleteRequest,
    opts?: MachinePromptAssetsTransferOpts,
): Promise<PromptAssetMutationResponseV1> {
    const payload = PromptAssetDeleteRequestSchema.parse(input);
    const preferScoped = await resolvePreferScopedForBulkMachineTransfer({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? null,
    });
    const response = await machineRpcWithServerScope<unknown, PromptAssetDeleteRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE,
        preferScoped,
        payload,
    });
    const parsed = PromptAssetMutationResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE);
    }
    return parsed.data;
}

export type DaemonPromptAssetDownloadResponse =
    | Readonly<{
        ok: true;
        item: Extract<PromptAssetReadResponseV1, { ok: true }>['item'];
    }>
    | Readonly<{
        ok: false;
        error: string;
    }>;

function parsePromptAssetTransferPayload(
    value: unknown,
): Extract<PromptAssetReadResponseV1, { ok: true }>['item'] | null {
    const parsed = PromptAssetReadResponseV1Schema.safeParse({
        ok: true,
        item: value,
    });
    return parsed.success && parsed.data.ok ? parsed.data.item : null;
}

export async function downloadDaemonPromptAsset(
    machineId: string,
    input: PromptAssetReadRequest,
    opts?: MachinePromptAssetsTransferOpts,
): Promise<DaemonPromptAssetDownloadResponse> {
    const payload = PromptAssetReadRequestSchema.parse(input);
    const preferScoped = await resolvePreferScopedForBulkMachineTransfer({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? null,
    });

    const result = await downloadBulkJsonPayload({
        init: async (request): Promise<PromptAssetDownloadInitResponse> => await assertRpcResponseWithSuccess<PromptAssetDownloadInitResponse>(
            await machineRpcWithServerScope<
                PromptAssetDownloadInitResponse,
                PromptAssetReadRequest & Readonly<{ recipientPublicKeyBase64: string }>
            >({
                machineId,
                serverId: opts?.serverId,
                timeoutMs: opts?.timeoutMs ?? undefined,
                method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
                preferScoped,
                payload: {
                    ...payload,
                    recipientPublicKeyBase64: request.recipientPublicKeyBase64,
                },
            }),
        ),
        readChunk: async (request): Promise<PromptAssetDownloadChunkResponse> => await assertRpcResponseWithSuccess<PromptAssetDownloadChunkResponse>(
            await machineRpcWithServerScope<PromptAssetDownloadChunkResponse, Readonly<{ downloadId: string; index: number }>>({
                machineId,
                serverId: opts?.serverId,
                timeoutMs: opts?.timeoutMs ?? undefined,
                method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
                preferScoped,
                payload: request,
            }),
        ),
        finalize: async (request): Promise<PromptAssetDownloadFinalizeResponse> => await assertRpcResponseWithSuccess<PromptAssetDownloadFinalizeResponse>(
            await machineRpcWithServerScope<PromptAssetDownloadFinalizeResponse, Readonly<{ downloadId: string }>>({
                machineId,
                serverId: opts?.serverId,
                timeoutMs: opts?.timeoutMs ?? undefined,
                method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
                preferScoped,
                payload: request,
            }),
        ),
        parsePayload: parsePromptAssetTransferPayload,
    });

    if (!result.ok) {
        return result;
    }

    return {
        ok: true,
        item: result.payload,
    };
}

export async function uploadDaemonPromptAsset(
    machineId: string,
    input: PromptAssetWriteRequest,
    opts?: MachinePromptAssetsTransferOpts,
): Promise<PromptAssetMutationResponseV1> {
    const payload = PromptAssetWriteRequestSchema.parse(input);
    const preferScoped = await resolvePreferScopedForBulkMachineTransfer({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? null,
    });

    const result = await uploadBulkJsonPayload<PromptAssetUploadFinalizeResponse, PromptAssetMutationResponseV1>({
        payload,
        init: async (request): Promise<PromptAssetUploadInitResponse> => await assertRpcResponseWithSuccess<PromptAssetUploadInitResponse>(
            await machineRpcWithServerScope<PromptAssetUploadInitResponse, Readonly<{ sizeBytes: number }>>({
                machineId,
                serverId: opts?.serverId,
                timeoutMs: opts?.timeoutMs ?? undefined,
                method: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT,
                preferScoped,
                payload: request,
            }),
        ),
        sendChunk: async (request): Promise<PromptAssetUploadChunkResponse> => await assertRpcResponseWithSuccess<PromptAssetUploadChunkResponse>(
            await machineRpcWithServerScope<
                PromptAssetUploadChunkResponse,
                Readonly<{
                    uploadId: string;
                    index: number;
                    payloadBase64: string;
                    encryptedDataKeyEnvelopeBase64: string;
                }>
            >({
                machineId,
                serverId: opts?.serverId,
                timeoutMs: opts?.timeoutMs ?? undefined,
                method: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_CHUNK,
                preferScoped,
                payload: request,
            }),
        ),
        finalize: async (request): Promise<PromptAssetUploadFinalizeResponse> => await assertRpcResponseWithSuccess<PromptAssetUploadFinalizeResponse>(
            await machineRpcWithServerScope<PromptAssetUploadFinalizeResponse, Readonly<{ uploadId: string }>>({
                machineId,
                serverId: opts?.serverId,
                timeoutMs: opts?.timeoutMs ?? undefined,
                method: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE,
                preferScoped,
                payload: request,
            }),
        ),
        parseResponse: (value) => {
            const parsed = PromptAssetMutationResponseV1Schema.safeParse(
                (value as { response?: unknown } | null)?.response,
            );
            return parsed.success ? parsed.data : null;
        },
    });

    if (!result.ok) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE);
    }

    return result.response;
}
