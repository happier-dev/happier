import {
    type PromptAssetDiscoverRequest,
    type PromptAssetDiscoverResponseV1,
    type PromptAssetListTypesResponseV1,
    type PromptAssetDeleteRequest,
    type PromptAssetMutationResponseV1,
    type PromptAssetReadRequest,
    type PromptAssetReadResponseV1,
    type PromptAssetWriteRequest,
} from '@happier-dev/protocol';

import {
    deleteDaemonPromptAsset,
    discoverDaemonPromptAssets,
    downloadDaemonPromptAsset,
    listDaemonPromptAssetTypes,
    uploadDaemonPromptAsset,
} from '@/sync/domains/transfers/runtime/bulkTransferPipeline';

type MachinePromptAssetsOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

export async function machinePromptAssetsListTypes(
    machineId: string,
    opts?: MachinePromptAssetsOpts,
): Promise<PromptAssetListTypesResponseV1> {
    return await listDaemonPromptAssetTypes(machineId, opts);
}

export async function machinePromptAssetsDiscover(
    machineId: string,
    input: PromptAssetDiscoverRequest,
    opts?: MachinePromptAssetsOpts,
): Promise<PromptAssetDiscoverResponseV1> {
    return await discoverDaemonPromptAssets(machineId, input, opts);
}

export type MachinePromptAssetDownloadResponse =
    | Readonly<{
        ok: true;
        item: Extract<PromptAssetReadResponseV1, { ok: true }>['item'];
    }>
    | Readonly<{
        ok: false;
        error: string;
    }>;

export async function machinePromptAssetsDownload(
    machineId: string,
    input: PromptAssetReadRequest,
    opts?: MachinePromptAssetsOpts,
): Promise<MachinePromptAssetDownloadResponse> {
    const result = await downloadDaemonPromptAsset(machineId, input, opts);
    if (!result.ok) return result;
    return { ok: true, item: result.item };
}

export async function machinePromptAssetsWrite(
    machineId: string,
    input: PromptAssetWriteRequest,
    opts?: MachinePromptAssetsOpts,
): Promise<PromptAssetMutationResponseV1> {
    return await uploadDaemonPromptAsset(machineId, input, opts);
}

export async function machinePromptAssetsDelete(
    machineId: string,
    input: PromptAssetDeleteRequest,
    opts?: MachinePromptAssetsOpts,
): Promise<PromptAssetMutationResponseV1> {
    return await deleteDaemonPromptAsset(machineId, input, opts);
}
