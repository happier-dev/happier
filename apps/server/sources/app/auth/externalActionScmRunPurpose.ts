import { isScmDiffSummaryRunAction } from '@happier-dev/protocol/actions/actionSpecs';
import type { ExternalActionExecutionAuthorizationBindingV1, ExternalActionMachineRpcExecutionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ExternalActionMachineRpcEventV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

/** The installed SCM owner starts its analysis under the original requester's root. */
export function isScmRunStartRpcPurpose(
    binding: ExternalActionExecutionAuthorizationBindingV1,
    execution: ExternalActionMachineRpcExecutionV1,
    request: Readonly<{ method: string; event?: ExternalActionMachineRpcEventV1 }>,
): boolean {
    const separator = request.method.indexOf(':');
    // Home cannot open E2EE params. The existing installation signature binds
    // the method and ciphertext; the Run receiver validates the opened request.
    return isScmDiffSummaryRunAction(binding.actionId)
        && execution.effectActionId === 'execution.run.start'
        && separator > 0 && request.method.slice(separator + 1) === SESSION_RPC_METHODS.EXECUTION_RUN_START
        && (request.event === undefined || request.event === SOCKET_RPC_EVENTS.CALL);
}
