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
} from '@happier-dev/protocol/prompts/library/promptAssetsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

import { prepareBulkJsonPayloadForUpload } from '../plumbing/prepareBulkJsonPayloadForUpload';
import { uploadBulkPayloadFromFileViaMachineCarrier } from '../plumbing/uploadBulkPayloadFromFileViaMachineCarrier';
import { downloadJsonPayloadViaMachineCarrier } from '../carriers/downloadJsonPayloadViaMachineCarrier';
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
    const result = await downloadJsonPayloadViaMachineCarrier({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
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
    const preparedPayload = prepareBulkJsonPayloadForUpload(payload);
    if (!preparedPayload.ok) {
        return { ok: false, errorCode: 'invalid_request', error: preparedPayload.error };
    }
    const result = await uploadBulkPayloadFromFileViaMachineCarrier<PromptAssetMutationResponseV1>({
        machineId,
        serverId: opts?.serverId,
        fileReader: {
            sizeBytes: preparedPayload.encodedPayload.byteLength,
            readBytes: async (offset, length) => preparedPayload.encodedPayload.subarray(offset, offset + length),
            close: async () => {},
        },
        directImportRequest: {
            t: 'prompt_asset_upload_v1',
            workingDirectory: '/',
            sizeBytes: preparedPayload.encodedPayload.byteLength,
        },
        parseDirectFinalizeResponse: (response) => {
            const parsed = PromptAssetMutationResponseV1Schema.safeParse(response.finalized.result);
            return parsed.success ? parsed.data : null;
        },
        timeoutMs: opts?.timeoutMs ?? null,
    });
    if ('ok' in result) return result;
    if (isTransferFinalizeRecoveryFailure<PromptAssetMutationResponseV1>(result)) return result;
    return { ok: false, errorCode: 'internal_error', error: result.error };
}
