import { machineRpcWithServerScope } from './serverScopedMachineRpc';
import { resolveMachineRpcTargetServerId } from './resolveMachineRpcTargetServerId';
import {
    isGuardedMachineRpcMethod,
    resolveTransferPolicyAllowsMachineRpcDirect,
} from './guardedMachineRpcPolicy';

export { isGuardedMachineRpcMethod, resolveTransferPolicyAllowsMachineRpcDirect } from './guardedMachineRpcPolicy';

export async function callGuardedMachineRpcWithPolicy<R, A>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    accountId?: string | null;
    method: string;
    payload: A;
    timeoutMs?: number;
    operationTimeoutMs?: null;
    signal?: AbortSignal;
    preferScoped?: boolean;
}>): Promise<R> {
    const targetServerId = resolveMachineRpcTargetServerId(params.serverId);
    const guarded = isGuardedMachineRpcMethod(params.method);
    const allowDirect = guarded
        ? await resolveTransferPolicyAllowsMachineRpcDirect({ serverId: targetServerId })
        : true;
    const preferScoped = params.preferScoped === true || (guarded && !allowDirect);

    return await machineRpcWithServerScope<R, A>({
        machineId: params.machineId,
        serverId: targetServerId,
        accountId: params.accountId ?? undefined,
        method: params.method,
        payload: params.payload,
        timeoutMs: params.timeoutMs,
        ...(params.operationTimeoutMs === null ? { operationTimeoutMs: null } : {}),
        signal: params.signal,
        skipTransferPolicyEvaluation: guarded,
        ...(preferScoped ? { preferScoped: true } : null),
    });
}
