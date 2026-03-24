import {
    type PromptRegistryFetchItemRequestV1,
    type PromptRegistryFetchedItemV1,
    type PromptRegistryInstallRequestV1,
    type PromptRegistryInstallResponseV1,
    type PromptRegistryListAdaptersResponseV1,
    type PromptRegistryListSourcesRequestV1,
    type PromptRegistryListSourcesResponseV1,
    type PromptRegistryScanSourceRequestV1,
    type PromptRegistryScanSourceResponseV1,
} from '@happier-dev/protocol';

import {
    downloadDaemonPromptRegistryItem,
    installDaemonPromptRegistryItem,
    listDaemonPromptRegistryAdapters,
    listDaemonPromptRegistrySources,
    scanDaemonPromptRegistrySource,
} from '@/sync/domains/transfers/runtime/bulkTransferPipeline';

type MachinePromptRegistriesOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

export async function machinePromptRegistriesListAdapters(
    machineId: string,
    opts?: MachinePromptRegistriesOpts,
): Promise<PromptRegistryListAdaptersResponseV1> {
    return await listDaemonPromptRegistryAdapters(machineId, opts);
}

export async function machinePromptRegistriesListSources(
    machineId: string,
    input: PromptRegistryListSourcesRequestV1,
    opts?: MachinePromptRegistriesOpts,
): Promise<PromptRegistryListSourcesResponseV1> {
    return await listDaemonPromptRegistrySources(machineId, input, opts);
}

export async function machinePromptRegistriesScanSource(
    machineId: string,
    input: PromptRegistryScanSourceRequestV1,
    opts?: MachinePromptRegistriesOpts,
): Promise<PromptRegistryScanSourceResponseV1> {
    return await scanDaemonPromptRegistrySource(machineId, input, opts);
}

export type MachinePromptRegistryDownloadItemResponse =
    | Readonly<{
        ok: true;
        item: PromptRegistryFetchedItemV1;
    }>
    | Readonly<{
        ok: false;
        error: string;
    }>;

export async function machinePromptRegistriesDownloadItem(
    machineId: string,
    input: PromptRegistryFetchItemRequestV1,
    opts?: MachinePromptRegistriesOpts,
): Promise<MachinePromptRegistryDownloadItemResponse> {
    const result = await downloadDaemonPromptRegistryItem(machineId, input, opts);

    if (!result.ok) {
        return result;
    }

    return {
        ok: true,
        item: result.item,
    };
}

export async function machinePromptRegistriesInstall(
    machineId: string,
    input: PromptRegistryInstallRequestV1,
    opts?: MachinePromptRegistriesOpts,
): Promise<PromptRegistryInstallResponseV1> {
    return await installDaemonPromptRegistryItem(machineId, input, opts);
}
