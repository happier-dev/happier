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

import { assertRpcResponseWithSuccess } from '@/sync/runtime/assertRpcResponseWithSuccess';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

import { downloadBulkJsonPayload } from './downloadBulkJsonPayload';
import { resolvePreferScopedForBulkMachineTransfer } from './resolvePreferScopedForBulkMachineTransfer';

type MachinePromptRegistriesTransferOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

type PromptRegistryDownloadInitResponse =
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

type PromptRegistryDownloadChunkResponse =
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

type PromptRegistryDownloadFinalizeResponse = Readonly<{
    success: boolean;
    error?: string;
    errorCode?: string;
}>;

function throwUnsupportedResponse(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}

export async function listDaemonPromptRegistryAdapters(
    machineId: string,
    opts?: MachinePromptRegistriesTransferOpts,
): Promise<PromptRegistryListAdaptersResponseV1> {
    const preferScoped = await resolvePreferScopedForBulkMachineTransfer({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? null,
    });
    const response = await machineRpcWithServerScope<unknown, undefined>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS,
        preferScoped,
        payload: undefined,
    });

    const parsed = PromptRegistryListAdaptersResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS);
    }
    return parsed.data;
}

export async function listDaemonPromptRegistrySources(
    machineId: string,
    input: PromptRegistryListSourcesRequestV1,
    opts?: MachinePromptRegistriesTransferOpts,
): Promise<PromptRegistryListSourcesResponseV1> {
    const payload = PromptRegistryListSourcesRequestV1Schema.parse(input);
    const preferScoped = await resolvePreferScopedForBulkMachineTransfer({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? null,
    });
    const response = await machineRpcWithServerScope<unknown, PromptRegistryListSourcesRequestV1>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES,
        preferScoped,
        payload,
    });

    const parsed = PromptRegistryListSourcesResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES);
    }
    return parsed.data;
}

export async function scanDaemonPromptRegistrySource(
    machineId: string,
    input: PromptRegistryScanSourceRequestV1,
    opts?: MachinePromptRegistriesTransferOpts,
): Promise<PromptRegistryScanSourceResponseV1> {
    const payload = PromptRegistryScanSourceRequestV1Schema.parse(input);
    const preferScoped = await resolvePreferScopedForBulkMachineTransfer({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? null,
    });
    const response = await machineRpcWithServerScope<unknown, PromptRegistryScanSourceRequestV1>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE,
        preferScoped,
        payload,
    });

    const parsed = PromptRegistryScanSourceResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE);
    }
    return parsed.data;
}

export async function installDaemonPromptRegistryItem(
    machineId: string,
    input: PromptRegistryInstallRequestV1,
    opts?: MachinePromptRegistriesTransferOpts,
): Promise<PromptRegistryInstallResponseV1> {
    const payload = PromptRegistryInstallRequestV1Schema.parse(input);
    const preferScoped = await resolvePreferScopedForBulkMachineTransfer({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? null,
    });
    const response = await machineRpcWithServerScope<unknown, PromptRegistryInstallRequestV1>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL,
        preferScoped,
        payload,
    });

    const parsed = PromptRegistryInstallResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL);
    }
    return parsed.data;
}

export type DaemonPromptRegistryDownloadItemResponse =
    | Readonly<{
        ok: true;
        item: PromptRegistryFetchedItemV1;
    }>
    | Readonly<{
        ok: false;
        error: string;
    }>;

export async function downloadDaemonPromptRegistryItem(
    machineId: string,
    input: PromptRegistryFetchItemRequestV1,
    opts?: MachinePromptRegistriesTransferOpts,
): Promise<DaemonPromptRegistryDownloadItemResponse> {
    const payload = PromptRegistryFetchItemRequestV1Schema.parse(input);
    const preferScoped = await resolvePreferScopedForBulkMachineTransfer({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? null,
    });

    const result = await downloadBulkJsonPayload<PromptRegistryFetchedItemV1>({
        init: async (request): Promise<PromptRegistryDownloadInitResponse> => await assertRpcResponseWithSuccess<PromptRegistryDownloadInitResponse>(
            await machineRpcWithServerScope<
                PromptRegistryDownloadInitResponse,
                PromptRegistryFetchItemRequestV1 & Readonly<{ recipientPublicKeyBase64: string }>
            >({
                machineId,
                serverId: opts?.serverId,
                timeoutMs: opts?.timeoutMs ?? undefined,
                method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT,
                preferScoped,
                payload: {
                    ...payload,
                    recipientPublicKeyBase64: request.recipientPublicKeyBase64,
                },
            }),
        ),
        readChunk: async (request): Promise<PromptRegistryDownloadChunkResponse> => await assertRpcResponseWithSuccess<PromptRegistryDownloadChunkResponse>(
            await machineRpcWithServerScope<PromptRegistryDownloadChunkResponse, Readonly<{ downloadId: string; index: number }>>({
                machineId,
                serverId: opts?.serverId,
                timeoutMs: opts?.timeoutMs ?? undefined,
                method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_CHUNK,
                preferScoped,
                payload: request,
            }),
        ),
        finalize: async (request): Promise<PromptRegistryDownloadFinalizeResponse> => await assertRpcResponseWithSuccess<PromptRegistryDownloadFinalizeResponse>(
            await machineRpcWithServerScope<PromptRegistryDownloadFinalizeResponse, Readonly<{ downloadId: string }>>({
                machineId,
                serverId: opts?.serverId,
                timeoutMs: opts?.timeoutMs ?? undefined,
                method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_FINALIZE,
                preferScoped,
                payload: request,
            }),
        ),
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
