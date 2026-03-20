import {
    PromptAssetDeleteRequestSchema,
    PromptAssetDiscoverRequestSchema,
    PromptAssetDiscoverResponseV1Schema,
    PromptAssetListTypesResponseV1Schema,
    PromptAssetMutationResponseV1Schema,
    PromptAssetReadRequestSchema,
    PromptAssetReadResponseV1Schema,
    PromptAssetWriteRequestSchema,
    type PromptAssetDiscoverRequest,
    type PromptAssetDiscoverResponseV1,
    type PromptAssetListTypesResponseV1,
    type PromptAssetDeleteRequest,
    type PromptAssetMutationResponseV1,
    type PromptAssetReadRequest,
    type PromptAssetReadResponseV1,
    type PromptAssetWriteRequest,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { downloadMachineTransferJsonPayload } from '@/sync/domains/transfers/runtime/downloadMachineTransferJsonPayload';
import { uploadMachineTransferJsonPayload } from '@/sync/domains/transfers/runtime/uploadMachineTransferJsonPayload';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type MachinePromptAssetsOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

function throwUnsupportedResponse(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}

export async function machinePromptAssetsListTypes(
    machineId: string,
    opts?: MachinePromptAssetsOpts,
): Promise<PromptAssetListTypesResponseV1> {
    const response = await machineRpcWithServerScope<unknown, undefined>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES,
        payload: undefined,
    });
    const parsed = PromptAssetListTypesResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES);
    }
    return parsed.data;
}

export async function machinePromptAssetsDiscover(
    machineId: string,
    input: PromptAssetDiscoverRequest,
    opts?: MachinePromptAssetsOpts,
): Promise<PromptAssetDiscoverResponseV1> {
    const payload = PromptAssetDiscoverRequestSchema.parse(input);
    const response = await machineRpcWithServerScope<unknown, PromptAssetDiscoverRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER,
        payload,
    });
    const parsed = PromptAssetDiscoverResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER);
    }
    return parsed.data;
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

function parsePromptAssetTransferPayload(
    value: unknown,
): Extract<PromptAssetReadResponseV1, { ok: true }>['item'] | null {
    const parsed = PromptAssetReadResponseV1Schema.safeParse({
        ok: true,
        item: value,
    });
    return parsed.success && parsed.data.ok ? parsed.data.item : null;
}

export async function machinePromptAssetsDownload(
    machineId: string,
    input: PromptAssetReadRequest,
    opts?: MachinePromptAssetsOpts,
): Promise<MachinePromptAssetDownloadResponse> {
    const payload = PromptAssetReadRequestSchema.parse(input);
    const result = await downloadMachineTransferJsonPayload({
        machineId,
        serverId: opts?.serverId ?? undefined,
        timeoutMs: opts?.timeoutMs ?? undefined,
        request: payload,
        methods: {
            init: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
            chunk: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
            finalize: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
            abort: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT,
        },
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

export async function machinePromptAssetsWrite(
    machineId: string,
    input: PromptAssetWriteRequest,
    opts?: MachinePromptAssetsOpts,
): Promise<PromptAssetMutationResponseV1> {
    const payload = PromptAssetWriteRequestSchema.parse(input);
    const result = await uploadMachineTransferJsonPayload({
        machineId,
        serverId: opts?.serverId ?? undefined,
        timeoutMs: opts?.timeoutMs ?? undefined,
        payload,
        methods: {
            init: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT,
            chunk: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_CHUNK,
            finalize: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE,
            abort: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_ABORT,
        },
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

export async function machinePromptAssetsDelete(
    machineId: string,
    input: PromptAssetDeleteRequest,
    opts?: MachinePromptAssetsOpts,
): Promise<PromptAssetMutationResponseV1> {
    const payload = PromptAssetDeleteRequestSchema.parse(input);
    const response = await machineRpcWithServerScope<unknown, PromptAssetDeleteRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE,
        payload,
    });
    const parsed = PromptAssetMutationResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE);
    }
    return parsed.data;
}
