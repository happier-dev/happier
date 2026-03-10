import {
    PromptRegistryFetchItemRequestV1Schema,
    PromptRegistryFetchItemResponseV1Schema,
    PromptRegistryInstallRequestV1Schema,
    PromptRegistryInstallResponseV1Schema,
    PromptRegistryListAdaptersResponseV1Schema,
    PromptRegistryListSourcesRequestV1Schema,
    PromptRegistryListSourcesResponseV1Schema,
    PromptRegistryScanSourceRequestV1Schema,
    PromptRegistryScanSourceResponseV1Schema,
    type PromptRegistryFetchItemRequestV1,
    type PromptRegistryFetchItemResponseV1,
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

export async function machinePromptRegistriesFetchItem(
    machineId: string,
    input: PromptRegistryFetchItemRequestV1,
    opts?: MachinePromptRegistriesOpts,
): Promise<PromptRegistryFetchItemResponseV1> {
    const payload = PromptRegistryFetchItemRequestV1Schema.parse(input);
    const response = await machineRpcWithServerScope<unknown, PromptRegistryFetchItemRequestV1>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_PROMPT_REGISTRY_FETCH_ITEM,
        payload,
    });
    const parsed = PromptRegistryFetchItemResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_REGISTRY_FETCH_ITEM);
    }
    return parsed.data;
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
