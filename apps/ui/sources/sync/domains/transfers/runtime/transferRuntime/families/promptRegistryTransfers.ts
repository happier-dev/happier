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
    type PromptRegistryConfiguredSourceV1,
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

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

import { downloadJsonPayloadViaMachineTransferCarriers } from '../carriers/createJsonMachineRpcCarrierDownloads';
import { throwUnsupportedMachineTransferResponse } from '../carriers/throwUnsupportedMachineTransferResponse';
import { resolvePreferScopedMachineRpc } from '../routing/resolvePreferScopedMachineRpc';

type MachinePromptRegistriesTransferOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

export async function listDaemonPromptRegistryAdapters(
    machineId: string,
    opts?: MachinePromptRegistriesTransferOpts,
): Promise<PromptRegistryListAdaptersResponseV1> {
    const preferScoped = await resolvePreferScopedMachineRpc({
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
        throwUnsupportedMachineTransferResponse(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS);
    }
    return parsed.data;
}

export async function listDaemonPromptRegistrySources(
    machineId: string,
    input: PromptRegistryListSourcesRequestV1,
    opts?: MachinePromptRegistriesTransferOpts,
): Promise<PromptRegistryListSourcesResponseV1> {
    const payload = PromptRegistryListSourcesRequestV1Schema.parse(input);
    const preferScoped = await resolvePreferScopedMachineRpc({
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
        throwUnsupportedMachineTransferResponse(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES);
    }
    return parsed.data;
}

export async function scanDaemonPromptRegistrySource(
    machineId: string,
    input: PromptRegistryScanSourceRequestV1,
    opts?: MachinePromptRegistriesTransferOpts,
): Promise<PromptRegistryScanSourceResponseV1> {
    const payload = PromptRegistryScanSourceRequestV1Schema.parse(input);
    const preferScoped = await resolvePreferScopedMachineRpc({
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
        throwUnsupportedMachineTransferResponse(RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE);
    }
    return parsed.data;
}

export async function installDaemonPromptRegistryItem(
    machineId: string,
    input: PromptRegistryInstallRequestV1,
    opts?: MachinePromptRegistriesTransferOpts,
): Promise<PromptRegistryInstallResponseV1> {
    const payload = PromptRegistryInstallRequestV1Schema.parse(input);
    const preferScoped = await resolvePreferScopedMachineRpc({
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
        throwUnsupportedMachineTransferResponse(RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL);
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

function parsePromptRegistryTransferPayload(
    value: unknown,
): PromptRegistryFetchedItemV1 | null {
    const parsed = PromptRegistryFetchedItemV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export async function downloadDaemonPromptRegistryItem(
    machineId: string,
    input: PromptRegistryFetchItemRequestV1,
    opts?: MachinePromptRegistriesTransferOpts,
): Promise<DaemonPromptRegistryDownloadItemResponse> {
    const payload = PromptRegistryFetchItemRequestV1Schema.parse(input);
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
        initMethod: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT,
        chunkMethod: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_CHUNK,
        finalizeMethod: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_FINALIZE,
        abortMethod: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_ABORT,
        parsePayload: parsePromptRegistryTransferPayload,
        directExportRequest: {
            t: 'prompt_registry_download_v1',
            sourceId: payload.sourceId,
            itemId: payload.itemId,
            configuredSources: payload.configuredSources,
        },
    });

    return result.ok
        ? { ok: true, item: result.payload }
        : result;
}
