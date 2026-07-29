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

import { uploadBulkPayloadFromFileViaDirectImport } from '../plumbing/directTransferImportUpload';
import {
    DIRECT_IMPORT_CLEANUP_FAILED_ERROR_CODE,
    isDirectImportTerminalFinalizeErrorCode,
} from '../plumbing/directTransferImportClient';
import { prepareBulkJsonPayloadForUpload, uploadBulkJsonPayload } from '../plumbing/uploadBulkJsonPayload';
import { downloadJsonPayloadViaMachineTransferCarriers } from '../carriers/createJsonMachineRpcCarrierDownloads';
import { throwUnsupportedMachineTransferResponse } from '../carriers/throwUnsupportedMachineTransferResponse';
import { resolvePreferScopedMachineRpc } from '../routing/resolvePreferScopedMachineRpc';
import {
    isTransferFinalizeRecoveryFailure,
    type TransferFinalizeRecoveryFailure,
} from '../plumbing/directTransferFinalizeRecovery';

type MachinePromptAssetsTransferOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
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

export async function listDaemonPromptAssetTypes(
    machineId: string,
    opts?: MachinePromptAssetsTransferOpts,
): Promise<PromptAssetListTypesResponseV1> {
    const preferScoped = await resolvePreferScopedMachineRpc({
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
        throwUnsupportedMachineTransferResponse(RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES);
    }
    return parsed.data;
}

export async function discoverDaemonPromptAssets(
    machineId: string,
    input: PromptAssetDiscoverRequest,
    opts?: MachinePromptAssetsTransferOpts,
): Promise<PromptAssetDiscoverResponseV1> {
    const payload = PromptAssetDiscoverRequestSchema.parse(input);
    const preferScoped = await resolvePreferScopedMachineRpc({
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
        throwUnsupportedMachineTransferResponse(RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER);
    }
    return parsed.data;
}

export async function deleteDaemonPromptAsset(
    machineId: string,
    input: PromptAssetDeleteRequest,
    opts?: MachinePromptAssetsTransferOpts,
): Promise<PromptAssetMutationResponseV1> {
    const payload = PromptAssetDeleteRequestSchema.parse(input);
    const preferScoped = await resolvePreferScopedMachineRpc({
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
        throwUnsupportedMachineTransferResponse(RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE);
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
        errorCode?: string;
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
    const preferScoped = await resolvePreferScopedMachineRpc({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? null,
    });
    const result = await downloadJsonPayloadViaMachineTransferCarriers({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        preferScoped,
        payloadWithRecipient: (recipientPublicKeyBase64) => ({
            ...payload,
            recipientPublicKeyBase64,
        }),
        initMethod: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
        chunkMethod: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
        finalizeMethod: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
        abortMethod: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT,
        parsePayload: parsePromptAssetTransferPayload,
        directExportRequest: {
            t: 'prompt_asset_download_v1',
            assetTypeId: payload.assetTypeId,
            scope: payload.scope,
            externalRef: payload.externalRef,
        },
    });

    return result.ok
        ? { ok: true, item: result.payload }
        : result;
}

export async function uploadDaemonPromptAsset(
    machineId: string,
    input: PromptAssetWriteRequest,
    opts?: MachinePromptAssetsTransferOpts,
): Promise<
    PromptAssetMutationResponseV1
    | TransferFinalizeRecoveryFailure<PromptAssetMutationResponseV1>
> {
    const payload = PromptAssetWriteRequestSchema.parse(input);
    const preferScoped = await resolvePreferScopedMachineRpc({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? null,
    });
    const preparedPayload = prepareBulkJsonPayloadForUpload(payload);

    if (preparedPayload.ok) {
        const directImportResult = await uploadBulkPayloadFromFileViaDirectImport<PromptAssetMutationResponseV1>({
            machineId,
            serverId: opts?.serverId,
            fileReader: {
                sizeBytes: preparedPayload.encodedPayload.byteLength,
                readBytes: async (offset, length) => preparedPayload.encodedPayload.subarray(offset, offset + length),
                close: async () => {},
            },
            request: {
                t: 'prompt_asset_upload_v1',
                workingDirectory: '/',
                sizeBytes: preparedPayload.encodedPayload.byteLength,
            } as const,
            parseFinalizeResponse: (response) => {
                const parsed = PromptAssetMutationResponseV1Schema.safeParse(response.finalized.result);
                return parsed.success ? parsed.data : null;
            },
            timeoutMs: opts?.timeoutMs ?? null,
        });

        if ('ok' in directImportResult) {
            return directImportResult;
        }
        if (isTransferFinalizeRecoveryFailure<PromptAssetMutationResponseV1>(directImportResult)) {
            return directImportResult;
        }
        if (
            directImportResult.errorCode === DIRECT_IMPORT_CLEANUP_FAILED_ERROR_CODE
            || isDirectImportTerminalFinalizeErrorCode(directImportResult.errorCode)
        ) {
            return {
                ok: false,
                errorCode: 'internal_error',
                error: directImportResult.error,
            };
        }
    }

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
        throwUnsupportedMachineTransferResponse(RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE);
    }

    return result.response;
}
