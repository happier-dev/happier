import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

/** Private lifecycle Actions use the operation's target, never the Session's source Machine. */
export function createUiSessionHandoffRecoveryActionDeps(
    machineRpc: typeof machineRpcWithServerScope,
    account: Readonly<{ serverId: string; accountId: string }> | null,
): Pick<ActionExecutorDeps, 'sessionHandoffStatusGet' | 'sessionHandoffPrepareTargetResume'> {
    const request = (method: string, payload: unknown, context: ActionExecutorContext): Promise<unknown> => {
        const target = context.externalActionTarget;
        if (!account || target?.kind !== 'machine') {
            return Promise.resolve({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });
        }
        return machineRpc({ machineId: target.machineId, serverId: account.serverId,
            accountId: account.accountId, method, payload, ...(context.signal ? { signal: context.signal } : {}) });
    };
    return {
        sessionHandoffStatusGet: (input, context) => request(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3, input, context),
        sessionHandoffPrepareTargetResume: (input, context) => request(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME_V3, input, context),
    };
}
