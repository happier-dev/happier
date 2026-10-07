import { WorkspaceRefV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { WorkspaceSyncRelationshipCreateActionInputV1Schema, WorkspaceSyncRelationshipCreateRpcRequestV1Schema, type WorkspaceSyncRelationshipCreateActionInputV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { HandoffTargetReplacementApprovalV1 } from '@happier-dev/protocol/sessions/control/handoff/handoffTargetReplacementApprovalV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { getStorage } from '@/sync/domains/state/storageStore';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

/**
 * Transport for direct Project linking, kept free of the Action executor so the
 * executor can depend on it without a cycle.
 *
 * Linking runs on the machine that hosts the selected source Workspace. Its
 * address is resolved from current Account settings here and re-checked by the
 * daemon before any file is touched; a caller never names a machine or a root.
 * The admitted Action input travels verbatim so the target replays exactly the
 * bytes the approving artifact stored.
 */
export async function createWorkspaceSyncRelationshipOnController(
    request: Readonly<{
        input: WorkspaceSyncRelationshipCreateActionInputV1;
        operationId: string;
        serverId?: string | null;
        targetReplacementApproval?: HandoffTargetReplacementApprovalV1;
        targetReplacementApprovalReceiptId?: string;
        signal?: AbortSignal;
    }>,
): Promise<unknown> {
    const input = WorkspaceSyncRelationshipCreateActionInputV1Schema.parse(request.input);
    const settings = getStorage().getState().settings as Readonly<Record<string, unknown>> | null;
    const refs = WorkspaceRefV1Schema.array().safeParse(settings?.workspaceRefsV1 ?? []);
    // An ambiguous reference is refused rather than resolved by first match: the
    // daemon would otherwise link a Workspace the person did not select.
    const matches = refs.success
        ? refs.data.filter((ref) => ref.id === input.sourceWorkspaceRefId)
        : [];
    const source = matches.length === 1 ? matches[0]! : null;
    if (!source) {
        throw Object.assign(new Error('workspace_ref_not_ready'), { code: 'workspace_ref_not_ready' });
    }
    return await machineRpcWithServerScope<unknown, unknown>({
        machineId: source.machineId,
        serverId: request.serverId ?? source.serverId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE,
        payload: WorkspaceSyncRelationshipCreateRpcRequestV1Schema.parse({
            v: 1,
            operationId: request.operationId,
            actionInput: input,
            ...(request.targetReplacementApproval && request.targetReplacementApprovalReceiptId
                ? {
                    targetReplacementApproval: request.targetReplacementApproval,
                    targetReplacementApprovalReceiptId: request.targetReplacementApprovalReceiptId,
                }
                : {}),
        }),
        ...(request.signal ? { signal: request.signal } : {}),
    });
}
