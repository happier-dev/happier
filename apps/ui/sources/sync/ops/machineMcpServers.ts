import {
    DaemonMcpServersDetectRequestSchema,
    DaemonMcpServersDetectResponseSchema,
    DaemonMcpServersPreviewRequestSchema,
    DaemonMcpServersPreviewResponseSchema,
    DaemonMcpServersTestRequestSchema,
    DaemonMcpServersTestResponseSchema,
    type DaemonMcpServersDetectRequest,
    type DaemonMcpServersDetectResponse,
    type DaemonMcpServersPreviewRequest,
    type DaemonMcpServersPreviewResponse,
    type DaemonMcpServersTestRequest,
    type DaemonMcpServersTestResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type MachineMcpServersOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

function throwUnsupportedResponse(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}

export async function machineMcpServersDetect(
    machineId: string,
    input: Omit<DaemonMcpServersDetectRequest, 'machineId'>,
    opts?: MachineMcpServersOpts,
): Promise<DaemonMcpServersDetectResponse> {
    const payload = DaemonMcpServersDetectRequestSchema.parse({ ...input, machineId });
    const response = await machineRpcWithServerScope<unknown, DaemonMcpServersDetectRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_MCP_SERVERS_DETECT,
        payload,
    });
    const parsed = DaemonMcpServersDetectResponseSchema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT);
    }
    return parsed.data;
}

export type MachineMcpServersTestInput =
    | Omit<Extract<DaemonMcpServersTestRequest, { t: 'draft' }>, 'machineId'>
    | Omit<Extract<DaemonMcpServersTestRequest, { t: 'byId' }>, 'machineId'>;

export async function machineMcpServersTest(
    machineId: string,
    input: MachineMcpServersTestInput,
    opts?: MachineMcpServersOpts,
): Promise<DaemonMcpServersTestResponse> {
    const payload = input.t === 'draft'
        ? DaemonMcpServersTestRequestSchema.parse({
            ...input,
            machineId,
        })
        : DaemonMcpServersTestRequestSchema.parse({
            ...input,
            machineId,
        });
    const response = await machineRpcWithServerScope<unknown, DaemonMcpServersTestRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_MCP_SERVERS_TEST,
        payload,
    });
    const parsed = DaemonMcpServersTestResponseSchema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_MCP_SERVERS_TEST);
    }
    return parsed.data;
}

export async function machineMcpServersPreview(
    machineId: string,
    input: Omit<DaemonMcpServersPreviewRequest, 'machineId'>,
    opts?: MachineMcpServersOpts,
): Promise<DaemonMcpServersPreviewResponse> {
    const payload = DaemonMcpServersPreviewRequestSchema.parse({ ...input, machineId });
    const response = await machineRpcWithServerScope<unknown, DaemonMcpServersPreviewRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW,
        payload,
    });
    const parsed = DaemonMcpServersPreviewResponseSchema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW);
    }
    return parsed.data;
}
