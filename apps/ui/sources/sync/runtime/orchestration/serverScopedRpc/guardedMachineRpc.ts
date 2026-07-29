import { machineRpcWithServerScope } from './serverScopedMachineRpc';
import {
    isGuardedMachineRpcMethod,
    resolveTransferPolicyAllowsMachineRpcDirect,
} from './guardedMachineRpcPolicy';

export { isGuardedMachineRpcMethod, resolveTransferPolicyAllowsMachineRpcDirect } from './guardedMachineRpcPolicy';

export async function callGuardedMachineRpcWithPolicy<R, A>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    method: string;
    payload: A;
    timeoutMs?: number;
    signal?: AbortSignal;
    preferScoped?: boolean;
}>): Promise<R> {
    const guarded = isGuardedMachineRpcMethod(params.method);
    const allowDirect = guarded
        ? await resolveTransferPolicyAllowsMachineRpcDirect({ serverId: params.serverId ?? undefined })
        : true;
    const preferScoped = params.preferScoped === true || (guarded && !allowDirect);

    return await machineRpcWithServerScope<R, A>({
        machineId: params.machineId,
        serverId: params.serverId ?? undefined,
        method: params.method,
        payload: params.payload,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        skipTransferPolicyEvaluation: guarded,
        ...(preferScoped ? { preferScoped: true } : null),
    });
}
