import {
    PromptRegistryFetchItemRequestV1Schema,
    PromptRegistryFetchedItemV1Schema,
    PromptRegistryInstallRequestV1Schema,
    PromptRegistryInstallResponseV1Schema,
    PromptRegistryListAdaptersResponseV1Schema,
    PromptRegistryListSourcesRequestV1Schema,
    PromptRegistryListSourcesResponseV1Schema,
    PromptRegistryScanSourceRequestV1Schema,
    PromptRegistryScanSourceResponseV1Schema,
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
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { downloadBulkJsonPayload } from '@/sync/domains/transfers/runtime/bulkTransferPipeline';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type MachinePromptRegistriesOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

function throwUnsupportedResponse(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}

export async function machinePromptRegistriesListAdapters(
    machineId: string,
    opts?: MachinePromptRegistriesOpts,
): Promise<PromptRegistryListAdaptersResponseV1> {
    const response = await machineRpcWithServerScope<unknown, undefined>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS,
        payload: undefined,
    });
    const parsed = PromptRegistryListAdaptersResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS);
    }
    return parsed.data;
}

export async function machinePromptRegistriesListSources(
    machineId: string,
    input: PromptRegistryListSourcesRequestV1,
    opts?: MachinePromptRegistriesOpts,
): Promise<PromptRegistryListSourcesResponseV1> {
    const payload = PromptRegistryListSourcesRequestV1Schema.parse(input);
    const response = await machineRpcWithServerScope<unknown, PromptRegistryListSourcesRequestV1>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES,
        payload,
    });
    const parsed = PromptRegistryListSourcesResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES);
    }
    return parsed.data;
}

export async function machinePromptRegistriesScanSource(
    machineId: string,
    input: PromptRegistryScanSourceRequestV1,
    opts?: MachinePromptRegistriesOpts,
): Promise<PromptRegistryScanSourceResponseV1> {
    const payload = PromptRegistryScanSourceRequestV1Schema.parse(input);
    const response = await machineRpcWithServerScope<unknown, PromptRegistryScanSourceRequestV1>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE,
        payload,
    });
    const parsed = PromptRegistryScanSourceResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE);
    }
    return parsed.data;
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
    const payload = PromptRegistryFetchItemRequestV1Schema.parse(input);
    const result = await downloadBulkJsonPayload<PromptRegistryFetchedItemV1>({
        init: async (request) =>
            await machineRpcWithServerScope({
                machineId,
                serverId: opts?.serverId,
                timeoutMs: opts?.timeoutMs ?? undefined,
                method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT,
                payload: {
                    ...payload,
                    recipientPublicKeyBase64: request.recipientPublicKeyBase64,
                },
            }),
        readChunk: async (request) =>
            await machineRpcWithServerScope({
                machineId,
                serverId: opts?.serverId,
                timeoutMs: opts?.timeoutMs ?? undefined,
                method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_CHUNK,
                payload: request,
            }),
        finalize: async (request) =>
            await machineRpcWithServerScope({
                machineId,
                serverId: opts?.serverId,
                timeoutMs: opts?.timeoutMs ?? undefined,
                method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_FINALIZE,
                payload: request,
            }),
        parsePayload: (value) => {
            const parsed = PromptRegistryFetchedItemV1Schema.safeParse(value);
            return parsed.success ? parsed.data : null;
        },
    });

    if (!result.ok) {
        return result;
    }

    return {
        ok: true,
        item: result.payload,
    };
}

export async function machinePromptRegistriesInstall(
    machineId: string,
    input: PromptRegistryInstallRequestV1,
    opts?: MachinePromptRegistriesOpts,
): Promise<PromptRegistryInstallResponseV1> {
    const payload = PromptRegistryInstallRequestV1Schema.parse(input);
    const response = await machineRpcWithServerScope<unknown, PromptRegistryInstallRequestV1>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL,
        payload,
    });
    const parsed = PromptRegistryInstallResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL);
    }
    return parsed.data;
}
