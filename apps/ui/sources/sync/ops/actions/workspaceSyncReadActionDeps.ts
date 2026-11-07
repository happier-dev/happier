import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { WorkspaceSyncConflictInspectRpcResultV1Schema, WorkspaceSyncConflictPageV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { resolveWorkspaceSyncReadControllerV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';

import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { assertWorkspaceSyncRpcSuccess } from '@/sync/ops/workspaceSync';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Subordinate read delivery for the admitted Actions; explicit controllers need no graph fetch. */
export function createUiWorkspaceSyncReadActionDeps(account?: LazyActionAccountContext): Pick<ActionExecutorDeps,
    'workspaceSyncConflictsList' | 'workspaceSyncConflictInspect'> {
    async function read(controllerMachineId: string, method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
        if (!account) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
        account.assertCurrent();
        const result = await machineRpcWithServerScope({ serverId: account.serverId, accountId: account.accountId,
            machineId: controllerMachineId, method, payload, ...(signal ? { signal } : {}) });
        account.assertCurrent();
        assertWorkspaceSyncRpcSuccess(result);
        return result;
    }
    return {
        workspaceSyncConflictsList: async ({ input, signal }) => WorkspaceSyncConflictPageV1Schema.parse(await read(
            input.controllerMachineId, RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST,
            { relationshipId: input.relationshipId, limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) }, signal,
        )),
        workspaceSyncConflictInspect: async ({ input, signal }) => {
            let controllerMachineId = input.controllerMachineId;
            if (!controllerMachineId) {
                if (!account) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
                const rows = await createUiProjectAccountRowsClient(account).read(signal);
                if (rows.status !== 'ready' || rows.coverage !== 'complete') {
                    throw Object.assign(new Error('workspace_ref_not_ready'), { code: 'workspace_ref_not_ready' });
                }
                controllerMachineId = resolveWorkspaceSyncReadControllerV1({ ...input, serverId: account.serverId,
                    workspaceRefs: rows.workspaceRefs, relationships: rows.relationships, context: workspaceRefResolutionContextV1() });
            }
            return WorkspaceSyncConflictInspectRpcResultV1Schema.parse(await read(controllerMachineId,
                RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT, { workspaceRefId: input.workspaceRefId,
                    path: input.path, ...(input.preview ? { preview: input.preview } : {}) }, signal));
        },
    };
}
