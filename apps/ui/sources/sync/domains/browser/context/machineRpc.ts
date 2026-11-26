import { isActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DaemonBrowserContextDispatchRequestV1Schema, DaemonBrowserContextDispatchResponseV1Schema, type BrowserContextRouteResultV1 } from '@happier-dev/protocol/browser/context/v1';
import type { RuntimeActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { projectMachineDaemonRpcFailure, projectMachineActionRpcFailure, type MachineDaemonRpcFailure } from '@/sync/domains/machines/machineDaemonRpcErrors';

export type BrowserContextMachineRpcFailureReason =
    | 'unavailable'
    | 'request_failed'
    | 'invalid_response';

export type BrowserContextDispatchClientInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    actionId: RuntimeActionIdV1;
    input: unknown;
    signal?: AbortSignal;
}>;

export type BrowserContextDispatchClientResult =
    | Readonly<{ ok: true; result: BrowserContextRouteResultV1 }>
    | (Readonly<{ ok: false; reason: BrowserContextMachineRpcFailureReason }> & Omit<MachineDaemonRpcFailure, 'reason'>);

export async function dispatchBrowserContextActionViaMachineRpc(
    input: BrowserContextDispatchClientInput,
): Promise<BrowserContextDispatchClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonBrowserContextDispatchRequestV1Schema.parse({
            machineId: input.machineId,
            actionId: input.actionId,
            input: input.input,
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH,
            payload,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        const failure = projectMachineActionRpcFailure(raw);
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, ...(isActionExecuteFailure(raw) ? failure : null), reason: 'unavailable' };
        }
        if (failure) return { ...failure, reason: 'request_failed' };
        const parsed = DaemonBrowserContextDispatchResponseV1Schema.safeParse(raw);
        return parsed.success
            ? { ok: true, result: parsed.data.result }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        const failure = projectMachineDaemonRpcFailure(error);
        return { ...failure, reason: failure.reason === 'older_happier' ? 'unavailable' : 'request_failed' };
    }
}
