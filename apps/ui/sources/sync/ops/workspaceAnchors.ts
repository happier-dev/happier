import {
    WorkspaceAnchorsResolveRequestV1Schema,
    WorkspaceAnchorsResolveResponseV1Schema,
    type WorkspaceAnchorsResolveRequestV1,
    type WorkspaceAnchorsResolveResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type ResolveWorkspaceAnchorsInput = WorkspaceAnchorsResolveRequestV1 & Readonly<{
    machineId: string;
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

export async function resolveWorkspaceAnchors(
    input: ResolveWorkspaceAnchorsInput,
): Promise<WorkspaceAnchorsResolveResponseV1> {
    const { machineId, serverId, timeoutMs, ...request } = input;
    const payload = WorkspaceAnchorsResolveRequestV1Schema.parse(request);

    const response = await machineRpcWithServerScope<unknown, WorkspaceAnchorsResolveRequestV1>({
        machineId,
        serverId,
        timeoutMs: timeoutMs ?? undefined,
        method: RPC_METHODS.WORKSPACE_ANCHORS_RESOLVE,
        payload,
    });

    const parsed = WorkspaceAnchorsResolveResponseV1Schema.safeParse(response);
    if (!parsed.success) {
        return {
            success: false,
            errorCode: 'UNSUPPORTED_RESPONSE',
            error: 'Unsupported workspace anchor resolver response',
        };
    }
    return parsed.data;
}
