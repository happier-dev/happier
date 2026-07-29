import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';

export async function requireTerminalRuntimeLaunch<TParams, TResult>(
    backendId?: string | null,
): Promise<(params: TParams) => Promise<TResult>> {
    const terminalRuntimeOps = (await getSessionHostBridge().resolveExecutionSurfaces(backendId)).terminalRuntime;
    if (!terminalRuntimeOps?.launch) {
        throw new Error(`${backendId ?? 'default'} terminal runtime launch adapter is not configured`);
    }

    return terminalRuntimeOps.launch as (params: TParams) => Promise<TResult>;
}
